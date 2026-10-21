import { platformRepository } from '../repository/platform.repository';
import { AuditCategory, categorizeAction } from './audit.service';

/**
 * The shape of one entry in the project logs.
 */
export interface LogEvent {
  id: string;
  category: AuditCategory;
  action: string;
  summary: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  tool?: string;
  instancePublicId?: string;
  createdAt: string;
}

export interface LogPage {
  events: LogEvent[];
  nextCursor: string | null;
}

/**
 * One log event, in full.
 *
 * The list gives the row; the detail gives everything behind it — who
 * called, from where, what was touched and what the event carried.
 */
export interface LogEventDetail extends LogEvent {
  /** The kind of thing the event acted on — instance, api-key, message. */
  resource?: string;
  /** The identifier of that thing. */
  resourceId?: string;
  /** The id of the request that caused the event, when there was one. */
  requestId?: string;
  /** The caller's address. */
  ipAddress?: string;
  /** The caller's user agent. */
  userAgent?: string;
  /** Whether the action succeeded. */
  success?: boolean;
  /** The raw metadata the event was recorded with. */
  metadata?: Record<string, unknown>;
  /** Present for a message event. */
  message?: {
    type: string;
    recipient: string;
    status: string;
    sentAt?: string;
    content?: unknown;
  };
}

/** The categories the endpoint can filter on. `all` returns everything. */
export const LOG_CATEGORIES: AuditCategory[] = ['api', 'mcp', 'auth', 'message'];

export const DEFAULT_LOG_LIMIT = 50;
export const MAX_LOG_LIMIT = 200;

/**
 * Mask a phone number, keeping only the last four digits.
 * The logs are readable by anyone with access to the project, so a
 * recipient number is never shown in full.
 */
function maskRecipient(recipient: string): string {
  const digits = String(recipient ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

/** Acronyms that must stay uppercase when an action name is made readable. */
const ACRONYMS = new Set(['api', 'mcp', 'id', 'url', 'qr', 'cli']);

/** Turn "INSTANCE_CREATE" into "Instance create", keeping "API" and "MCP" intact. */
function humanize(action: string): string {
  const words = String(action ?? '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase();
      // The first word is capitalised; the rest stay lowercase.
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    });
  return words.join(' ');
}

/**
 * Is this path segment an identifier rather than a name?
 * `acct_10632c…`, `proj_9a083ec5` and bare cuids are ids.
 */
function isIdSegment(segment: string): boolean {
  return /^[a-z]+_[a-z0-9]+$/i.test(segment) || /^[0-9a-f]{16,}$/i.test(segment);
}

/**
 * The last meaningful noun in a request path — `instances`, `logs`, `mcp`.
 *
 * Identifier segments are skipped, so the label names the thing that was
 * acted on rather than the id of the thing that was acted on. This is what
 * keeps the log row from printing the same path twice: once as the summary
 * and once as the request line.
 */
function shortResource(path: string): string | null {
  const segments = String(path ?? '')
    .split('/')
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (isIdSegment(segments[i])) continue;
    return segments[i].replace(/[-_]/g, ' ');
  }
  return null;
}

/** Encode a pagination cursor: `createdAt|id`, base64url. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** Decode a pagination cursor. Returns null when it is malformed. */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = raw.indexOf('|');
    if (separator <= 0) return null;
    const createdAt = new Date(raw.slice(0, separator));
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: raw.slice(separator + 1) };
  } catch {
    return null;
  }
}

/**
 * The cursor filter: strictly older than the cursor row.
 * Ordering is (createdAt desc, id desc), so "older" means a smaller
 * createdAt, or the same createdAt with a smaller id.
 */
function cursorFilter(cursor: { createdAt: Date; id: string } | null): Record<string, unknown> | null {
  if (!cursor) return null;
  return {
    OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
  };
}

/**
 * Reads the activity log of a project.
 *
 * The audit table is the base: REST calls (`api`), MCP invocations
 * (`mcp`) and logins (`auth`) are all audit rows. Messages are NOT —
 * they live in `PlatformMessageCommand`, which knows the real delivery
 * status, so the two are merged here and sorted by time.
 */
export class LogService {
  /**
   * Read one page of the project log.
   */
  public async list(
    projectId: string,
    options: { category?: string; limit?: number; cursor?: string },
  ): Promise<LogPage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;

    const requested = (options.category ?? 'all').toLowerCase();
    const categories: AuditCategory[] =
      requested === 'all' ? LOG_CATEGORIES : LOG_CATEGORIES.filter((c) => c === requested);

    const events: LogEvent[] = [];

    if (categories.includes('api') || categories.includes('mcp') || categories.includes('auth')) {
      events.push(...(await this.readAuditEvents(projectId, categories, limit, cursor)));
    }
    if (categories.includes('message')) {
      events.push(...(await this.readMessageEvents(projectId, limit, cursor)));
    }

    events.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    });

    const hasMore = events.length > limit;
    const page = events.slice(0, limit);
    const last = page[page.length - 1];

    return {
      events: page,
      nextCursor: hasMore && last ? encodeCursor(new Date(last.createdAt), last.id) : null,
    };
  }

  /**
   * Read the audit rows of the requested categories.
   */
  private async readAuditEvents(
    projectId: string,
    categories: AuditCategory[],
    limit: number,
    cursor: { createdAt: Date; id: string } | null,
  ): Promise<LogEvent[]> {
    const actionFilters: Record<string, unknown>[] = [];

    if (categories.includes('mcp')) {
      actionFilters.push({ action: { startsWith: 'MCP_' } });
    }
    if (categories.includes('auth')) {
      actionFilters.push({ OR: [{ action: { startsWith: 'AUTH_' } }, { action: { startsWith: 'LOGIN' } }] });
    }
    if (categories.includes('api')) {
      actionFilters.push({
        AND: [
          { NOT: { action: { startsWith: 'MCP_' } } },
          { NOT: { action: { startsWith: 'AUTH_' } } },
          { NOT: { action: { startsWith: 'LOGIN' } } },
          { NOT: { action: { startsWith: 'MESSAGE_' } } },
        ],
      });
    }

    const where: Record<string, unknown> = {
      projectId,
      OR: actionFilters,
    };

    const cursorClause = cursorFilter(cursor);
    if (cursorClause) {
      where.AND = [cursorClause];
    }

    const rows = await platformRepository.platformAuditLog.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    return rows.map((row) => {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const category = (metadata.category as AuditCategory | undefined) ?? categorizeAction(row.action);

      const method = typeof metadata.method === 'string' ? metadata.method : undefined;
      const path = typeof metadata.path === 'string' ? metadata.path : undefined;
      const tool = typeof metadata.tool === 'string' ? metadata.tool : undefined;

      const event: LogEvent = {
        id: row.id,
        category,
        action: row.action,
        summary: '',
        createdAt: row.createdAt.toISOString(),
      };

      /*
       * The summary must not repeat what the row already shows.
       *
       * An API request shows its full path on the request line, so the
       * summary names the resource instead of repeating the path. An MCP
       * call shows the tool name on its own chip, so it needs no summary at
       * all. Everything else — a message, a login — is only described by
       * its summary, so it keeps the resource id.
       */
      if (path) {
        const label = shortResource(path);
        event.summary = label ? `${humanize(row.action)}: ${label}` : humanize(row.action);
      } else if (category === 'mcp') {
        event.summary = '';
      } else {
        event.summary = `${humanize(row.action)}${row.resourceId ? `: ${row.resourceId}` : ''}`;
      }

      if (method) event.method = method;
      if (path) event.path = path;
      if (typeof metadata.status === 'number') event.status = metadata.status;
      if (typeof metadata.durationMs === 'number') event.durationMs = metadata.durationMs;
      if (tool) event.tool = tool;
      if (typeof metadata.instancePublicId === 'string') {
        event.instancePublicId = metadata.instancePublicId;
      } else if (row.resource === 'instance' && row.resourceId) {
        event.instancePublicId = row.resourceId;
      }
      if (category === 'mcp' && row.resourceId) {
        event.tool = row.resourceId;
      }

      return event;
    });
  }

  /**
   * Read one event in full.
   *
   * The event is looked up inside the project, so a log id from another
   * project is simply not found — the detail of one project is not
   * readable through another.
   */
  public async get(projectId: string, eventId: string): Promise<LogEventDetail | null> {
    const row = await platformRepository.platformAuditLog.findFirst({
      where: { id: eventId, projectId },
    });

    if (row) {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const category = (metadata.category as AuditCategory | undefined) ?? categorizeAction(row.action);

      const detail: LogEventDetail = {
        id: row.id,
        category,
        action: row.action,
        summary: '',
        createdAt: row.createdAt.toISOString(),
        resource: row.resource ?? undefined,
        resourceId: row.resourceId ?? undefined,
        requestId: row.requestId ?? undefined,
        ipAddress: row.ipAddress ?? undefined,
        userAgent: row.userAgent ?? undefined,
        success: row.success,
        metadata,
      };

      if (typeof metadata.method === 'string') detail.method = metadata.method;
      if (typeof metadata.path === 'string') detail.path = metadata.path;
      if (typeof metadata.status === 'number') detail.status = metadata.status;
      if (typeof metadata.durationMs === 'number') detail.durationMs = metadata.durationMs;
      if (typeof metadata.tool === 'string') detail.tool = metadata.tool;
      if (typeof metadata.instancePublicId === 'string') {
        detail.instancePublicId = metadata.instancePublicId;
      } else if (row.resource === 'instance' && row.resourceId) {
        detail.instancePublicId = row.resourceId;
      }
      if (category === 'mcp' && row.resourceId) {
        detail.tool = row.resourceId;
      }

      if (detail.path) {
        const label = shortResource(detail.path);
        detail.summary = label ? `${humanize(row.action)}: ${label}` : humanize(row.action);
      } else if (category === 'mcp') {
        detail.summary = '';
      } else {
        detail.summary = `${humanize(row.action)}${row.resourceId ? `: ${row.resourceId}` : ''}`;
      }

      return detail;
    }

    // Not an audit row — it may be a message. The list serves both, so
    // the detail has to as well.
    const command = await platformRepository.platformMessageCommand.findFirst({
      where: { id: eventId, projectId },
    });

    if (!command) return null;

    const instance = await platformRepository.platformInstance.findFirst({
      where: { id: command.instanceId },
      select: { publicId: true },
    });

    return {
      id: command.id,
      category: 'message',
      action: 'MESSAGE_SEND',
      summary: `Message ${command.type} to ${maskRecipient(command.recipient)} (${command.status})`,
      instancePublicId: instance?.publicId,
      resource: 'message',
      resourceId: command.messageId,
      createdAt: command.createdAt.toISOString(),
      message: {
        type: command.type,
        recipient: maskRecipient(command.recipient),
        status: command.status,
        sentAt: command.sentAt?.toISOString(),
        content: command.content ?? undefined,
      },
    };
  }

  /**
   * Read the messages sent by the project's instances.
   */
  private async readMessageEvents(
    projectId: string,
    limit: number,
    cursor: { createdAt: Date; id: string } | null,
  ): Promise<LogEvent[]> {
    const where: Record<string, unknown> = { projectId };
    const cursorClause = cursorFilter(cursor);
    if (cursorClause) {
      where.AND = [cursorClause];
    }

    const commands = await platformRepository.platformMessageCommand.findMany({
      where: where as never,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        instanceId: true,
        type: true,
        recipient: true,
        status: true,
        createdAt: true,
        sentAt: true,
      },
    });

    // Resolve the public instance ids in one query.
    const instanceIds = [...new Set(commands.map((c) => c.instanceId))];
    const instances = await platformRepository.platformInstance.findMany({
      where: { id: { in: instanceIds } },
      select: { id: true, publicId: true },
    });
    const publicIdById = new Map(instances.map((i) => [i.id, i.publicId]));

    return commands.map((command) => ({
      id: command.id,
      category: 'message' as const,
      action: 'MESSAGE_SEND',
      summary: `Message ${command.type} to ${maskRecipient(command.recipient)} (${command.status})`,
      instancePublicId: publicIdById.get(command.instanceId) ?? undefined,
      createdAt: command.createdAt.toISOString(),
    }));
  }
}

export const logService = new LogService();

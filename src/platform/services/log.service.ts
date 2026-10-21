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

/** Turn "INSTANCE_CREATE" into "Instance create". */
function humanize(action: string): string {
  const text = String(action ?? '')
    .toLowerCase()
    .replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
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

      const event: LogEvent = {
        id: row.id,
        category,
        action: row.action,
        summary: `${humanize(row.action)}${row.resourceId ? `: ${row.resourceId}` : ''}`,
        createdAt: row.createdAt.toISOString(),
      };

      if (typeof metadata.method === 'string') event.method = metadata.method;
      if (typeof metadata.path === 'string') event.path = metadata.path;
      if (typeof metadata.status === 'number') event.status = metadata.status;
      if (typeof metadata.durationMs === 'number') event.durationMs = metadata.durationMs;
      if (typeof metadata.tool === 'string') event.tool = metadata.tool;
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

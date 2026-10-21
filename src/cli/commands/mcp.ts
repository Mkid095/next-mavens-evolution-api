/**
 * `viventure mcp …` — Model Context Protocol helpers.
 *
 * The platform exposes three MCP surfaces, and this command is explicit about
 * which one it is talking about:
 *
 *   1. The standard MCP transport (Streamable HTTP) at
 *      `POST|GET /api/v1/platform/mcp` — a stock MCP client speaks
 *      `initialize` → `tools/list` → `tools/call` there. This is what
 *      `viventure mcp config` prints by default.
 *   2. The stdio bridge that ships with this CLI: `viventure mcp serve`
 *      speaks MCP over stdin/stdout and forwards tool calls to the platform.
 *      Use it with clients that do not speak HTTP MCP
 *      (`viventure mcp config --stdio`).
 *   3. The lower level HTTP tool API (`POST /api/v1/platform/mcp/invoke`)
 *      — a plain REST call with `{ tool, parameters }`, answered with
 *      `{ result }` or `{ error: { code, message } }`. It is not a JSON-RPC
 *      envelope and it is not an MCP transport.
 */

import readline from 'node:readline';

import { Command } from 'commander';

import { ApiClient } from '../client';
import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { color, dim, renderTable } from '../output';

interface McpToolDefinition {
  name: string;
  category: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCategory {
  id: string;
  title?: string;
  toolCount?: number;
}

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

/** Fetch the tool catalogue from the platform (categories → tools). */
async function fetchTools(client: ApiClient): Promise<McpToolDefinition[]> {
  const categories = await client.get<{ categories: McpCategory[] }>('/platform/mcp/tools');
  const tools: McpToolDefinition[] = [];
  for (const category of categories.categories ?? []) {
    const payload = await client.get<{ tools: McpToolDefinition[] }>(`/platform/mcp/tools/${category.id}`);
    tools.push(...(payload.tools ?? []));
  }
  return tools;
}

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Model Context Protocol helpers');

  // ── mcp config ────────────────────────────────────────────────────────────
  const config = mcp
    .command('config')
    .description('Print a ready-to-paste MCP client configuration')
    .option('--stdio', 'Print the stdio bridge configuration instead of the HTTP one')
    .option('--show-key', 'Embed the real API key instead of a placeholder')
    .action(async (options: { showKey?: boolean; stdio?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const apiKey = ctx.config.apiKey;
      if (!apiKey) {
        ctx.printer.warn('No API key is configured — the configuration below uses a placeholder.');
      }

      const mcpBase = `${ctx.config.apiUrl}/platform/mcp`;
      const keyValue = options.showKey && apiKey ? apiKey : '${VIVENTURE_API_KEY}';

      // The standard MCP transport (Streamable HTTP) — a stock MCP client
      // speaks initialize → tools/list → tools/call straight to this URL.
      const httpServer = {
        type: 'http',
        url: mcpBase,
        headers: { 'X-API-Key': keyValue },
      };

      // The stdio bridge that ships with this CLI — for clients that cannot
      // speak HTTP MCP.
      const stdioServer = {
        command: 'viventure',
        args: ['mcp', 'serve'],
        env: {
          VIVENTURE_API_KEY: keyValue,
          VIVENTURE_API_URL: ctx.config.apiUrl,
        },
      };

      const payload = {
        mcpServers: {
          viventure: options.stdio ? stdioServer : httpServer,
        },
        transports: {
          streamableHttp: {
            implementedBy: 'platform',
            endpoint: mcpBase,
            methods: { jsonRpc: 'POST', notifications: 'GET' },
            note: 'The standard MCP transport. Point a stock MCP client at this URL with the X-API-Key header.',
          },
          stdioBridge: {
            implementedBy: 'this CLI',
            command: 'viventure mcp serve',
            mcpServers: { viventure: stdioServer },
            note:
              'Speaks MCP over stdin/stdout and forwards tool calls to the platform. ' +
              'Use it with clients that do not support HTTP MCP. If `viventure` is not on your PATH, ' +
              'point "command" at the CLI entry (e.g. "command": "node", "args": ["/path/to/dist/cli/index.js", "mcp", "serve"]).',
          },
          httpToolApi: {
            implementedBy: 'platform',
            note:
              'The lower level REST tool API. It is not a JSON-RPC envelope and not an MCP transport: ' +
              'you POST a tool name and its parameters and get { result } or { error: { code, message } } back.',
            endpoints: {
              categories: `${mcpBase}/tools`,
              categoryTools: `${mcpBase}/tools/{category}`,
              invoke: `${mcpBase}/invoke`,
              events: `${mcpBase}/events`,
              eventsHistory: `${mcpBase}/events/history`,
            },
          },
        },
        auth: {
          type: 'header',
          header: 'X-API-Key',
          value: keyValue,
        },
        example: {
          method: 'POST',
          url: `${mcpBase}/invoke`,
          headers: { 'Content-Type': 'application/json', 'X-API-Key': keyValue },
          body: { tool: 'list_instances', parameters: {} },
        },
      };

      ctx.printer.result(payload, () =>
        [
          JSON.stringify(payload, null, 2),
          '',
          dim(
            options.showKey
              ? 'The real API key is embedded in the configuration above — do not commit it.'
              : 'Replace ${VIVENTURE_API_KEY} with your key, or export it in the shell that launches the MCP client.',
          ),
          dim('Run `viventure mcp config --stdio` for the stdio bridge configuration.'),
        ].join('\n'),
      );
    });
  addCommonOptions(config);
  addJsonOption(config);

  // ── mcp tools ─────────────────────────────────────────────────────────────
  const tools = mcp
    .command('tools')
    .description('List the tools exposed by the platform MCP server')
    .argument('[category]', 'Only show the tools of one category')
    .action(async (category: string | undefined, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const client = ctx.client();
        const catalogue = await fetchTools(client);
        const filtered = category ? catalogue.filter((tool) => tool.category === category) : catalogue;

        ctx.printer.result(filtered, () => {
          if (!filtered.length) {
            return category ? `No tools in category "${category}".` : 'The platform exposes no tools.';
          }
          const rows = filtered.map((tool) => [tool.name, tool.category, (tool.description ?? '').slice(0, 70)]);
          return renderTable(['TOOL', 'CATEGORY', 'DESCRIPTION'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(tools);
  addJsonOption(tools);

  // ── mcp serve ─────────────────────────────────────────────────────────────
  const serve = mcp
    .command('serve')
    .description('Run the MCP stdio bridge (used by `viventure mcp config`)')
    .action(async (options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const client = ctx.client();
        await runStdioBridge(client);
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });
  addCommonOptions(serve);
}

/**
 * Minimal MCP server over stdio. The client speaks JSON-RPC 2.0, one message
 * per line; every message is answered with exactly one line of JSON.
 */
async function runStdioBridge(client: ApiClient): Promise<void> {
  const write = (payload: unknown): void => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const respond = (id: unknown, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result });
  };

  const fail = (id: unknown, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };

  process.stdin.setEncoding('utf8');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(trimmed);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case 'initialize': {
          const requested = (params as { protocolVersion?: string })?.protocolVersion;
          const version =
            requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
          respond(id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'viventure', version: '1.0.0' },
          });
          break;
        }
        case 'notifications/initialized':
        case 'initialized':
          break;
        case 'ping':
          respond(id, {});
          break;
        case 'tools/list': {
          const catalogue = await fetchTools(client);
          respond(id, {
            tools: catalogue.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            })),
          });
          break;
        }
        case 'tools/call': {
          const name = (params as { name?: string })?.name;
          const args = (params as { arguments?: Record<string, unknown> })?.arguments ?? {};
          if (!name) {
            fail(id, -32602, 'tool name is required');
            break;
          }
          const response = (await client.post<{ result?: unknown; error?: { code: number; message: string } }>(
            '/platform/mcp/invoke',
            { tool: name, parameters: args },
          )) as { result?: unknown; error?: { code: number; message: string } };

          if (response?.error) {
            respond(id, {
              content: [{ type: 'text', text: `${response.error.message} (code ${response.error.code})` }],
              isError: true,
            });
            break;
          }
          respond(id, {
            content: [{ type: 'text', text: JSON.stringify(response?.result ?? {}, null, 2) }],
            isError: false,
          });
          break;
        }
        default:
          if (!isNotification) {
            fail(id, -32601, `Method not found: ${method}`);
          }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isNotification) {
        fail(id, -32603, message);
      } else {
        process.stderr.write(`${color('viventure mcp serve:', 'red')} ${message}\n`);
      }
    }
  }
}

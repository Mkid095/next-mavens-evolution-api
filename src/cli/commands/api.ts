/**
 * `viventure api …` — the API reference, from the terminal.
 *
 * The reference is served by the platform as an OpenAPI document, so
 * this command reads the same source the documentation site and the MCP
 * tool do. What is printed here is what the platform actually exposes.
 *
 * Endpoints used:
 *   GET /api/v1/platform/openapi.json
 */

import { Command } from 'commander';

import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, dim, renderKeyValue, renderTable } from '../output';

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<
    string,
    Record<
      string,
      {
        summary: string;
        description: string;
        tags: string[];
        parameters?: unknown[];
        requestBody?: unknown;
        responses: Record<string, { description: string }>;
      }
    >
  >;
}

/** The reference, fetched from the platform. */
async function fetchReference(ctx: CliContext): Promise<OpenApiDocument> {
  // The reference is public — no key needed.
  const client = ctx.publicClient();
  return client.get<OpenApiDocument>('/platform/openapi.json');
}

export function registerApiCommand(program: Command): void {
  const api = program.command('api').description('The API reference — every endpoint the platform exposes');

  // ── api list ────────────────────────────────────────────────────────────
  const list = api
    .command('list')
    .description('List every endpoint')
    .option(
      '--group <group>',
      'Only one group: instances, messages, webhooks, api-keys, projects, logs, authentication, mcp, documentation, activity, contacts-groups, account, platform',
    )
    .option('--search <text>', 'Only the endpoints whose path or summary contains this text')
    .action(async (options: { group?: string; search?: string }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const document = await fetchReference(ctx);

        let rows: { method: string; path: string; summary: string; group: string }[] = [];
        for (const [path, operations] of Object.entries(document.paths ?? {})) {
          for (const [method, operation] of Object.entries(operations)) {
            rows.push({
              method: method.toUpperCase(),
              path,
              summary: operation.summary ?? '',
              group: operation.tags?.[0] ?? '',
            });
          }
        }

        if (options.group) {
          const wanted = options.group.toLowerCase();
          rows = rows.filter((r) => r.group.toLowerCase() === wanted || r.group.toLowerCase().includes(wanted));
        }
        if (options.search) {
          const needle = options.search.toLowerCase();
          rows = rows.filter((r) => r.path.toLowerCase().includes(needle) || r.summary.toLowerCase().includes(needle));
        }

        rows.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

        ctx.printer.result(rows, () => {
          if (!rows.length) {
            return dim('No endpoint matches.');
          }
          const table = renderTable(
            ['METHOD', 'PATH', 'GROUP', 'WHAT IT DOES'],
            rows.map((r) => [cell(r.method), cell(r.path), cell(r.group), cell(r.summary)]),
          );
          return [
            table,
            '',
            dim(`${rows.length} endpoint(s). The full reference: ${ctx.config.docsUrl}/docs`),
            dim('One endpoint in full: viventure api show GET /api/v1/messages/send'),
          ].join('\n');
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(list);
  addJsonOption(list);

  // ── api show ────────────────────────────────────────────────────────────
  const show = api
    .command('show')
    .description('Read one endpoint in full')
    .argument('<method>', 'The HTTP method, e.g. GET')
    .argument('<path>', 'The path, e.g. /api/v1/messages/send')
    .action(async (method: string, path: string, _options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const document = await fetchReference(ctx);
        const operations = document.paths?.[path];
        const operation = operations?.[method.toLowerCase()];

        if (!operation) {
          throw new Error(
            `No endpoint matches ${method.toUpperCase()} ${path}. ` + 'Run `viventure api list` to see what exists.',
          );
        }

        ctx.printer.result(operation, () => {
          const lines = [
            renderKeyValue([
              ['Endpoint', `${method.toUpperCase()} ${path}`],
              ['Group', operation.tags?.[0] ?? '—'],
              ['What it does', operation.summary ?? '—'],
            ]),
            '',
            operation.description ?? '',
          ];

          const parameters = operation.parameters as
            | { name: string; in: string; required?: boolean; description?: string }[]
            | undefined;
          if (parameters?.length) {
            lines.push('', 'Parameters:', '');
            for (const parameter of parameters) {
              lines.push(`  ${parameter.in.padEnd(6)} ${parameter.name}${parameter.required ? ' (required)' : ''}`);
              if (parameter.description) lines.push(`         ${parameter.description}`);
            }
          }

          const responses = operation.responses ?? {};
          lines.push('', 'Responses:', '');
          for (const [status, response] of Object.entries(responses)) {
            lines.push(`  ${status}  ${response.description ?? ''}`);
          }

          return lines.join('\n');
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(show);
  addJsonOption(show);
}

/**
 * `viventure projects …` — list the projects on the account.
 *
 * Endpoints used (all under /api/v1):
 *   GET /accounts/:accountId/projects
 *
 * The API key is scoped to one project, so most commands work inside
 * that project without naming it. This command is for seeing the whole
 * picture, and for finding a project id to pass elsewhere.
 */

import { Command } from 'commander';

import { ProjectDto } from '../client';
import { CliContext, toCliError } from '../context';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, renderKeyValue, renderTable } from '../output';

export function registerProjectsCommand(program: Command): void {
  const projects = program.command('projects').description('List the projects on the account');

  projects
    .command('list')
    .description('List every project on the account')
    .option('--limit <n>', 'Maximum number of projects to show')
    .action(async (options: { limit?: string; json?: boolean }, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const accountId = await ctx.accountId();
        const client = ctx.client();
        const all = await client.get<ProjectDto[]>(`/accounts/${accountId}/projects`);
        const limited = options.limit ? all.slice(0, Number(options.limit)) : all;

        ctx.printer.result(limited, () => {
          if (!limited.length) {
            return 'No projects yet — create one in the dashboard.';
          }
          const rows = limited.map((project) => [
            cell(project.id),
            cell(project.name),
            cell(project.slug),
            cell(project.status ?? 'ACTIVE'),
          ]);
          renderTable(['ID', 'NAME', 'SLUG', 'STATUS'], rows);
        });
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  projects
    .command('current')
    .description('Show the project this API key is scoped to')
    .action(async (_options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      try {
        const me = await ctx.client().me();
        ctx.printer.result(me, () =>
          renderKeyValue([
            ['Account', me.publicId],
            ['Project', me.projectId ?? '—'],
            ['Status', me.status],
            ['Plan', me.plan?.name ?? 'none'],
          ]),
        );
      } catch (error) {
        throw toCliError(error, ctx.config.apiUrl);
      }
    });

  addCommonOptions(projects);
  addJsonOption(projects);
}

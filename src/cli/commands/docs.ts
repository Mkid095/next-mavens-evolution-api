/**
 * `viventure docs …` — read the platform documentation.
 *
 * The documentation lives in the frontend app. The API serves it — the
 * index, a search, one page in full, and the whole thing as a single
 * Markdown document — and this command is a thin, scriptable front for
 * it.
 *
 *   viventure docs                     every page, grouped by section
 *   viventure docs <slug>              one page, in full, as Markdown
 *   viventure docs <text>              search the documentation
 *   viventure docs --all               the whole documentation as Markdown
 *   viventure docs --all --write FILE  write it to a file
 *
 * The page bodies are pulled from the API rather than from a snapshot,
 * so what the CLI prints is what the docs site shows. The snippets keep
 * their placeholders — the API serves the generic pages, because the
 * fetch from the docs site carries no session — and the reader fills in
 * their own ids.
 */

import { Command } from 'commander';

import { CliContext, toCliError } from '../context';
import { DOC_INDEX, DOC_INDEX_SECTIONS, DocIndexEntry } from '../docs-index';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, dim, renderTable, shorten } from '../output';

/** One page as the API returns it. */
interface DocsPage {
  id: string;
  title: string;
  description: string;
  section: { id: string; title: string };
  topics: string[];
  url: string;
  content: string | null;
  contentWarning?: string;
}

function docUrl(docsBase: string, slug: string): string {
  return `${docsBase}/docs/${slug}`;
}

function score(entry: DocIndexEntry, query: string): number {
  const q = query.toLowerCase();
  if (entry.slug.toLowerCase() === q) return 100;
  if (entry.slug.toLowerCase().includes(q)) return 60;
  if (entry.title.toLowerCase().includes(q)) return 50;
  if (entry.description.toLowerCase().includes(q)) return 30;
  if (entry.topics.some((topic) => topic.toLowerCase().includes(q))) return 20;
  return 0;
}

/**
 * Fetch one page from the API.
 *
 * The API is the source of the body — it renders the page to Markdown
 * from the same source the docs site does. The local index is only the
 * fallback, for when the API cannot be reached at all.
 */
async function fetchPage(ctx: CliContext, slug: string): Promise<DocsPage | { error: string }> {
  try {
    // The documentation is public — no key needed.
    return await ctx.publicClient().get<DocsPage>(`/platform/docs/${encodeURIComponent(slug)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description('Read the Viventure documentation')
    .argument('[query]', 'A page slug (quickstart) or text to search for (webhook)')
    .option('--all', 'Pull the whole documentation as one Markdown document')
    .option('--write <file>', 'Write the output to a file instead of stdout')
    .option('--full', 'With a search, also print the best match in full')
    .addHelpText(
      'after',
      `
Examples:
  $ viventure docs                          list every page
  $ viventure docs quickstart               print the Quickstart page as Markdown
  $ viventure docs webhook --full           search, then print the best match in full
  $ viventure docs --all                   the whole documentation as Markdown
  $ viventure docs --all --write docs.md   save it to a file
  $ viventure docs --json                  machine-readable output

The page bodies come from the API, so what you get is what the docs
site shows. The snippets keep their placeholders — fill them in with
your own ids; \`viventure config\` shows them.`,
    )
    .action(async (query: string | undefined, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const base = ctx.config.docsUrl;
      const write = typeof options.write === 'string' ? options.write : null;

      // ── The whole documentation ──────────────────────────────────────────
      if (options.all) {
        // The documentation is public — no key needed.
        const client = ctx.publicClient();
        let content: string | null = null;
        let warning: string | undefined;

        try {
          const payload = await client.get<{ content: string | null; contentWarning?: string }>(
            '/platform/docs?all=true',
          );
          content = payload?.content ?? null;
          warning = payload?.contentWarning;
        } catch (error) {
          warning = error instanceof Error ? error.message : String(error);
        }

        if (!content) {
          // The API could not be reached. The index still lists every
          // page, so the reader is never left with nothing at all.
          const index = DOC_INDEX.map((entry) => `- ${entry.title} — ${docUrl(base, entry.slug)}`).join('\n');
          throw toCliError(
            new Error(
              `Could not pull the full documentation: ${warning ?? 'unknown reason'}\n\nThe page index is still available:\n${index}`,
            ),
            ctx.config.apiUrl,
          );
        }

        if (write) {
          const fs = await import('node:fs');
          fs.writeFileSync(write, `${content}\n`, { mode: 0o644 });
          ctx.printer.result(
            { written: write, bytes: content.length },
            `Wrote the full documentation to ${write} (${content.length.toLocaleString()} characters).`,
          );
          return;
        }

        ctx.printer.result({ content }, () => content as string);
        return;
      }

      // ── No query: the index ─────────────────────────────────────────────
      if (!query) {
        const grouped = DOC_INDEX_SECTIONS.map((section) => ({
          section: section.title,
          pages: DOC_INDEX.filter((entry) => entry.section === section.id),
        }));

        ctx.printer.result(grouped, () =>
          [
            grouped
              .map((group) => {
                const rows = group.pages.map((page) => [
                  cell(page.title),
                  cell(page.slug),
                  cell(docUrl(base, page.slug)),
                ]);
                return [group.section, renderTable(['TITLE', 'SLUG', 'URL'], rows)].join('\n\n');
              })
              .join('\n\n'),
            '',
            dim('A page slug prints that page in full: viventure docs quickstart'),
            dim('Everything at once: viventure docs --all'),
          ].join('\n'),
        );
        return;
      }

      // ── A page slug: the full page ─────────────────────────────────────
      const exact = DOC_INDEX.find((entry) => entry.slug.toLowerCase() === query.toLowerCase());
      if (exact) {
        const page = await fetchPage(ctx, exact.slug);

        if ('error' in page) {
          throw toCliError(
            new Error(
              `Could not reach the API to pull "${exact.slug}": ${page.error}\n\nThe page is at ${docUrl(base, exact.slug)}`,
            ),
            ctx.config.apiUrl,
          );
        }

        if (options.json) {
          ctx.printer.result(page, () => JSON.stringify(page, null, 2));
          return;
        }

        if (page.content) {
          ctx.printer.result(page, () => {
            // The page's own Markdown already starts with its title, so
            // only the URL is added above it.
            return `${dim(page.url)}\n${page.content}\n`;
          });
          return;
        }

        // The API answered but could not render the body. The metadata is
        // still worth having, and so is the URL.
        ctx.printer.result(page, () =>
          [
            page.title,
            dim(page.url),
            '',
            page.description,
            ...(page.topics.length ? ['', dim(`Covers: ${page.topics.join(' · ')}`)] : []),
            '',
            dim(page.contentWarning ?? 'The page body could not be pulled.'),
          ].join('\n'),
        );
        return;
      }

      // ── A search ────────────────────────────────────────────────────────
      const matches = DOC_INDEX.map((entry) => ({ entry, weight: score(entry, query) }))
        .filter((match) => match.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .map((match) => match.entry);

      if (!matches.length) {
        ctx.printer.result([], () =>
          dim(`No documentation page matches "${query}". Try "viventure docs" for the full index.`),
        );
        return;
      }

      // With --full, the best match is pulled in full as well — the same
      // thing the MCP tool does, so a search is enough to get a page.
      let full: DocsPage | null = null;
      if (options.full) {
        const page = await fetchPage(ctx, matches[0].slug);
        if (!('error' in page)) full = page;
      }

      ctx.printer.result({ matches, page: full }, () => {
        const rows = matches.map((entry) => [
          cell(entry.title),
          cell(entry.section),
          cell(shorten(entry.description, 60)),
          cell(docUrl(base, entry.slug)),
        ]);
        const table = renderTable(['TITLE', 'SECTION', 'SUMMARY', 'URL'], rows);

        if (!full) {
          return [
            table,
            '',
            dim(`For the full text of one page: viventure docs ${matches[0].slug}`),
            dim('Or add --full to pull the best match as well.'),
          ].join('\n');
        }

        const body = full.content ? full.content : dim(full.contentWarning ?? 'The page body could not be pulled.');
        return [table, '', '---', '', body, ''].join('\n');
      });
    });

  addCommonOptions(docs);
  addJsonOption(docs);
}

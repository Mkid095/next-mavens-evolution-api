/**
 * `viventure docs [query]` — search the platform documentation.
 *
 * The documentation itself lives in the frontend app; this command embeds a
 * read-only snapshot of the page index (slugs, titles, descriptions and
 * section headings) so the CLI can search it without a network round-trip.
 */

import { Command } from 'commander';

import { CliContext } from '../context';
import { DOC_INDEX, DOC_INDEX_SECTIONS, DocIndexEntry } from '../docs-index';
import { addCommonOptions, addJsonOption, globalOptions } from '../options';
import { cell, dim, renderTable, shorten } from '../output';

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

export function registerDocsCommand(program: Command): void {
  const docs = program
    .command('docs')
    .description('Search the Viventure documentation')
    .argument('[query]', 'Text to search for, or a page slug')
    .action(async (query: string | undefined, options: Record<string, unknown>, command: Command) => {
      const ctx = new CliContext(globalOptions(command));
      const base = ctx.config.docsUrl;

      if (!query) {
        const grouped = DOC_INDEX_SECTIONS.map((section) => ({
          section: section.title,
          pages: DOC_INDEX.filter((entry) => entry.section === section.id),
        }));

        ctx.printer.result(grouped, () =>
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
        );
        return;
      }

      const exact = DOC_INDEX.find((entry) => entry.slug.toLowerCase() === query.toLowerCase());
      if (exact) {
        ctx.printer.result(exact, () =>
          [
            exact.title,
            dim(docUrl(base, exact.slug)),
            '',
            exact.description,
            ...(exact.topics.length ? ['', dim(`Covers: ${exact.topics.join(' · ')}`)] : []),
          ].join('\n'),
        );
        return;
      }

      const matches = DOC_INDEX.map((entry) => ({ entry, weight: score(entry, query) }))
        .filter((match) => match.weight > 0)
        .sort((a, b) => b.weight - a.weight)
        .map((match) => match.entry);

      ctx.printer.result(matches, () => {
        if (!matches.length) {
          return dim(`No documentation page matches "${query}".`);
        }
        const rows = matches.map((entry) => [
          cell(entry.title),
          cell(entry.section),
          cell(shorten(entry.description, 60)),
          cell(docUrl(base, entry.slug)),
        ]);
        return renderTable(['TITLE', 'SECTION', 'SUMMARY', 'URL'], rows);
      });
    });

  addCommonOptions(docs);
  addJsonOption(docs);
}

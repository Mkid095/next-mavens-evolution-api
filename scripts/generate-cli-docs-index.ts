/**
 * Regenerate `src/cli/docs-index.ts` from the frontend documentation source.
 *
 * The documentation pages live in the frontend app
 * (`whatsapp-nextmavens/src/lib/docsContent.ts`). The CLI embeds a read-only
 * snapshot of the page index (slugs, titles, descriptions, section headings)
 * so `viventure docs` can search them offline. The frontend repo is only
 * ever read — never modified.
 *
 * Usage:
 *   npx tsx scripts/generate-cli-docs-index.ts [path/to/docsContent.ts]
 */

import fs from 'node:fs';
import path from 'node:path';

import prettier from 'prettier';

const DEFAULT_SOURCE = '/home/whatsapp/whatsapp-nextmavens/src/lib/docsContent.ts';
const DEFAULT_TARGET = path.join(__dirname, '..', 'src', 'cli', 'docs-index.ts');

interface DocPage {
  id: string;
  sectionId: string;
  title: string;
  description: string;
  content: {
    overview: string;
    subsections?: { title: string; body: string }[];
    steps?: { title: string; body: string }[];
  };
}

interface DocSection {
  id: string;
  title: string;
  items: { id: string; title: string }[];
}

async function main(): Promise<void> {
  const source = process.argv[2] ?? DEFAULT_SOURCE;
  const target = process.argv[3] ?? DEFAULT_TARGET;

  if (!fs.existsSync(source)) {
    process.stderr.write(`Documentation source not found: ${source}\n`);
    process.exit(1);
  }

  // The frontend file is a plain TypeScript module without imports, so it can
  // be loaded directly with tsx.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { DOC_PAGES, DOC_SECTIONS } = require(source) as {
    DOC_PAGES: Record<string, DocPage>;
    DOC_SECTIONS: DocSection[];
  };

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * Embedded index of the Viventure documentation pages.');
  lines.push(' *');
  lines.push(' * Generated from the frontend documentation source');
  lines.push(' * (whatsapp-nextmavens/src/lib/docsContent.ts) by');
  lines.push(' * scripts/generate-cli-docs-index.ts. The frontend repo is NOT modified');
  lines.push(' * by the CLI — this file is a read-only snapshot of the page slugs, titles and');
  lines.push(' * descriptions so `viventure docs` can search them offline.');
  lines.push(' */');
  lines.push('export interface DocIndexEntry {');
  lines.push('  slug: string;');
  lines.push('  section: string;');
  lines.push('  title: string;');
  lines.push('  description: string;');
  lines.push('  /** Subsection and step headings — used as extra search keywords. */');
  lines.push('  topics: string[];');
  lines.push('}');
  lines.push('');
  lines.push('export interface DocIndexSection {');
  lines.push('  id: string;');
  lines.push('  title: string;');
  lines.push('}');
  lines.push('');
  lines.push('export const DOC_INDEX_SECTIONS: DocIndexSection[] = [');
  for (const section of DOC_SECTIONS) {
    lines.push(`  { id: '${section.id}', title: '${section.title.replace(/'/g, "\\'")}' },`);
  }
  lines.push('];');
  lines.push('');
  lines.push('export const DOC_INDEX: DocIndexEntry[] = [');
  for (const [slug, page] of Object.entries(DOC_PAGES)) {
    const topics = [
      ...(page.content.subsections ?? []).map((item) => item.title),
      ...(page.content.steps ?? []).map((item) => item.title),
    ];
    lines.push('  {');
    lines.push(`    slug: '${slug}',`);
    lines.push(`    section: '${page.sectionId}',`);
    lines.push(`    title: '${page.title.replace(/'/g, "\\'")}',`);
    lines.push(`    description: '${page.description.replace(/'/g, "\\'")}',`);
    lines.push(`    topics: ${JSON.stringify(topics)},`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');

  // Format with the repository's prettier config so the generated file is
  // lint-clean without a manual pass.
  const prettierConfig = await prettier.resolveConfig(target);
  const formatted = await prettier.format(lines.join('\n'), {
    ...(prettierConfig ?? {}),
    filepath: target,
    parser: 'typescript',
  });

  fs.writeFileSync(target, formatted);
  process.stdout.write(`Wrote ${Object.keys(DOC_PAGES).length} documentation pages to ${target}\n`);
}

void main();

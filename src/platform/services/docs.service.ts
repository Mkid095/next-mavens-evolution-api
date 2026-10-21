import { configService } from '@config/env.config';

import { DOC_INDEX, DOC_INDEX_SECTIONS, DocIndexEntry } from '../../cli/docs-index';

/**
 * Documentation service.
 *
 * The documentation itself lives in the frontend app (whatsapp-nextmavens).
 * The API repo keeps a read-only snapshot of the page index — slugs, titles,
 * descriptions and section headings — in `src/cli/docs-index.ts`, which is
 * also what the `viventure docs` CLI command searches.
 *
 * The *body* of a page is not snapshotted: it is fetched over HTTP from the
 * public docs site (DOCS_BASE_URL) and rendered down to markdown. When the
 * docs site cannot be reached the index entry is still returned, together
 * with a clear message, so an agent is never left without the metadata it
 * needs to find its way around the docs.
 */

/** One documentation page as returned to MCP clients. */
export interface DocsPage {
  /** Page slug (also the URL segment under /docs). */
  id: string;
  title: string;
  description: string;
  section: { id: string; title: string };
  /** Subsection headings of the page. */
  topics: string[];
  /** Canonical URL of the page on the docs site. */
  url: string;
  /** Page body rendered as markdown — null when the docs site was unreachable. */
  content: string | null;
  /** Why `content` is null, when it is null. */
  contentWarning?: string;
}

/** A search hit. */
export interface DocsSearchHit {
  id: string;
  title: string;
  description: string;
  section: { id: string; title: string };
  topics: string[];
  url: string;
  /** 0–100 relevance score. */
  score: number;
}

/** Raised when the documentation site cannot be reached. */
export class DocsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocsUnavailableError';
  }
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

/** Block-level tags that are turned into line breaks. */
const BLOCK_TAGS =
  'address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul';

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * Render a documentation page's HTML as markdown.
 *
 * This is deliberately small: the docs site renders a known, stable set of
 * elements (h1–h4, paragraphs, lists, tables and code blocks), so a targeted
 * converter is enough — and it keeps the platform free of an HTML parsing
 * dependency.
 */
export function htmlToMarkdown(input: string): string {
  const codeBlocks: { lang: string; code: string }[] = [];

  let html = input
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<button[\s\S]*?<\/button>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '');

  // 1. Pull the code blocks out first — everything else would flatten them.
  html = html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const lang = /class="[^"]*lang-([a-z0-9]+)/i.exec(inner)?.[1] ?? '';
    const code = decodeEntities(stripTags(inner)).replace(/\s+$/, '');
    codeBlocks.push({ lang, code });
    return `\n@@CODEBLOCK${codeBlocks.length - 1}@@\n`;
  });

  // 2. Headings and list items get markdown markers.
  html = html
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<\/h1>/gi, '\n')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<\/h2>/gi, '\n')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<\/h3>/gi, '\n')
    .replace(/<h4[^>]*>/gi, '\n#### ')
    .replace(/<\/h4>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<tr[^>]*>/gi, '\n| ');

  // 3. Every other block boundary becomes a line break.
  html = html.replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n');
  html = html.replace(/<br\s*\/?>/gi, '\n');

  // 4. Drop the remaining inline tags and tidy the whitespace.
  let text = decodeEntities(stripTags(html));

  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 5. Restore the code blocks as fenced blocks.
  return text.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index: string) => {
    const block = codeBlocks[Number(index)];
    if (!block) return '';
    return `\`\`\`${block.lang}\n${block.code}\n\`\`\``;
  });
}

/** Isolate the article body of a docs page. */
function extractArticle(html: string): string {
  const marker = html.indexOf('docs-article');
  if (marker === -1) return html;
  const start = html.indexOf('>', marker);
  if (start === -1) return html;
  const end = html.lastIndexOf('</article>');
  const from = start + 1;
  return end > from ? html.slice(from, end) : html.slice(from);
}

export class DocsService {
  private readonly baseUrl: string;
  private readonly timeoutMs = 10000;
  /** slug → { at, body } */
  private readonly cache = new Map<string, { at: number; body: string | null; warning?: string }>();
  private readonly cacheTtlMs = 5 * 60 * 1000;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? configService.get('PLATFORM').DOCS_BASE_URL ?? '').replace(/\/+$/, '');
  }

  /** The origin the docs are served from. */
  public getDocsBaseUrl(): string {
    return this.baseUrl;
  }

  /** URL of a documentation page. */
  public pageUrl(slug: string): string {
    return `${this.baseUrl}/docs/${slug}`;
  }

  /** Every documented page, grouped by section. */
  public listPages(): { sections: { id: string; title: string; pages: DocsSearchHit[] }[] } {
    const sections = DOC_INDEX_SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      pages: DOC_INDEX.filter((entry) => entry.section === section.id).map((entry) => this.toHit(entry, 100)),
    }));
    return { sections };
  }

  /** The index entry for a slug, if the page exists. */
  public findPage(slug: string): DocIndexEntry | undefined {
    return DOC_INDEX.find((entry) => entry.slug.toLowerCase() === slug.toLowerCase());
  }

  /**
   * Search the documentation index by slug, title, description and topics.
   * Results are ordered by relevance.
   */
  public search(query: string, limit = 10): DocsSearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];

    return DOC_INDEX.map((entry) => ({ entry, score: this.score(entry, needle) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((match) => this.toHit(match.entry, match.score));
  }

  /**
   * Fetch one documentation page.
   *
   * The index metadata is always available. The body is fetched from the docs
   * site; when that fails the page is returned with `content: null` and a
   * `contentWarning` explaining why — never an exception.
   */
  public async getPage(slug: string): Promise<DocsPage | null> {
    const entry = this.findPage(slug);
    if (!entry) return null;

    const section = DOC_INDEX_SECTIONS.find((s) => s.id === entry.section);
    const cached = this.cache.get(entry.slug);
    let body: string | null = null;
    let warning: string | undefined;

    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      body = cached.body;
      warning = cached.warning;
    } else {
      const fetched = await this.fetchBody(entry.slug);
      body = fetched.body;
      warning = fetched.warning;
      this.cache.set(entry.slug, { at: Date.now(), body, warning });
    }

    const page: DocsPage = {
      id: entry.slug,
      title: entry.title,
      description: entry.description,
      section: { id: entry.section, title: section?.title ?? entry.section },
      topics: entry.topics,
      url: this.pageUrl(entry.slug),
      content: body,
    };
    if (warning) page.contentWarning = warning;
    return page;
  }

  /**
   * Fetch the rendered body of a page from the docs site.
   * Never throws — the caller gets a warning instead.
   */
  private async fetchBody(slug: string): Promise<{ body: string | null; warning?: string }> {
    const url = this.pageUrl(slug);
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        return {
          body: null,
          warning: `The documentation site returned HTTP ${response.status} for ${url}. The page metadata above is still accurate.`,
        };
      }
      const html = await response.text();
      const markdown = htmlToMarkdown(extractArticle(html));
      if (!markdown) {
        return {
          body: null,
          warning: `The documentation site returned an empty page for ${url}. The page metadata above is still accurate.`,
        };
      }
      return { body: markdown };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        body: null,
        warning: `Could not reach the documentation site (${url}): ${reason}. The page metadata above is still accurate.`,
      };
    }
  }

  /** Score one index entry against a search term. */
  private score(entry: DocIndexEntry, needle: string): number {
    if (entry.slug.toLowerCase() === needle) return 100;
    if (entry.slug.toLowerCase().includes(needle)) return 60;
    if (entry.title.toLowerCase().includes(needle)) return 50;
    if (entry.description.toLowerCase().includes(needle)) return 30;
    if (entry.topics.some((topic) => topic.toLowerCase().includes(needle))) return 20;
    return 0;
  }

  /** Map an index entry to a search hit. */
  private toHit(entry: DocIndexEntry, score: number): DocsSearchHit {
    const section = DOC_INDEX_SECTIONS.find((s) => s.id === entry.section);
    return {
      id: entry.slug,
      title: entry.title,
      description: entry.description,
      section: { id: entry.section, title: section?.title ?? entry.section },
      topics: entry.topics,
      url: this.pageUrl(entry.slug),
      score,
    };
  }
}

export const docsService = new DocsService();

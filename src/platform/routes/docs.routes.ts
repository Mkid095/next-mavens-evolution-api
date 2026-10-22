import { Request, Response, Router } from 'express';

import { docsService } from '../services/docs.service';

const router: Router = Router();

/**
 * The platform documentation.
 *
 * GET /api/v1/platform/docs
 *
 * The index — every page, grouped by section. With `?all=true` it
 * returns the whole documentation as one Markdown document instead.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    if (String(req.query.all ?? '').toLowerCase() === 'true') {
      const { content, warning } = await docsService.getAllPages();
      if (!content) {
        res.status(503).json({ error: 'DOCS_UNAVAILABLE', message: warning });
        return;
      }
      res.json({
        docsBaseUrl: docsService.getDocsBaseUrl(),
        format: 'markdown',
        content,
      });
      return;
    }

    res.json({
      docsBaseUrl: docsService.getDocsBaseUrl(),
      ...docsService.listPages(),
    });
  } catch {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * Search the documentation.
 * GET /api/v1/platform/docs/search?q=webhook
 */
router.get('/search', async (req: Request, res: Response) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    if (!query.trim()) {
      res.status(400).json({ error: 'MISSING_QUERY', message: 'Pass ?q=<text>' });
      return;
    }

    const hits = docsService.search(query, 25);
    res.json({ query, total: hits.length, matches: hits });
  } catch {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

/**
 * One documentation page, in full.
 * GET /api/v1/platform/docs/<slug>
 *
 * The body is the page rendered to Markdown — the same Markdown the
 * "Copy page as Markdown" button on the page hands over.
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const page = await docsService.getPage(req.params.slug);
    if (!page) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: `No documentation page named "${req.params.slug}"`,
        available: docsService.listPages().sections.flatMap((s) => s.pages.map((p) => p.id)),
      });
      return;
    }
    res.json(page);
  } catch {
    res.status(500).json({ error: 'FETCH_ERROR' });
  }
});

export { router as docsRoutes };

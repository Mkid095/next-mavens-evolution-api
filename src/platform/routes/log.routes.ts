import { Request, Response, Router } from 'express';

import { hybridAuth } from '../middleware/hybrid-auth.middleware';
import { tenantResolveMiddleware } from '../middleware/tenant-resolve.middleware';
import { LOG_CATEGORIES, logService } from '../services/log.service';
import { getSessionService } from './auth.routes';
import { requireProjectContext } from './project-scope';

const router: Router = Router();

/**
 * Read the activity log of a project.
 * GET /accounts/:accountId/projects/:projectPublicId/logs
 *
 * Query:
 *   category — api | mcp | auth | message (default: all)
 *   limit    — page size (default 50, max 200)
 *   cursor   — the `nextCursor` of the previous page
 *
 * Response: { events: [...], nextCursor }
 */
router.get(
  '/:accountId/projects/:projectPublicId/logs',
  hybridAuth(getSessionService()),
  tenantResolveMiddleware.resolve,
  async (req: Request, res: Response) => {
    try {
      const context = await requireProjectContext(req, res);
      if (!context) return;

      const rawCategory = typeof req.query.category === 'string' ? req.query.category.toLowerCase() : 'all';
      if (rawCategory !== 'all' && !LOG_CATEGORIES.includes(rawCategory as never)) {
        res.status(400).json({
          error: 'INVALID_CATEGORY',
          message: `Unknown category "${rawCategory}"`,
          categories: LOG_CATEGORIES,
        });
        return;
      }

      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined;
      const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : undefined;

      const page = await logService.list(context.project.id, {
        category: rawCategory,
        limit,
        cursor,
      });

      res.json(page);
    } catch {
      res.status(500).json({ error: 'FETCH_ERROR' });
    }
  },
);

export { router as logRoutes };

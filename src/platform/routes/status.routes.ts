import { Request, Response, Router } from 'express';

import { platformStatusService } from '../services/platform-status.service';

const router: Router = Router();

/**
 * The platform's health, in one place.
 * GET /api/v1/platform/status
 *
 * Public on purpose: an uptime monitor has no credential, and nothing in
 * the answer is secret. A watchdog polls this to find out whether the
 * platform — and the WhatsApp session on it — is still working.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const status = await platformStatusService.check();
    // The endpoint answers whatever the platform's state is: a broken
    // platform must still be able to say that it is broken.
    res.status(status.state === 'down' ? 503 : 200).json(status);
  } catch (error) {
    res.status(503).json({
      state: 'down',
      problems: [error instanceof Error ? error.message : String(error)],
      checkedAt: new Date().toISOString(),
    });
  }
});

export { router as statusRoutes };

import { Request, Response, Router } from 'express';

import { buildOpenApiDocument } from '../services/openapi.service';

const router: Router = Router();

/**
 * The API reference, as an OpenAPI document.
 * GET /api/v1/platform/openapi.json
 *
 * Every endpoint the platform exposes, with its parameters, body and
 * responses. It is public, so an integrator can read it, feed it to a
 * code generator, or point a client at it without a credential.
 */
router.get('/openapi.json', (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(buildOpenApiDocument());
  } catch {
    res.status(500).json({ error: 'SPEC_ERROR' });
  }
});

export { router as openapiRoutes };

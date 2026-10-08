import { Logger } from '@config/logger.config';
import { Request, Response } from 'express';
import { createClient, RedisClientType } from 'redis';

import { PlatformSession, sessionAuthMiddleware } from '../middleware/session-auth.middleware';
import { platformRepository } from '../repository/platform.repository';
import { SessionService } from '../services/session.service';

/** Map Evolution/Baileys state → canonical PlatformInstance status */
function toCanonicalState(state: string): string {
  switch (state) {
    case 'open':
    case 'CONNECTED':
      return 'CONNECTED';
    case 'connecting':
      return 'CONNECTING';
    case 'close':
    case 'closed':
    case 'DISCONNECTED':
      return 'DISCONNECTED';
    default:
      return state?.toUpperCase() ?? 'UNKNOWN';
  }
}

/**
 * SSE endpoint for real-time instance events (QR code, connection state).
 *
 * Auth: session cookie (not X-API-Key)
 * Path: GET /platform/sse/instances/:instancePublicId/stream
 *
 * Pushes events:
 *   - qr_code      — QR code generated, includes base64 PNG
 *   - connection_state — connection state change
 *   - heartbeat    — keepalive comment (: heartbeat\n\n)
 *
 * Browser connects via EventSource to this endpoint.
 */
export function createSseRouter(sessionService: SessionService) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const router = require('express').Router();
  const logger = new Logger('SSE');

  // Allow CORS for browser access from the web console
  router.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', 'https://whatsapp.nextmavens.com');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type');
    next();
  });

  router.get(
    '/instances/:instancePublicId/stream',
    sessionAuthMiddleware(sessionService),
    async (req: Request, res: Response) => {
      const platformSession = (req as Request & { platformSession?: PlatformSession }).platformSession;
      if (!platformSession) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }

      const { instancePublicId } = req.params;

      // Resolve inst_xxx → PlatformInstance → Evolution instanceName
      const instance = await platformRepository.platformInstance.findFirst({
        where: { publicId: instancePublicId },
      });

      if (!instance) {
        res.status(404).json({ error: 'NOT_FOUND', message: 'Instance not found' });
        return;
      }

      // Tenant isolation: ensure caller owns this instance
      if (instance.accountId !== platformSession.accountId) {
        res.status(403).json({ error: 'FORBIDDEN', message: 'Access denied to this instance' });
        return;
      }

      // instance.name = Evolution instanceName used in Redis channels
      const instanceName = instance.name;

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering
      res.setHeader('Transfer-Encoding', 'chunked');
      res.flushHeaders();

      // Send initial heartbeat
      res.write(': connected\n\n');
      res.flush();

      // Keepalive interval
      const keepalive = setInterval(() => {
        res.write(': heartbeat\n\n');
        res.flush();
      }, 30000);

      let redisSubscriber: RedisClientType | null = null;
      let stopped = false;

      // Subscribe to Redis channels for this instance
      // Event names normalized: QR_UPDATED → qr.updated, CONNECTION_UPDATE → connection.update
      const qrChannel = `fidscript:whatsapp:${instanceName}.qr.updated`;
      const connChannel = `fidscript:whatsapp:${instanceName}.connection.update`;

      const redisUrl = process.env.CACHE_REDIS_URI || 'redis://platform-redis:6379/6';

      try {
        redisSubscriber = createClient({ url: redisUrl });
        await redisSubscriber.connect();

        // Subscribe to both channels
        await redisSubscriber.subscribe(qrChannel, (message: string) => {
          if (stopped) return;
          try {
            const platformEvent = JSON.parse(message) as {
              type: string;
              payload: { data: { qrcode?: { base64?: string; code?: string; pairingCode?: string } } };
            };
            // Canonical: browser receives base64 only, never raw code
            const qrData = platformEvent.payload?.data?.qrcode;
            const canonical = {
              instancePublicId,
              qrCode: qrData
                ? {
                    base64: qrData.base64 ?? null,
                    pairingCode: qrData.pairingCode ?? null,
                    // Never expose raw 'code' field to browser
                  }
                : null,
            };
            res.write(`event: qr_code\ndata: ${JSON.stringify(canonical)}\n\n`);
            res.flush();
          } catch {
            // Malformed message — skip
          }
        });

        await redisSubscriber.subscribe(connChannel, (message: string) => {
          if (stopped) return;
          try {
            const platformEvent = JSON.parse(message) as {
              payload: {
                data: {
                  state?: string;
                  wuid?: string;
                  profileName?: string;
                  profilePictureUrl?: string;
                };
              };
            };
            const data = platformEvent.payload?.data ?? {};
            const canonical = {
              instancePublicId,
              state: toCanonicalState(data.state ?? ''),
              phoneNumber: data.wuid?.replace(/:\d+$/, '') ?? null,
              profileName: data.profileName ?? null,
              profilePictureUrl: data.profilePictureUrl ?? null,
            };
            res.write(`event: connection_state\ndata: ${JSON.stringify(canonical)}\n\n`);
            res.flush();
          } catch {
            // Malformed message — skip
          }
        });

        logger.debug(`SSE subscribed to channels for instance ${instancePublicId} (${instanceName})`);
      } catch (err) {
        logger.error(`SSE Redis subscription failed: ${err}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'SSE_SETUP_FAILED' });
        }
        clearInterval(keepalive);
        return;
      }

      // Clean up on client disconnect
      req.on('close', async () => {
        stopped = true;
        clearInterval(keepalive);
        if (redisSubscriber) {
          try {
            await redisSubscriber.unsubscribe();
            await redisSubscriber.disconnect();
          } catch {
            // Ignore cleanup errors
          }
        }
        logger.debug(`SSE disconnected for instance ${instancePublicId}`);
      });
    },
  );

  return router;
}

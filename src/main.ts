// Import this first from sentry instrument!
import '@utils/instrumentSentry';

// Now import other modules
import { ProviderFiles } from '@api/provider/sessions';
import { PrismaRepository } from '@api/repository/repository.service';
import { HttpStatus, router } from '@api/routes/index.router';
import { eventManager, waMonitor } from '@api/server.module';
import {
  Auth,
  configService,
  Cors,
  HttpServer,
  ProviderSession,
  Sentry as SentryConfig,
  Webhook,
} from '@config/env.config';
import { onUnexpectedError } from '@config/error.config';
import { Logger } from '@config/logger.config';
import { ROOT_DIR } from '@config/path.config';
import * as Sentry from '@sentry/node';
import { ServerUP } from '@utils/server-up';
import axios from 'axios';
import compression from 'compression';
import cors from 'cors';
import express, { json, NextFunction, Request, Response, urlencoded } from 'express';
import { join } from 'path';

async function initWA() {
  await waMonitor.loadInstance();
}

/**
 * Give a thrown error a truthful name and a truthful status.
 *
 * The handler used to default every error that had no `error` of its
 * own to "Internal Server Error" — including the ones that were
 * entirely the client's fault. A request with a malformed JSON body
 * came back as `400 {"error":"Internal Server Error"}`, which tells a
 * developer their JSON was fine and the server broke. It was neither.
 *
 * The name is now derived from what actually went wrong: the body
 * parser's own type when there is one, the status otherwise.
 */
function shapeError(err: Error): { status: number; error: string; message: string } {
  const any = err as any;
  const status = Number(any?.status ?? any?.statusCode ?? 500) || 500;

  const rawMessage = typeof any?.message === 'string' ? any.message.trim() : '';
  const type = typeof any?.type === 'string' ? any.type : '';

  // The body parser's own errors.
  if (type === 'entity.parse.failed') {
    return {
      status,
      error: 'Malformed JSON',
      message: `The request body is not valid JSON${rawMessage ? `: ${rawMessage}` : '.'}`,
    };
  }
  if (type === 'entity.too.large') {
    return { status, error: 'Payload Too Large', message: rawMessage || 'The request body is too large.' };
  }
  if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
    return {
      status,
      error: 'Unsupported Encoding',
      message: rawMessage || 'The request body is not encoded in a supported way.',
    };
  }

  // An error that names itself.
  if (typeof any?.error === 'string' && any.error.trim()) {
    return { status, error: any.error.trim(), message: rawMessage || any.error.trim() };
  }

  // A status without a name: name it after the status.
  const named: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
  };

  return {
    status,
    error: named[status] ?? (status >= 500 ? 'Internal Server Error' : 'Request Failed'),
    message: rawMessage || named[status] || 'The request could not be handled.',
  };
}

async function bootstrap() {
  const logger = new Logger('SERVER');
  const app = express();

  let providerFiles: ProviderFiles = null;
  if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
    providerFiles = new ProviderFiles(configService);
    await providerFiles.onModuleInit();
    logger.info('Provider:Files - ON');
  }

  const prismaRepository = new PrismaRepository(configService);
  await prismaRepository.onModuleInit();

  app.use(
    cors({
      origin(requestOrigin, callback) {
        // Allow requests with no Origin header (same-origin, CLI, etc.)
        if (!requestOrigin) {
          return callback(null, true);
        }
        const { ORIGIN } = configService.get<Cors>('CORS');
        if (ORIGIN.includes('*')) {
          return callback(null, true);
        }
        if (ORIGIN.indexOf(requestOrigin) !== -1) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      methods: [...configService.get<Cors>('CORS').METHODS],
      credentials: configService.get<Cors>('CORS').CREDENTIALS,
    }),
    urlencoded({ extended: true, limit: '136mb' }),
    json({ limit: '136mb' }),
    compression(),
  );

  // Static files for API only (no dashboard)
  app.use(express.static(join(ROOT_DIR, 'public')));

  app.use('/', router);

  app.use(
    (err: Error, req: Request, res: Response, next: NextFunction) => {
      if (err) {
        const shaped = shapeError(err);
        const webhook = configService.get<Webhook>('WEBHOOK');

        if (webhook.EVENTS.ERRORS_WEBHOOK && webhook.EVENTS.ERRORS_WEBHOOK != '' && webhook.EVENTS.ERRORS) {
          const tzoffset = new Date().getTimezoneOffset() * 60000; //offset in milliseconds
          const localISOTime = new Date(Date.now() - tzoffset).toISOString();
          const now = localISOTime;
          const globalApiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;
          const serverUrl = configService.get<HttpServer>('SERVER').URL;

          const errorData = {
            event: 'error',
            data: {
              error: shaped.error,
              message: shaped.message,
              status: shaped.status,
              response: {
                message: shaped.message,
              },
            },
            date_time: now,
            api_key: globalApiKey,
            server_url: serverUrl,
          };

          logger.error(errorData);

          const baseURL = webhook.EVENTS.ERRORS_WEBHOOK;
          const httpService = axios.create({ baseURL });

          httpService.post('', errorData);
        }

        return res.status(shaped.status).json({
          status: shaped.status,
          error: shaped.error,
          response: {
            message: shaped.message,
          },
        });
      }

      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      const { method, url } = req;

      res.status(HttpStatus.NOT_FOUND).json({
        status: HttpStatus.NOT_FOUND,
        error: 'Not Found',
        response: {
          message: [`Cannot ${method.toUpperCase()} ${url}`],
        },
      });

      next();
    },
  );

  const httpServer = configService.get<HttpServer>('SERVER');

  ServerUP.app = app;
  let server = ServerUP[httpServer.TYPE];

  if (server === null) {
    logger.warn('SSL cert load failed — falling back to HTTP.');
    logger.info("Ensure 'SSL_CONF_PRIVKEY' and 'SSL_CONF_FULLCHAIN' env vars point to valid certificate files.");

    httpServer.TYPE = 'http';
    server = ServerUP[httpServer.TYPE];
  }

  await eventManager.init(server);

  const sentryConfig = configService.get<SentryConfig>('SENTRY');
  if (sentryConfig.DSN) {
    logger.info('Sentry - ON');

    // Add this after all routes,
    // but before any and other error-handling middlewares are defined
    Sentry.setupExpressErrorHandler(app);
  }

  server.listen(httpServer.PORT, () => logger.log(httpServer.TYPE.toUpperCase() + ' - ON: ' + httpServer.PORT));

  initWA().catch((error) => {
    logger.error('Error loading instances: ' + error);
  });

  onUnexpectedError();
}

bootstrap();

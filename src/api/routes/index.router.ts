import { authGuard } from '@api/guards/auth.guard';
import { instanceExistsGuard, instanceLoggedGuard } from '@api/guards/instance.guard';
import Telemetry from '@api/guards/telemetry.guard';
import { ChannelRouter } from '@api/integrations/channel/channel.router';
import { EventRouter } from '@api/integrations/event/event.router';
import { StorageRouter } from '@api/integrations/storage/storage.router';
import { prismaRepository, waMonitor } from '@api/server.module';
import { configService, Database, Facebook } from '@config/env.config';
import { fetchLatestWaWebVersion } from '@utils/fetchLatestWaWebVersion';
import { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';

import { AntiBanRouter } from './anti-ban.router';
import { AnalyticsRouter } from './analytics.router';
import { BusinessRouter } from './business.router';
import { CallRouter } from './call.router';
import { CampaignRouter } from './campaign.router';
import { ChatRouter } from './chat.router';
import { GroupRouter } from './group.router';
import { InstanceRouter } from './instance.router';
import { LabelRouter } from './label.router';
import { ProxyRouter } from './proxy.router';
import { MessageRouter } from './sendMessage.router';
import { SettingsRouter } from './settings.router';
import { TemplateRouter } from './template.router';
import { platformRouter } from '@platform/platform.router';

enum HttpStatus {
  OK = 200,
  CREATED = 201,
  NOT_FOUND = 404,
  FORBIDDEN = 403,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  INTERNAL_SERVER_ERROR = 500,
}

const router: Router = Router();
const serverConfig = configService.get('SERVER');
const databaseConfig = configService.get<Database>('DATABASE');
const guards = [instanceExistsGuard, instanceLoggedGuard, authGuard['apikey']];

const telemetry = new Telemetry();

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

// Middleware for metrics IP whitelist
const metricsIPWhitelist = (req: Request, res: Response, next: NextFunction) => {
  const metricsConfig = configService.get('METRICS');
  const allowedIPs = metricsConfig.ALLOWED_IPS?.split(',').map((ip) => ip.trim()) || ['127.0.0.1'];
  const clientIPs = [
    req.ip,
    req.connection.remoteAddress,
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
  ].filter((ip) => ip !== undefined);

  if (allowedIPs.filter((ip) => clientIPs.includes(ip)) === 0) {
    return res.status(403).send('Forbidden: IP not allowed');
  }

  next();
};

// Middleware for metrics Basic Authentication
const metricsBasicAuth = (req: Request, res: Response, next: NextFunction) => {
  const metricsConfig = configService.get('METRICS');
  const metricsUser = metricsConfig.USER;
  const metricsPass = metricsConfig.PASSWORD;

  if (!metricsUser || !metricsPass) {
    return res.status(500).send('Metrics authentication not configured');
  }

  const auth = req.get('Authorization');
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Evolution API Metrics"');
    return res.status(401).send('Authentication required');
  }

  const credentials = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = credentials.split(':');

  if (user !== metricsUser || pass !== metricsPass) {
    return res.status(401).send('Invalid credentials');
  }

  next();
};

// Expose Prometheus metrics when enabled by env flag
const metricsConfig = configService.get('METRICS');
if (metricsConfig.ENABLED) {
  const metricsMiddleware = [];

  // Add IP whitelist if configured
  if (metricsConfig.ALLOWED_IPS) {
    metricsMiddleware.push(metricsIPWhitelist);
  }

  // Add Basic Auth if required
  if (metricsConfig.AUTH_REQUIRED) {
    metricsMiddleware.push(metricsBasicAuth);
  }

  router.get('/metrics', ...metricsMiddleware, async (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');

    const escapeLabel = (value: unknown) =>
      String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');

    const lines: string[] = [];

    const clientName = databaseConfig.CONNECTION.CLIENT_NAME || 'unknown';
    const serverUrl = serverConfig.URL || '';

    // environment info
    lines.push('# HELP evolution_environment_info Environment information');
    lines.push('# TYPE evolution_environment_info gauge');
    lines.push(
      `evolution_environment_info{version="${escapeLabel(packageJson.version)}",clientName="${escapeLabel(
        clientName,
      )}",serverUrl="${escapeLabel(serverUrl)}"} 1`,
    );

    const instances = (waMonitor && waMonitor.waInstances) || {};
    const instanceEntries = Object.entries(instances);

    // total instances
    lines.push('# HELP evolution_instances_total Total number of instances');
    lines.push('# TYPE evolution_instances_total gauge');
    lines.push(`evolution_instances_total ${instanceEntries.length}`);

    // per-instance status
    lines.push('# HELP evolution_instance_up 1 if instance state is open, else 0');
    lines.push('# TYPE evolution_instance_up gauge');
    lines.push('# HELP evolution_instance_state Instance state as a labelled metric');
    lines.push('# TYPE evolution_instance_state gauge');

    for (const [name, instance] of instanceEntries) {
      const state = instance?.connectionStatus?.state || 'unknown';
      const integration = instance?.integration || '';
      const up = state === 'open' ? 1 : 0;

      lines.push(
        `evolution_instance_up{instance="${escapeLabel(name)}",integration="${escapeLabel(integration)}"} ${up}`,
      );
      lines.push(
        `evolution_instance_state{instance="${escapeLabel(name)}",integration="${escapeLabel(
          integration,
        )}",state="${escapeLabel(state)}"} 1`,
      );
    }

    res.send(lines.join('\n') + '\n');
  });
}

router
  .use((req, res, next) => telemetry.collectTelemetry(req, res, next))

  .get('/', async (req, res) => {
    res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Welcome to Next Mavens Fidscript WhatsApp API, it is working!',
      version: packageJson.version,
      clientName: databaseConfig.CONNECTION.CLIENT_NAME,
      documentation: `https://nextmavens.com/docs`,
      antiBan: {
        enabled: true,
        healthEndpoint: '/anti-ban/health',
        statusEndpoint: '/anti-ban/status',
      },
      whatsappWebVersion: (await fetchLatestWaWebVersion({})).version.join('.'),
    });
  })

  .get('/health', async (req, res) => {
    const start = Date.now();
    const checks: Record<string, { status: 'up' | 'down'; latencyMs?: number; detail?: string }> = {};

    // Database check
    try {
      const t0 = Date.now();
      await prismaRepository.$queryRaw`SELECT 1`;
      checks.database = { status: 'up', latencyMs: Date.now() - t0 };
    } catch (err) {
      checks.database = { status: 'down', detail: err instanceof Error ? err.message : String(err) };
    }

    // Cache check
    try {
      const t0 = Date.now();
      const key = `health:${Date.now()}`;
      // Access cache via the waMonitor's injected cache if available,
      // or skip if cache is not initialised
      const cache = (waMonitor as unknown as { cache?: { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown, t: number) => Promise<void> } }).cache;
      if (cache) {
        await cache.set(key, 1, 10);
        await cache.get(key);
      } else {
        checks.cache = { status: 'up', latencyMs: 0, detail: 'no cache configured' };
      }
      checks.cache = { status: 'up', latencyMs: Date.now() - t0 };
    } catch (err) {
      checks.cache = { status: 'down', detail: err instanceof Error ? err.message : String(err) };
    }

    // Instance summary
    try {
      const instances = waMonitor.waInstances || {};
      const instanceList = Object.entries(instances).map(([name, inst]) => ({
        name,
        state: (inst as { connectionStatus?: { state?: string } })?.connectionStatus?.state || 'unknown',
      }));
      const connected = instanceList.filter(i => i.state === 'open').length;
      checks.instances = { status: 'up', detail: `${connected}/${instanceList.length} connected` };
    } catch (err) {
      checks.instances = { status: 'down', detail: err instanceof Error ? err.message : String(err) };
    }

    const overall = Object.values(checks).every(c => c.status === 'up');
    res.status(overall ? HttpStatus.OK : 503).json({
      status: overall ? 'healthy' : 'degraded',
      version: packageJson.version,
      uptime: process.uptime(),
      totalLatencyMs: Date.now() - start,
      checks,
    });
  })
  .post('/verify-creds', authGuard['apikey'], async (req, res) => {
    const facebookConfig = configService.get<Facebook>('FACEBOOK');
    return res.status(HttpStatus.OK).json({
      status: HttpStatus.OK,
      message: 'Credentials are valid',
      facebookAppId: facebookConfig.APP_ID,
      facebookConfigId: facebookConfig.CONFIG_ID,
      facebookUserToken: facebookConfig.USER_TOKEN,
    });
  })
  .use('/instance', new InstanceRouter(configService, ...guards).router)
  .use('/message', new MessageRouter(...guards).router)
  .use('/call', new CallRouter(...guards).router)
  .use('/chat', new ChatRouter(...guards).router)
  .use('/business', new BusinessRouter(...guards).router)
  .use('/group', new GroupRouter(...guards).router)
  .use('/template', new TemplateRouter(configService, ...guards).router)
  .use('/settings', new SettingsRouter(...guards).router)
  .use('/proxy', new ProxyRouter(...guards).router)
  .use('/label', new LabelRouter(...guards).router)
  // Anti-Ban Routes (Next Mavens Fidscript)
  .use('/anti-ban', new AntiBanRouter(...guards).router)
  // Campaign Routes (Next Mavens Fidscript)
  .use('/campaign', new CampaignRouter(...guards).router)
  // Analytics Routes (Next Mavens Fidscript)
  .use('/analytics', new AnalyticsRouter(...guards).router)
  // Platform Routes (Phase 1 — /api/v1 public contract)
  .use('/api/v1', platformRouter)
  .use('', new ChannelRouter(configService, ...guards).router)
  .use('', new EventRouter(configService, ...guards).router)
  .use('', new StorageRouter(...guards).router);

export { HttpStatus, router };

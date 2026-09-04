import { CacheEngine } from '@cache/cacheengine';
import { configService, ProviderSession } from '@config/env.config';
import { eventEmitter } from '@config/event.config';
import { Logger } from '@config/logger.config';

import { AnalyticsController } from './controllers/analytics.controller';
import { BusinessController } from './controllers/business.controller';
import { CallController } from './controllers/call.controller';
import { CampaignController } from './controllers/campaign.controller';
import { ChatController } from './controllers/chat.controller';
import { GroupController } from './controllers/group.controller';
import { InstanceController } from './controllers/instance.controller';
import { LabelController } from './controllers/label.controller';
import { ProxyController } from './controllers/proxy.controller';
import { SendMessageController } from './controllers/sendMessage.controller';
import { SettingsController } from './controllers/settings.controller';
import { TemplateController } from './controllers/template.controller';
import { ChannelController } from './integrations/channel/channel.controller';
import { EvolutionController } from './integrations/channel/evolution/evolution.controller';
import { MetaController } from './integrations/channel/meta/meta.controller';
import { BaileysController } from './integrations/channel/whatsapp/baileys.controller';
import { EventManager } from './integrations/event/event.manager';
import { S3Controller } from './integrations/storage/s3/controllers/s3.controller';
import { S3Service } from './integrations/storage/s3/services/s3.service';
import { ProviderFiles } from './provider/sessions';
import { PrismaRepository } from './repository/repository.service';
import { AnalyticsService } from './services/analytics.service';
import { AntiBanService } from './services/anti-ban.service';
import { BlockTrackerService } from './services/block-tracker.service';
import { CacheService } from './services/cache.service';
import { CampaignService } from './services/campaign.service';
import { QualityMonitorService } from './services/quality-monitor.service';
import { RateLimiterService } from './services/rate-limiter.service';
import { WAMonitoringService } from './services/monitor.service';
import { ProxyService } from './services/proxy.service';
import { SettingsService } from './services/settings.service';
import { TemplateService } from './services/template.service';

const logger = new Logger('WA MODULE');

export const cache = new CacheService(new CacheEngine(configService, 'instance').getEngine());
const baileysCache = new CacheService(new CacheEngine(configService, 'baileys').getEngine());

let providerFiles: ProviderFiles = null;
if (configService.get<ProviderSession>('PROVIDER').ENABLED) {
  providerFiles = new ProviderFiles(configService);
}

export const prismaRepository = new PrismaRepository(configService);

export const waMonitor = new WAMonitoringService(
  eventEmitter,
  configService,
  prismaRepository,
  providerFiles,
  cache,
  baileysCache,
);

const s3Service = new S3Service(prismaRepository);
export const s3Controller = new S3Controller(s3Service);

const templateService = new TemplateService(waMonitor, prismaRepository, configService);
export const templateController = new TemplateController(templateService);

const proxyService = new ProxyService(waMonitor);
export const proxyController = new ProxyController(proxyService, waMonitor);

// Anti-Ban Services (Next Mavens Fidscript - Account Protection)
const rateLimiterService = new RateLimiterService(cache, prismaRepository, configService);
const qualityMonitorService = new QualityMonitorService(cache, prismaRepository, configService);
const blockTrackerService = new BlockTrackerService(cache, prismaRepository, configService);
export const antiBanService = new AntiBanService(
  rateLimiterService,
  qualityMonitorService,
  blockTrackerService,
  cache,
  configService,
);

// Campaign Service (Next Mavens Fidscript - Bulk Messaging)
const campaignService = new CampaignService(cache, configService);
export const campaignController = new CampaignController(campaignService, waMonitor, antiBanService);

// Analytics Service (Next Mavens Fidscript - Message Analytics)
const analyticsService = new AnalyticsService(cache, configService, prismaRepository);
export const analyticsController = new AnalyticsController(analyticsService);

// Settings Service
const settingsService = new SettingsService(waMonitor);
export const settingsController = new SettingsController(settingsService);

// Instance Controller
export const instanceController = new InstanceController(
  waMonitor,
  configService,
  prismaRepository,
  eventEmitter,
  settingsService,
  proxyController,
  cache,
  baileysCache,
  providerFiles,
);

// Message Controllers
export const sendMessageController = new SendMessageController(waMonitor, antiBanService);
export const callController = new CallController(waMonitor);
export const chatController = new ChatController(waMonitor);
export const businessController = new BusinessController(waMonitor);
export const groupController = new GroupController(waMonitor);
export const labelController = new LabelController(waMonitor);

// Event Manager
export const eventManager = new EventManager(prismaRepository, waMonitor);

// Channel Controllers
export const channelController = new ChannelController(prismaRepository, waMonitor);
export const evolutionController = new EvolutionController(prismaRepository, waMonitor);
export const metaController = new MetaController(prismaRepository, waMonitor);
export const baileysController = new BaileysController(waMonitor);

logger.info('Module - ON');

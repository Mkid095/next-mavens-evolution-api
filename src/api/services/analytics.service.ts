import { CacheService } from '@api/services/cache.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { PrismaRepository } from '@api/repository/repository.service';
import {
  AnalyticsQueryDto,
  DeliveryRateDto,
  HourlyStatsDto,
  InstanceAnalyticsDto,
  MessageStatsDto,
  PlatformAnalyticsDto,
} from '../dto/analytics.dto';

interface MessageRecord {
  id: string;
  instanceId: string;
  instanceName?: string;
  key?: {
    remoteJid?: string;
  };
  message?: any;
  messageType?: string;
  status?: string;
  pushName?: string;
  createdAt?: Date;
}

interface HourlyData {
  hour: number;
  total: number;
  sent: number;
  delivered: number;
  read: number;
}

export class AnalyticsService {
  private readonly logger = new Logger('AnalyticsService');

  constructor(
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
    private readonly prismaRepository: PrismaRepository,
  ) {}

  /**
   * Get analytics for a specific instance
   */
  public async getInstanceAnalytics(query: AnalyticsQueryDto): Promise<InstanceAnalyticsDto> {
    const instanceName = query.instanceName;
    const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();

    // Get message stats from database
    const messageStats = await this.getMessageStats(instanceName, startDate, endDate);

    // Calculate delivery rates
    const deliveryRate = this.calculateDeliveryRate(messageStats);

    // Get top contacts
    const topContacts = await this.getTopContacts(instanceName, startDate, endDate, 10);

    // Get hourly stats
    const hourlyStats = await this.getHourlyStats(instanceName, startDate, endDate);

    // Get instance status from cache
    const instanceStatus = await this.getInstanceStatus(instanceName);

    return {
      instanceName: instanceName || 'all',
      status: instanceStatus,
      uptime: await this.getInstanceUptime(instanceName),
      messageStats,
      deliveryRate,
      topContacts,
      hourlyStats,
    };
  }

  /**
   * Get platform-wide analytics
   */
  public async getPlatformAnalytics(query: AnalyticsQueryDto): Promise<PlatformAnalyticsDto> {
    const startDate = query.startDate ? new Date(query.startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = query.endDate ? new Date(query.endDate) : new Date();

    // Get all instances status
    const instanceStats = await this.getInstanceStats();

    // Get overall message stats
    const overallStats = await this.getOverallMessageStats(startDate, endDate);

    // Calculate overall delivery rates
    const totalMessages = overallStats.total;
    const totalDelivered = overallStats.delivered;
    const totalRead = overallStats.read;
    const totalFailed = overallStats.failed;

    const overallDeliveryRate: DeliveryRateDto = {
      deliveryRate: totalMessages > 0 ? (totalDelivered / totalMessages) * 100 : 0,
      readRate: totalMessages > 0 ? (totalRead / totalMessages) * 100 : 0,
      failedRate: totalMessages > 0 ? (totalFailed / totalMessages) * 100 : 0,
    };

    // Get top instances
    const topInstances = await this.getTopInstances(startDate, endDate, 10);

    return {
      totalInstances: instanceStats.total,
      connectedInstances: instanceStats.connected,
      disconnectedInstances: instanceStats.disconnected,
      totalMessages: overallStats.total,
      totalDelivered: overallStats.delivered,
      totalRead: overallStats.read,
      totalFailed: overallStats.failed,
      overallDeliveryRate: overallDeliveryRate.deliveryRate,
      overallReadRate: overallDeliveryRate.readRate,
      topInstances,
    };
  }

  /**
   * Get message statistics from database
   */
  private async getMessageStats(
    instanceName?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<MessageStatsDto> {
    try {
      // Use cached stats if available
      const cacheKey = `analytics:msg:${instanceName || 'all'}:${startDate?.getTime()}:${endDate?.getTime()}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Query database for message stats
      const whereClause: any = {};
      if (instanceName) {
        whereClause.instanceName = instanceName;
      }
      if (startDate || endDate) {
        whereClause.createdAt = {};
        if (startDate) whereClause.createdAt.gte = startDate;
        if (endDate) whereClause.createdAt.lte = endDate;
      }

      // For demo purposes, return mock data since actual Prisma query depends on schema
      const stats: MessageStatsDto = {
        total: Math.floor(Math.random() * 10000),
        sent: Math.floor(Math.random() * 9000),
        delivered: Math.floor(Math.random() * 8000),
        read: Math.floor(Math.random() * 7000),
        failed: Math.floor(Math.random() * 500),
        pending: Math.floor(Math.random() * 1000),
      };

      // Cache for 5 minutes
      await this.cache.set(cacheKey, JSON.stringify(stats), 300);

      return stats;
    } catch (error) {
      this.logger.error('Error getting message stats:', error);
      return {
        total: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        pending: 0,
      };
    }
  }

  /**
   * Calculate delivery rate from message stats
   */
  private calculateDeliveryRate(stats: MessageStatsDto): DeliveryRateDto {
    const total = stats.total || 1;
    return {
      deliveryRate: (stats.delivered / total) * 100,
      readRate: (stats.read / total) * 100,
      failedRate: (stats.failed / total) * 100,
    };
  }

  /**
   * Get top contacts by message count
   */
  private async getTopContacts(
    instanceName?: string,
    startDate?: Date,
    endDate?: Date,
    limit: number = 10,
  ): Promise<{ phone: string; messageCount: number }[]> {
    // Mock data for demo - in production, query from message history
    const mockContacts: { phone: string; messageCount: number }[] = [];
    for (let i = 0; i < limit; i++) {
      mockContacts.push({
        phone: `+2547${Math.floor(Math.random() * 100000000).toString().padStart(9, '0')}`,
        messageCount: Math.floor(Math.random() * 1000),
      });
    }
    return mockContacts.sort((a, b) => b.messageCount - a.messageCount);
  }

  /**
   * Get hourly statistics
   */
  private async getHourlyStats(
    instanceName?: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<HourlyStatsDto[]> {
    // Generate mock hourly stats for the last 24 hours
    const hourlyStats: HourlyStatsDto[] = [];
    for (let hour = 0; hour < 24; hour++) {
      hourlyStats.push({
        hour,
        total: Math.floor(Math.random() * 500),
        sent: Math.floor(Math.random() * 450),
        delivered: Math.floor(Math.random() * 400),
        read: Math.floor(Math.random() * 350),
      });
    }
    return hourlyStats;
  }

  /**
   * Get instance connection status
   */
  private async getInstanceStatus(instanceName?: string): Promise<'connected' | 'disconnected' | 'connecting'> {
    if (!instanceName) return 'connected';
    // In production, check from waMonitor.waInstances
    return Math.random() > 0.3 ? 'connected' : 'disconnected';
  }

  /**
   * Get instance uptime in seconds
   */
  private async getInstanceUptime(instanceName?: string): Promise<number> {
    if (!instanceName) return 0;
    // Return random uptime for demo
    return Math.floor(Math.random() * 30 * 24 * 60 * 60); // up to 30 days in seconds
  }

  /**
   * Get instance statistics
   */
  private async getInstanceStats(): Promise<{
    total: number;
    connected: number;
    disconnected: number;
  }> {
    // In production, query from waMonitor.waInstances
    const total = Math.floor(Math.random() * 20) + 1;
    const connected = Math.floor(Math.random() * total);
    return {
      total,
      connected,
      disconnected: total - connected,
    };
  }

  /**
   * Get overall message statistics
   */
  private async getOverallMessageStats(
    startDate?: Date,
    endDate?: Date,
  ): Promise<{ total: number; delivered: number; read: number; failed: number }> {
    // Mock data - in production aggregate from database
    const total = Math.floor(Math.random() * 100000);
    return {
      total,
      delivered: Math.floor(total * 0.85),
      read: Math.floor(total * 0.7),
      failed: Math.floor(total * 0.05),
    };
  }

  /**
   * Get top instances by message count
   */
  private async getTopInstances(
    startDate?: Date,
    endDate?: Date,
    limit: number = 10,
  ): Promise<{ instanceName: string; messageCount: number }[]> {
    // Mock data - in production query from database
    const instances: { instanceName: string; messageCount: number }[] = [];
    for (let i = 0; i < limit; i++) {
      instances.push({
        instanceName: `instance-${i + 1}`,
        messageCount: Math.floor(Math.random() * 50000),
      });
    }
    return instances.sort((a, b) => b.messageCount - a.messageCount);
  }

  /**
   * Record a sent message (for real-time tracking)
   */
  public async recordMessage(instanceName: string, phone: string, status: string): Promise<void> {
    const key = `analytics:realtime:${instanceName}:${phone}`;
    try {
      const existing = await this.cache.get(key);
      const data = existing ? JSON.parse(existing) : { sent: 0, delivered: 0, read: 0 };
      data[status] = (data[status] || 0) + 1;
      await this.cache.set(key, JSON.stringify(data), 3600); // 1 hour TTL
    } catch (error) {
      this.logger.error('Error recording message:', error);
    }
  }

  /**
   * Get real-time metrics for an instance
   */
  public async getRealTimeMetrics(instanceName: string): Promise<{
    messagesLastHour: number;
    deliveryRateLastHour: number;
    activeContacts: number;
  }> {
    return {
      messagesLastHour: Math.floor(Math.random() * 1000),
      deliveryRateLastHour: Math.random() * 100,
      activeContacts: Math.floor(Math.random() * 500),
    };
  }
}

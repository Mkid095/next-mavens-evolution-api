import { AnalyticsService } from '@api/services/analytics.service';
import { InstanceDto } from '@api/dto/instance.dto';
import { AnalyticsQueryDto } from '@api/dto/analytics.dto';
import { Logger } from '@config/logger.config';

export class AnalyticsController {
  private readonly logger = new Logger('AnalyticsController');

  constructor(private readonly analyticsService: AnalyticsService) {}

  /**
   * Get analytics for a specific instance
   */
  public async getInstanceAnalytics({ instanceName }: InstanceDto, query: AnalyticsQueryDto) {
    return this.analyticsService.getInstanceAnalytics({
      ...query,
      instanceName,
    });
  }

  /**
   * Get platform-wide analytics
   */
  public async getPlatformAnalytics(query: AnalyticsQueryDto) {
    return this.analyticsService.getPlatformAnalytics(query);
  }

  /**
   * Get real-time metrics for monitoring dashboards
   */
  public async getRealTimeMetrics({ instanceName }: InstanceDto) {
    if (!instanceName) {
      throw new Error('Instance name is required for real-time metrics');
    }
    return this.analyticsService.getRealTimeMetrics(instanceName);
  }
}

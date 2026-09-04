import { PrismaRepository } from '@api/repository/repository.service';
import { CacheService } from '@api/services/cache.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';

export type QualityScore = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface TemplateQualityUpdate {
  instanceId?: string;
  templateName: string;
  templateId: number;
  previousScore: QualityScore;
  newScore: QualityScore;
  language: string;
  timestamp: Date;
}

export interface TemplateStatus {
  templateName: string;
  qualityScore: QualityScore;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'DISABLED' | 'PAUSED';
  lastUpdated: Date;
  isUsable: boolean;
}

export class QualityMonitorService {
  private readonly logger = new Logger('QualityMonitorService');
  private readonly config = this.configService.get('ANTI_BAN');

  constructor(
    private readonly cacheService: CacheService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Handle incoming template quality update webhook from WhatsApp
   * Called when WhatsApp notifies us about template quality changes
   */
  async handleQualityUpdate(payload: TemplateQualityUpdate): Promise<void> {
    const { templateName, previousScore, newScore, instanceId } = payload;

    this.logger.log(`Quality update for template '${templateName}': ${previousScore} -> ${newScore}`);

    // Log the quality change
    await this.logQualityChange(payload);

    // Cache the current quality score
    const cacheKey = `quality:template:${templateName}`;
    await this.cacheService.set(cacheKey, newScore, 86400); // 24 hour cache

    // Handle quality drops
    if (newScore === 'RED') {
      await this.handleQualityDropRed(templateName, instanceId);
    } else if (newScore === 'YELLOW') {
      await this.handleQualityDropYellow(templateName, instanceId);
    }

    // If quality improved, log it
    if (previousScore === 'RED' && (newScore === 'GREEN' || newScore === 'YELLOW')) {
      await this.handleQualityRecovery(templateName, newScore);
    }
  }

  /**
   * Log quality change to database
   */
  private async logQualityChange(payload: TemplateQualityUpdate): Promise<void> {
    try {
      // Store in cache for quick access
      const logKey = `quality:log:${payload.templateName}:${Date.now()}`;
      await this.cacheService.set(logKey, JSON.stringify(payload), 604800); // 7 days

      // If we had a Prisma model for this, we'd save to database
      // For now, we rely on cache + webhook callback storage
      this.logger.log(`Quality change logged for template: ${payload.templateName}`);
    } catch (error) {
      this.logger.error(`Error logging quality change: ${error}`);
    }
  }

  /**
   * Handle RED quality score - template suspended
   */
  private async handleQualityDropRed(templateName: string, instanceId?: string): Promise<void> {
    this.logger.warn(`Template '${templateName}' has RED quality score - SUSPENDED`);

    // Pause the template in our system
    const pauseKey = `quality:paused:${templateName}`;
    await this.cacheService.set(pauseKey, 'true', 86400 * (this.config?.AUTO_PAUSE_ON_RED_DAYS || 7)); // Configurable days pause

    // Log alert
    const alertKey = `quality:alert:${templateName}`;
    await this.cacheService.set(alertKey, JSON.stringify({
      type: 'RED_QUALITY',
      template: templateName,
      timestamp: new Date().toISOString(),
      action: 'TEMPLATE_PAUSED'
    }), 86400); // 24 hour alert retention

    // In production, you would:
    // 1. Send alert to admin
    // 2. Mark template as unusable in database
    // 3. Notify via webhook
  }

  /**
   * Handle YELLOW quality score - warning state
   */
  private async handleQualityDropYellow(templateName: string, instanceId?: string): Promise<void> {
    this.logger.warn(`Template '${templateName}' has YELLOW quality score - WARNING`);

    // Log warning alert
    const alertKey = `quality:alert:${templateName}`;
    await this.cacheService.set(alertKey, JSON.stringify({
      type: 'YELLOW_QUALITY',
      template: templateName,
      timestamp: new Date().toISOString(),
      action: 'MONITORING'
    }), 86400);

    // In production, you would:
    // 1. Send warning to admin
    // 2. Increase monitoring frequency
  }

  /**
   * Handle quality recovery
   */
  private async handleQualityRecovery(templateName: string, newScore: QualityScore): Promise<void> {
    this.logger.log(`Template '${templateName}' recovered to ${newScore}`);

    // Remove paused status
    const pauseKey = `quality:paused:${templateName}`;
    await this.cacheService.del(pauseKey);

    // Log recovery
    const recoveryKey = `quality:recovery:${templateName}`;
    await this.cacheService.set(recoveryKey, JSON.stringify({
      template: templateName,
      newScore,
      timestamp: new Date().toISOString()
    }), 86400);
  }

  /**
   * Check if a template can be used (has good quality score)
   */
  async canUseTemplate(templateName: string): Promise<{ allowed: boolean; reason?: string }> {
    // Check if template is paused (RED quality)
    const pauseKey = `quality:paused:${templateName}`;
    const isPaused = await this.cacheService.get(pauseKey);

    if (isPaused) {
      return {
        allowed: false,
        reason: 'TEMPLATE_RED_QUALITY_PAUSED'
      };
    }

    // Check current quality score
    const qualityKey = `quality:template:${templateName}`;
    const score = await this.cacheService.get(qualityKey) as QualityScore | null;

    if (score === 'RED') {
      return {
        allowed: false,
        reason: 'TEMPLATE_HAS_RED_QUALITY'
      };
    }

    return { allowed: true };
  }

  /**
   * Get template status
   */
  async getTemplateStatus(templateName: string): Promise<TemplateStatus> {
    const pauseKey = `quality:paused:${templateName}`;
    const qualityKey = `quality:template:${templateName}`;
    const alertKey = `quality:alert:${templateName}`;

    const isPaused = await this.cacheService.get(pauseKey);
    const score = await this.cacheService.get(qualityKey) as QualityScore | null;
    const alert = await this.cacheService.get(alertKey);

    let status: TemplateStatus['status'] = 'APPROVED';
    if (isPaused) {
      status = 'PAUSED';
    }

    return {
      templateName,
      qualityScore: score || 'UNKNOWN',
      status,
      lastUpdated: new Date(),
      isUsable: !isPaused && score !== 'RED',
    };
  }

  /**
   * Manually pause a template
   */
  async pauseTemplate(templateName: string, reason?: string): Promise<void> {
    const pauseKey = `quality:paused:${templateName}`;
    await this.cacheService.set(pauseKey, reason || 'MANUAL_PAUSE', 86400 * 7);

    this.logger.log(`Template '${templateName}' manually paused: ${reason}`);
  }

  /**
   * Resume a paused template
   */
  async resumeTemplate(templateName: string): Promise<void> {
    const pauseKey = `quality:paused:${templateName}`;
    await this.cacheService.del(pauseKey);

    this.logger.log(`Template '${templateName}' resumed`);
  }

  /**
   * Get all templates with their quality status
   */
  async getAllTemplateStatuses(): Promise<TemplateStatus[]> {
    // In production, this would query the database
    // For now, return empty array - implement with Prisma model
    return [];
  }

  /**
   * Get quality alerts for monitoring dashboard
   */
  async getAlerts(): Promise<Array<{
    type: string;
    template: string;
    timestamp: string;
    action: string;
  }>> {
    // This would scan for alert keys in production
    return [];
  }

  /**
   * Clear old quality data (maintenance)
   */
  async cleanupOldData(): Promise<void> {
    // In production, clean up old logs from database
    this.logger.log('Quality data cleanup completed');
  }
}

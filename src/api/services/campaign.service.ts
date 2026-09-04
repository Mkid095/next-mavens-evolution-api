import { CacheService } from '@api/services/cache.service';
import { ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, NotFoundException } from '@exceptions';
import { v4 } from 'uuid';

import {
  CampaignMessage,
  CampaignRecipient,
  CampaignStatusDto,
  CreateCampaignDto,
  SendCampaignDto,
  ScheduleCampaignDto,
} from '../dto/campaign.dto';

interface Campaign {
  id: string;
  name: string;
  instanceName: string;
  description?: string;
  message: CampaignMessage;
  recipients: CampaignRecipient[];
  status: 'pending' | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'paused';
  totalRecipients: number;
  sent: number;
  failed: number;
  pending: number;
  maxPerMinute: number;
  scheduledAt?: Date;
  startTime?: Date;
  endTime?: Date;
  nextSendTime?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class CampaignService {
  private readonly logger = new Logger('CampaignService');
  private readonly campaigns: Map<string, Campaign> = new Map();
  private readonly campaignTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(
    private readonly cache: CacheService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Create a new campaign (metadata only, no sending)
   */
  public async createCampaign(data: CreateCampaignDto): Promise<Campaign> {
    const campaign: Campaign = {
      id: v4(),
      name: data.name,
      instanceName: data.instanceName,
      description: data.description,
      message: {} as CampaignMessage,
      recipients: [],
      status: 'pending',
      totalRecipients: 0,
      sent: 0,
      failed: 0,
      pending: 0,
      maxPerMinute: 60,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.campaigns.set(campaign.id, campaign);
    this.logger.log(`Campaign created: ${campaign.id} - ${campaign.name}`);

    return campaign;
  }

  /**
   * Schedule a campaign for future sending
   */
  public async scheduleCampaign(data: ScheduleCampaignDto): Promise<Campaign> {
    const campaign: Campaign = {
      id: v4(),
      name: data.name,
      instanceName: data.instanceName,
      description: data.description,
      message: data.message,
      recipients: data.recipients,
      status: 'scheduled',
      totalRecipients: data.recipients.length,
      sent: 0,
      failed: 0,
      pending: data.recipients.length,
      maxPerMinute: data.maxPerMinute || 60,
      scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (campaign.scheduledAt && campaign.scheduledAt <= new Date()) {
      throw new BadRequestException('Scheduled time must be in the future');
    }

    this.campaigns.set(campaign.id, campaign);
    this.logger.log(`Campaign scheduled: ${campaign.id} - ${campaign.name} for ${campaign.scheduledAt}`);

    // Set timer for scheduled execution
    if (campaign.scheduledAt) {
      const delay = campaign.scheduledAt.getTime() - Date.now();
      const timer = setTimeout(() => this.executeCampaign(campaign.id), delay);
      this.campaignTimers.set(campaign.id, timer);
    }

    return campaign;
  }

  /**
   * Send a campaign immediately (or resume a paused campaign)
   */
  public async sendCampaign(data: SendCampaignDto): Promise<Campaign> {
    const campaign: Campaign = {
      id: v4(),
      name: data.name,
      instanceName: data.instanceName,
      description: data.description,
      message: data.message,
      recipients: data.recipients,
      status: 'running',
      totalRecipients: data.recipients.length,
      sent: 0,
      failed: 0,
      pending: data.recipients.length,
      maxPerMinute: data.maxPerMinute || 60,
      startTime: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.campaigns.set(campaign.id, campaign);
    this.logger.log(`Campaign started: ${campaign.id} - ${campaign.name}`);

    // Start campaign execution in background
    this.executeCampaign(campaign.id);

    return campaign;
  }

  /**
   * Execute campaign sending with rate limiting
   */
  private async executeCampaign(campaignId: string): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.status === 'cancelled') {
      this.logger.log(`Campaign ${campaignId} was cancelled, skipping execution`);
      return;
    }

    campaign.status = 'running';
    campaign.startTime = campaign.startTime || new Date();
    campaign.nextSendTime = new Date();

    const delayBetweenMessages = Math.ceil(60000 / campaign.maxPerMinute); // milliseconds between messages
    const batchSize = Math.min(10, campaign.maxPerMinute); // Process in small batches

    for (let i = 0; i < campaign.recipients.length && campaign.status !== 'cancelled'; i += batchSize) {
      if (campaign.status === 'paused') {
        // Wait until resumed or cancelled
        await this.waitForResume(campaignId);
        if (campaign.status === 'cancelled') break;
      }

      const batch = campaign.recipients.slice(i, i + batchSize);

      for (const recipient of batch) {
        if (campaign.status === 'cancelled') break;

        try {
          // The actual sending would be handled by the controller
          // Here we just track the status
          campaign.sent++;
          campaign.pending--;
          campaign.nextSendTime = new Date(Date.now() + delayBetweenMessages);
        } catch (error) {
          campaign.failed++;
          campaign.pending--;
          this.logger.error(`Failed to send to ${recipient.phone}:`, error);
        }

        // Rate limiting delay
        await this.delay(delayBetweenMessages);
      }
    }

    campaign.endTime = new Date();
    campaign.status = campaign.status === 'paused' ? 'paused' : 'completed';
    campaign.updatedAt = new Date();

    this.logger.log(`Campaign ${campaignId} completed. Sent: ${campaign.sent}, Failed: ${campaign.failed}`);
  }

  private waitForResume(campaignId: string): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const campaign = this.campaigns.get(campaignId);
        if (!campaign || campaign.status !== 'paused') {
          clearInterval(checkInterval);
          resolve();
        }
      }, 1000);
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Pause a running campaign
   */
  public async pauseCampaign(campaignId: string): Promise<Campaign> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.status !== 'running') {
      throw new BadRequestException('Only running campaigns can be paused');
    }

    campaign.status = 'paused';
    campaign.updatedAt = new Date();

    this.logger.log(`Campaign paused: ${campaignId}`);
    return campaign;
  }

  /**
   * Resume a paused campaign
   */
  public async resumeCampaign(campaignId: string): Promise<Campaign> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.status !== 'paused') {
      throw new BadRequestException('Only paused campaigns can be resumed');
    }

    campaign.status = 'running';
    campaign.updatedAt = new Date();

    // Resume execution
    this.executeCampaign(campaignId);

    this.logger.log(`Campaign resumed: ${campaignId}`);
    return campaign;
  }

  /**
   * Cancel a campaign
   */
  public async cancelCampaign(campaignId: string): Promise<Campaign> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      throw new BadRequestException('Campaign cannot be cancelled');
    }

    campaign.status = 'cancelled';
    campaign.endTime = new Date();
    campaign.updatedAt = new Date();

    // Clear any pending timers
    const timer = this.campaignTimers.get(campaignId);
    if (timer) {
      clearTimeout(timer);
      this.campaignTimers.delete(campaignId);
    }

    this.logger.log(`Campaign cancelled: ${campaignId}`);
    return campaign;
  }

  /**
   * Get campaign status
   */
  public async getCampaignStatus(campaignId: string): Promise<CampaignStatusDto> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    return {
      campaignId: campaign.id,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
      sent: campaign.sent,
      failed: campaign.failed,
      pending: campaign.pending,
      startTime: campaign.startTime?.toISOString(),
      endTime: campaign.endTime?.toISOString(),
      nextSendTime: campaign.nextSendTime?.toISOString(),
    };
  }

  /**
   * List all campaigns
   */
  public async listCampaigns(instanceName?: string): Promise<Campaign[]> {
    const allCampaigns = Array.from(this.campaigns.values());

    if (instanceName) {
      return allCampaigns.filter((c) => c.instanceName === instanceName);
    }

    return allCampaigns.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Delete a campaign
   */
  public async deleteCampaign(campaignId: string): Promise<void> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    if (campaign.status === 'running') {
      throw new BadRequestException('Cannot delete a running campaign. Cancel it first.');
    }

    // Clear any pending timers
    const timer = this.campaignTimers.get(campaignId);
    if (timer) {
      clearTimeout(timer);
      this.campaignTimers.delete(campaignId);
    }

    this.campaigns.delete(campaignId);
    this.logger.log(`Campaign deleted: ${campaignId}`);
  }
}

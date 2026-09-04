import { AntiBanService } from '@api/services/anti-ban.service';
import { CampaignService } from '@api/services/campaign.service';
import { InstanceDto } from '@api/dto/instance.dto';
import {
  CreateCampaignDto,
  SendCampaignDto,
  ScheduleCampaignDto,
} from '@api/dto/campaign.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { BadRequestException } from '@exceptions';
import { Logger } from '@config/logger.config';

export class CampaignController {
  private readonly logger = new Logger('CampaignController');

  constructor(
    private readonly campaignService: CampaignService,
    private readonly waMonitor: WAMonitoringService,
    private readonly antiBanService: AntiBanService,
  ) {}

  /**
   * Create a new campaign (metadata only)
   */
  public async createCampaign({ instanceName }: InstanceDto, data: CreateCampaignDto) {
    // Verify instance exists
    if (!this.waMonitor.waInstances[instanceName]) {
      throw new BadRequestException(`Instance ${instanceName} not found`);
    }

    return this.campaignService.createCampaign({
      ...data,
      instanceName,
    });
  }

  /**
   * Schedule a campaign for future sending
   */
  public async scheduleCampaign({ instanceName }: InstanceDto, data: ScheduleCampaignDto) {
    // Verify instance exists
    if (!this.waMonitor.waInstances[instanceName]) {
      throw new BadRequestException(`Instance ${instanceName} not found`);
    }

    return this.campaignService.scheduleCampaign({
      ...data,
      instanceName,
    });
  }

  /**
   * Send a campaign immediately with anti-ban protection
   */
  public async sendCampaign({ instanceName }: InstanceDto, data: SendCampaignDto) {
    // Verify instance exists
    if (!this.waMonitor.waInstances[instanceName]) {
      throw new BadRequestException(`Instance ${instanceName} not found`);
    }

    // Process each recipient with anti-ban checks
    const results = {
      sent: 0,
      failed: 0,
      pending: data.recipients.length,
      blocked: 0,
      rateLimited: 0,
    };

    for (const recipient of data.recipients) {
      try {
        // ANTI-BAN CHECK: Verify can send to this contact
        const canSend = await this.antiBanService.canSendMessage(instanceName, recipient.phone);

        if (!canSend.allowed) {
          this.logger.warn(`Campaign blocked for ${recipient.phone}: ${canSend.reason}`);
          results.blocked++;
          results.pending--;
          continue;
        }

        const messageData = this.prepareMessageWithVariables(data.message, recipient.variables);

        switch (data.message.type) {
          case 'text':
            await this.waMonitor.waInstances[instanceName].textMessage({
              number: recipient.phone,
              ...messageData,
            });
            break;
          case 'media':
            await this.waMonitor.waInstances[instanceName].mediaMessage({
              number: recipient.phone,
              mediatype: data.message.mediaType || 'image',
              media: data.message.mediaUrl,
              caption: data.message.mediaCaption,
              ...messageData,
            });
            break;
          case 'template':
            await this.waMonitor.waInstances[instanceName].templateMessage({
              number: recipient.phone,
              name: data.message.templateName,
              language: data.message.templateLanguage || 'en',
              components: data.message.templateComponents,
            });
            break;
          case 'interactive':
            await this.waMonitor.waInstances[instanceName].interactiveButtonsMessage({
              number: recipient.phone,
              ...messageData,
            });
            break;
        }

        // ANTI-BAN: Record successful send
        await this.antiBanService.recordSend(instanceName, recipient.phone);

        results.sent++;
        results.pending--;

        // Rate limiting delay (60 messages per minute to avoid triggering limits)
        await this.delay(1000);
      } catch (error: any) {
        results.failed++;
        results.pending--;

        // Check if this was a block error
        if (error.message?.includes('blocked') || error.message?.includes('403')) {
          await this.antiBanService.recordDeliveryFailure(instanceName, recipient.phone, 'BLOCKED');
          results.blocked++;
        }

        this.logger.error(`Failed to send to ${recipient.phone}:`, error);
      }
    }

    return {
      campaignId: 'immediate-' + Date.now(),
      status: 'completed',
      ...results,
    };
  }

  private prepareMessageWithVariables(
    message: SendCampaignDto['message'],
    variables?: Record<string, string>,
  ): any {
    if (!variables) return {};

    const result: any = {};

    if (message.text) {
      let text = message.text;
      for (const [key, value] of Object.entries(variables)) {
        text = text.replace(new RegExp(`{{${key}}}`, 'g'), value);
      }
      result.text = text;
    }

    if (message.mediaCaption) {
      let caption = message.mediaCaption;
      for (const [key, value] of Object.entries(variables)) {
        caption = caption.replace(new RegExp(`{{${key}}}`, 'g'), value);
      }
      result.caption = caption;
    }

    return result;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get campaign status
   */
  public async getCampaignStatus(campaignId: string) {
    return this.campaignService.getCampaignStatus(campaignId);
  }

  /**
   * List all campaigns
   */
  public async listCampaigns({ instanceName }: InstanceDto) {
    return this.campaignService.listCampaigns(instanceName);
  }

  /**
   * Pause a campaign
   */
  public async pauseCampaign(campaignId: string) {
    return this.campaignService.pauseCampaign(campaignId);
  }

  /**
   * Resume a campaign
   */
  public async resumeCampaign(campaignId: string) {
    return this.campaignService.resumeCampaign(campaignId);
  }

  /**
   * Cancel a campaign
   */
  public async cancelCampaign(campaignId: string) {
    return this.campaignService.cancelCampaign(campaignId);
  }

  /**
   * Delete a campaign
   */
  public async deleteCampaign(campaignId: string) {
    return this.campaignService.deleteCampaign(campaignId);
  }
}

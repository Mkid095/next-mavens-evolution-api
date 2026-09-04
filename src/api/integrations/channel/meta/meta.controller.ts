import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Logger } from '@config/logger.config';
import axios from 'axios';

import { ChannelController, ChannelControllerInterface } from '../channel.controller';
import { antiBanService } from '@api/server.module';

export class MetaController extends ChannelController implements ChannelControllerInterface {
  private readonly logger = new Logger('MetaController');

  constructor(prismaRepository: PrismaRepository, waMonitor: WAMonitoringService) {
    super(prismaRepository, waMonitor);
  }

  integrationEnabled: boolean;

  public async receiveWebhook(data: any) {
    if (data.object === 'whatsapp_business_account') {
      // Handle template status update webhook
      if (data.entry[0]?.changes[0]?.field === 'message_template_status_update') {
        const templateStatusData = data.entry[0].changes[0].value;

        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${templateStatusData.message_template_id}` },
        });

        if (!template) {
          console.log('template not found');
          return;
        }

        // Forward to configured webhook URL
        const { webhookUrl } = template;

        await axios.post(webhookUrl, templateStatusData, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
        return;
      }

      // Handle template quality update webhook (Next Mavens Fidscript Anti-Ban)
      if (data.entry[0]?.changes[0]?.field === 'message_template_quality_update') {
        const qualityData = data.entry[0].changes[0].value;

        this.logger.log(`Received template quality update: ${JSON.stringify(qualityData)}`);

        // Process quality update through Anti-Ban service
        try {
          await antiBanService.handleQualityWebhook({
            templateName: qualityData.message_template_name,
            previousScore: qualityData.previous_quality_score,
            newScore: qualityData.new_quality_score,
            templateId: qualityData.message_template_id,
            language: qualityData.message_template_language,
          });
        } catch (error) {
          this.logger.error(`Error processing quality update: ${error}`);
        }

        // Also forward to configured webhook URL if exists
        const template = await this.prismaRepository.template.findFirst({
          where: { templateId: `${qualityData.message_template_id}` },
        });

        if (template?.webhookUrl) {
          await axios.post(template.webhookUrl, qualityData, {
            headers: {
              'Content-Type': 'application/json',
            },
          });
        }

        return;
      }

      // Handle phone number quality update
      if (data.entry[0]?.changes[0]?.field === 'phone_number_quality_update') {
        const phoneQualityData = data.entry[0].changes[0].value;

        this.logger.log(`Received phone number quality update: ${JSON.stringify(phoneQualityData)}`);

        // Log for monitoring (could trigger alerts if needed)
        if (phoneQualityData.quality_score === 'RED') {
          this.logger.warn(`Phone number ${data.entry[0].id} has RED quality score`);
        }

        return;
      }

      // Handle account status update
      if (data.entry[0]?.changes[0]?.field === 'account_update') {
        const accountData = data.entry[0].changes[0].value;

        if (accountData.event === 'DISABLED_UPDATE') {
          this.logger.error(`Account has been DISABLED: ${JSON.stringify(accountData.ban_info)}`);
        }

        return;
      }

      data.entry?.forEach(async (entry: any) => {
        const numberId = entry.changes[0].value.metadata.phone_number_id;

        if (!numberId) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> numberId not found');
          return {
            status: 'success',
          };
        }

        const instance = await this.prismaRepository.instance.findFirst({
          where: { number: numberId },
        });

        if (!instance) {
          this.logger.error('WebhookService -> receiveWebhookMeta -> instance not found');
          return {
            status: 'success',
          };
        }

        await this.waMonitor.waInstances[instance.name].connectToWhatsapp(data);

        return {
          status: 'success',
        };
      });
    }

    return {
      status: 'success',
    };
  }
}

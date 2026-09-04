import { Metadata } from '@api/dto/sendMessage.dto';

/**
 * Campaign DTO - For bulk message campaigns
 */
export class CreateCampaignDto {
  name: string;
  instanceName: string;
  description?: string;
}

export class CampaignRecipient {
  phone: string;
  variables?: Record<string, string>;
}

export class CampaignMessage {
  type: 'text' | 'media' | 'template' | 'interactive';
  text?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video' | 'document';
  mediaCaption?: string;
  templateName?: string;
  templateLanguage?: string;
  templateComponents?: any;
  interactiveButtons?: any;
}

export class ScheduleCampaignDto extends Metadata {
  name: string;
  instanceName: string;
  description?: string;
  message: CampaignMessage;
  recipients: CampaignRecipient[];
  scheduledAt?: string; // ISO date string
  maxPerMinute?: number;
}

export class SendCampaignDto extends Metadata {
  name: string;
  instanceName: string;
  description?: string;
  message: CampaignMessage;
  recipients: CampaignRecipient[];
  maxPerMinute?: number;
}

export class CampaignStatusDto {
  campaignId: string;
  status: 'pending' | 'scheduled' | 'running' | 'completed' | 'cancelled' | 'paused';
  totalRecipients: number;
  sent: number;
  failed: number;
  pending: number;
  startTime?: string;
  endTime?: string;
  nextSendTime?: string;
}

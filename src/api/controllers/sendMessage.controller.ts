import { AntiBanService } from '@api/services/anti-ban.service';
import { InstanceDto } from '@api/dto/instance.dto';
import {
  SendAudioDto,
  SendButtonsDto,
  SendContactDto,
  SendInteractiveButtonsDto,
  SendListDto,
  SendLocationDto,
  SendMediaDto,
  SendPollDto,
  SendProductCarouselDto,
  SendProductDto,
  SendPtvDto,
  SendReactionDto,
  SendStatusDto,
  SendStickerDto,
  SendTemplateDto,
  SendTextDto,
  SendFlowDto,
} from '@api/dto/sendMessage.dto';
import { WAMonitoringService } from '@api/services/monitor.service';
import { BadRequestException } from '@exceptions';
import { Logger } from '@config/logger.config';
import { isBase64, isURL } from 'class-validator';
import emojiRegex from 'emoji-regex';

const regex = emojiRegex();

function isEmoji(str: string) {
  if (str === '') return true;

  const match = str.match(regex);
  return match?.length === 1 && match[0] === str;
}

export class SendMessageController {
  private readonly logger = new Logger('SendMessageController');

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly antiBanService: AntiBanService,
  ) {}

  public async sendTemplate({ instanceName }: InstanceDto, data: SendTemplateDto) {
    // Check anti-ban for template messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber, data.name);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].templateMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendText({ instanceName }: InstanceDto, data: SendTextDto) {
    // Check anti-ban for text messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].textMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendMedia({ instanceName }: InstanceDto, data: SendMediaDto, file?: any) {
    if (isBase64(data?.media) && !data?.fileName && data?.mediatype === 'document') {
      throw new BadRequestException('For base64 the file name must be informed.');
    }

    if (file || isURL(data?.media) || isBase64(data?.media)) {
      // Check anti-ban for media messages
      const phoneNumber = data.number;
      const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

      if (!canSend.allowed) {
        throw new BadRequestException(canSend.reason);
      }

      const result = await this.waMonitor.waInstances[instanceName].mediaMessage(data, file);

      // Record successful send
      await this.antiBanService.recordSend(instanceName, phoneNumber);

      return result;
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendPtv({ instanceName }: InstanceDto, data: SendPtvDto, file?: any) {
    if (file || isURL(data?.video) || isBase64(data?.video)) {
      // Check anti-ban for video messages
      const phoneNumber = data.number;
      const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

      if (!canSend.allowed) {
        throw new BadRequestException(canSend.reason);
      }

      const result = await this.waMonitor.waInstances[instanceName].ptvMessage(data, file);

      // Record successful send
      await this.antiBanService.recordSend(instanceName, phoneNumber);

      return result;
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendSticker({ instanceName }: InstanceDto, data: SendStickerDto, file?: any) {
    if (file || isURL(data.sticker) || isBase64(data.sticker)) {
      // Check anti-ban for sticker messages
      const phoneNumber = data.number;
      const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

      if (!canSend.allowed) {
        throw new BadRequestException(canSend.reason);
      }

      const result = await this.waMonitor.waInstances[instanceName].mediaSticker(data, file);

      // Record successful send
      await this.antiBanService.recordSend(instanceName, phoneNumber);

      return result;
    }
    throw new BadRequestException('Owned media must be a url or base64');
  }

  public async sendWhatsAppAudio({ instanceName }: InstanceDto, data: SendAudioDto, file?: any) {
    if (file?.buffer || isURL(data.audio) || isBase64(data.audio)) {
      // Check anti-ban for audio messages
      const phoneNumber = data.number;
      const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

      if (!canSend.allowed) {
        throw new BadRequestException(canSend.reason);
      }

      const result = await this.waMonitor.waInstances[instanceName].audioWhatsapp(data, file);

      // Record successful send
      await this.antiBanService.recordSend(instanceName, phoneNumber);

      return result;
    } else {
      console.error('El archivo no tiene buffer o el audio no es una URL o Base64 válida');
      throw new BadRequestException('Owned media must be a url, base64, or valid file with buffer');
    }
  }

  public async sendButtons({ instanceName }: InstanceDto, data: SendButtonsDto) {
    // Check anti-ban for button messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].buttonMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendLocation({ instanceName }: InstanceDto, data: SendLocationDto) {
    // Check anti-ban for location messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].locationMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendList({ instanceName }: InstanceDto, data: SendListDto) {
    // Check anti-ban for list messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].listMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendContact({ instanceName }: InstanceDto, data: SendContactDto) {
    // Check anti-ban for contact messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].contactMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendReaction({ instanceName }: InstanceDto, data: SendReactionDto) {
    // Reactions don't count towards rate limits - no anti-ban check needed
    if (!isEmoji(data.reaction)) {
      throw new BadRequestException('Reaction must be a single emoji or empty string');
    }
    return await this.waMonitor.waInstances[instanceName].reactionMessage(data);
  }

  public async sendPoll({ instanceName }: InstanceDto, data: SendPollDto) {
    // Check anti-ban for poll messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].pollMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendStatus({ instanceName }: InstanceDto, data: SendStatusDto, file?: any) {
    // Status messages don't go to contacts - no anti-ban check needed
    return await this.waMonitor.waInstances[instanceName].statusMessage(data, file);
  }

  // ============================================================================
  // Latest WhatsApp Business API Features
  // ============================================================================

  public async sendInteractiveButtons({ instanceName }: InstanceDto, data: SendInteractiveButtonsDto) {
    // Check anti-ban for interactive button messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].interactiveButtonsMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendProduct({ instanceName }: InstanceDto, data: SendProductDto) {
    // Check anti-ban for product messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].productMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendProductCarousel({ instanceName }: InstanceDto, data: SendProductCarouselDto) {
    // Check anti-ban for product carousel messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].productCarouselMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }

  public async sendFlow({ instanceName }: InstanceDto, data: SendFlowDto) {
    // Check anti-ban for flow messages
    const phoneNumber = data.number;
    const canSend = await this.antiBanService.canSendMessage(instanceName, phoneNumber);

    if (!canSend.allowed) {
      throw new BadRequestException(canSend.reason);
    }

    const result = await this.waMonitor.waInstances[instanceName].flowMessage(data);

    // Record successful send
    await this.antiBanService.recordSend(instanceName, phoneNumber);

    return result;
  }
}

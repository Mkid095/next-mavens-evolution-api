import { Request, Response, NextFunction } from 'express';
import { AntiBanService } from '@api/services/anti-ban.service';
import { Logger } from '@config/logger.config';

/**
 * Middleware to check anti-ban status before processing message requests
 * This middleware is applied to message sending endpoints
 */
export class AntiBanMiddleware {
  private readonly logger = new Logger('AntiBanMiddleware');

  constructor(private readonly antiBanService: AntiBanService) {}

  /**
   * Check if a message can be sent based on anti-ban rules
   * Extracts instance name and phone number from request
   */
  public checkCanSend = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const instanceName = req.params.name || req.params.instanceName;
      const phoneNumber = this.extractPhoneNumber(req.body);

      // If no phone number in body (e.g., broadcast to multiple), skip check
      if (!phoneNumber || !instanceName) {
        next();
        return;
      }

      // Get template name if present
      const templateName = req.body.templateName || req.body.template;

      // Run anti-ban checks
      const result = await this.antiBanService.canSendMessage(instanceName, phoneNumber, templateName);

      if (!result.allowed) {
        this.logger.warn(`Anti-ban blocked message to ${phoneNumber}: ${result.reason}`);

        res.status(429).json({
          error: 'MESSAGE_BLOCKED',
          reason: result.reason,
          retryAfterMs: result.retryAfterMs,
          message: this.getUserFriendlyMessage(result.reason),
        });
        return;
      }

      // Attach result to request for use in controller
      (req as any).antiBanResult = result;
      next();
    } catch (error) {
      this.logger.error(`Anti-ban middleware error: ${error}`);
      // On error, allow the request (fail open)
      next();
    }
  };

  /**
   * Check block status for a specific contact
   */
  public checkBlockStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const instanceName = req.params.name || req.params.instanceName;
      const phoneNumber = req.params.phoneNumber || this.extractPhoneNumber(req.body);

      if (!phoneNumber || !instanceName) {
        next();
        return;
      }

      const canMessage = await this.antiBanService.getContactBlockStats(instanceName, phoneNumber);

      if (canMessage.isSuppressed) {
        res.status(403).json({
          error: 'CONTACT_SUPPRESSED',
          reason: canMessage.suppressionReason || 'This contact has opted out',
          phoneNumber,
        });
        return;
      }

      next();
    } catch (error) {
      this.logger.error(`Block status middleware error: ${error}`);
      next();
    }
  };

  /**
   * Extract phone number from request body
   */
  private extractPhoneNumber(body: any): string | null {
    if (!body) return null;

    // Direct number field
    if (body.phoneNumber) return body.phoneNumber;

    // Array of numbers (broadcast)
    if (body.phoneNumbers && Array.isArray(body.phoneNumbers) && body.phoneNumbers.length > 0) {
      return body.phoneNumbers[0]; // Check first recipient
    }

    // JID format (WhatsApp ID)
    if (body.jid) return body.jid;

    // Nested in numbers object
    if (body.numbers && Array.isArray(body.numbers)) {
      return body.numbers[0];
    }

    return null;
  }

  /**
   * Get user-friendly error message
   */
  private getUserFriendlyMessage(reason?: string): string {
    switch (reason) {
      case 'RATE_LIMIT_CONTACT':
        return 'Please wait before sending another message to this contact';
      case 'RATE_LIMIT_HOURLY_EXCEEDED':
        return 'Hourly message limit reached for this contact. Please try again later';
      case 'RATE_LIMIT_BURST_EXCEEDED':
        return 'Too many messages sent in a short time. Please wait';
      case 'RATE_LIMIT_GLOBAL_THROUGHPUT':
        return 'Server is busy. Please try again in a moment';
      case 'TEMPLATE_RED_QUALITY_PAUSED':
        return 'This message template is temporarily unavailable';
      case 'TEMPLATE_HAS_RED_QUALITY':
        return 'This message template has been suspended';
      case 'CONTACT_SUPPRESSED':
        return 'This contact has opted out and cannot receive messages';
      case 'HIGH_BLOCK_RATE':
        return 'Unable to send messages to this contact';
      default:
        return 'Unable to send message. Please try again later';
    }
  }
}

/**
 * Response interceptor to record message sends
 * Use this to track successful message deliveries
 */
export const recordMessageSend = (antiBanService: AntiBanService) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Store original json
    const originalJson = res.json.bind(res);

    res.json = function (body: any) {
      // If message was sent successfully (201 or 200), record the send
      if (res.statusCode >= 200 && res.statusCode < 300 && body?.message?.to) {
        const instanceName = req.params.name || req.params.instanceName;
        const phoneNumber = body.message.to;

        // Fire and forget - don't block response
        antiBanService.recordSend(instanceName, phoneNumber).catch((err) => {
          console.error('Failed to record message send:', err);
        });
      }

      return originalJson(body);
    };

    next();
  };
};

/**
 * Response interceptor to record message failures
 * Use this to track failed deliveries for block detection
 */
export const recordMessageFailure = (antiBanService: AntiBanService) => {
  return async (error: any, req: Request, res: Response, next: NextFunction): Promise<void> => {
    // If error indicates a delivery failure
    if (error?.response?.data?.error?.code) {
      const instanceName = req.params.name || req.params.instanceName;
      const phoneNumber = req.body?.phoneNumber;
      const errorCode = error.response.data.error.code;

      // Fire and forget
      antiBanService.recordDeliveryFailure(instanceName, phoneNumber, errorCode).catch((err) => {
        console.error('Failed to record delivery failure:', err);
      });
    }

    next(error);
  };
};

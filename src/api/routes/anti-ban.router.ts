import { RouterBroker } from '@api/abstract/abstract.router';
import { antiBanService } from '@api/server.module';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class AntiBanRouter extends RouterBroker {
  /**
   * The guards passed in are applied to every route. They used to be
   * accepted and dropped, which left the whole anti-ban surface — per
   * instance rate limits, health, suppression lists and the template
   * pause/resume controls — readable and writable without a key.
   */
  constructor(...guards: RequestHandler[]) {
    super();
    this.router = Router();
    this.router
      // Health check
      .get(this.routerPath('health'), ...guards, async (req, res) => {
        const health = await antiBanService.healthCheck();
        return res.status(HttpStatus.OK).json(health);
      })
      // Get account health
      .get(this.routerPath('status'), ...guards, async (req, res) => {
        const instanceName = req.query.instance as string | undefined;
        const health = await antiBanService.getAccountHealth(instanceName);
        return res.status(HttpStatus.OK).json(health);
      })
      // Get rate limit info for a contact
      .get(this.routerPath('rate-limit/:instance/:phone'), ...guards, async (req, res) => {
        const { instance, phone } = req.params;
        const info = await antiBanService.getRateLimitInfo(instance, phone);
        return res.status(HttpStatus.OK).json(info);
      })
      // Get template status
      .get(this.routerPath('template/:name'), ...guards, async (req, res) => {
        const { name } = req.params;
        const status = await antiBanService.getTemplateStatus(name);
        return res.status(HttpStatus.OK).json(status);
      })
      // Get contact block stats
      .get(this.routerPath('contact/:instance/:phone'), ...guards, async (req, res) => {
        const { instance, phone } = req.params;
        const stats = await antiBanService.getContactBlockStats(instance, phone);
        return res.status(HttpStatus.OK).json(stats);
      })
      // Manually pause a template
      .post(this.routerPath('pause-template'), ...guards, async (req, res) => {
        const { templateName, reason } = req.body;
        if (!templateName) {
          return res.status(HttpStatus.BAD_REQUEST).json({ error: 'templateName is required' });
        }
        await antiBanService.pauseTemplate(templateName, reason);
        return res.status(HttpStatus.OK).json({
          success: true,
          message: `Template '${templateName}' paused`,
        });
      })
      // Resume a template
      .post(this.routerPath('resume-template'), ...guards, async (req, res) => {
        const { templateName } = req.body;
        if (!templateName) {
          return res.status(HttpStatus.BAD_REQUEST).json({ error: 'templateName is required' });
        }
        await antiBanService.resumeTemplate(templateName);
        return res.status(HttpStatus.OK).json({
          success: true,
          message: `Template '${templateName}' resumed`,
        });
      })
      // Unsubscribe a contact (opt-out)
      .post(this.routerPath('unsubscribe'), ...guards, async (req, res) => {
        const { instanceName, phoneNumber } = req.body;
        if (!instanceName || !phoneNumber) {
          return res.status(HttpStatus.BAD_REQUEST).json({
            error: 'instanceName and phoneNumber are required',
          });
        }
        await antiBanService.unsubscribeContact(instanceName, phoneNumber);
        return res.status(HttpStatus.OK).json({
          success: true,
          message: `Contact ${phoneNumber} unsubscribed`,
        });
      })
      // Re-subscribe a contact
      .post(this.routerPath('resubscribe'), ...guards, async (req, res) => {
        const { instanceName, phoneNumber } = req.body;
        if (!instanceName || !phoneNumber) {
          return res.status(HttpStatus.BAD_REQUEST).json({
            error: 'instanceName and phoneNumber are required',
          });
        }
        await antiBanService.resubscribeContact(instanceName, phoneNumber);
        return res.status(HttpStatus.OK).json({
          success: true,
          message: `Contact ${phoneNumber} re-subscribed`,
        });
      })
      // Get all suppressed contacts for an instance
      .get(this.routerPath('suppressed/:instance'), ...guards, async (req, res) => {
        const { instance } = req.params;
        const contacts = await antiBanService['blockTracker'].getSuppressedContacts(instance);
        return res.status(HttpStatus.OK).json({
          instance,
          suppressedContacts: contacts,
          count: contacts.length,
        });
      });
  }
}

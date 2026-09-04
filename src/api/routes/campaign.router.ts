import { RouterBroker } from '@api/abstract/abstract.router';
import {
  CreateCampaignDto,
  SendCampaignDto,
  ScheduleCampaignDto,
} from '@api/dto/campaign.dto';
import { campaignController } from '@api/server.module';
import {
  cancelCampaignSchema,
  campaignStatusSchema,
  createCampaignSchema,
  sendCampaignSchema,
  scheduleCampaignSchema,
} from '@validate/campaign.schema';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class CampaignRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router = Router();
    this.router
      // Create campaign (metadata only)
      .post(this.routerPath('create'), ...guards, async (req, res) => {
        const response = await this.dataValidate<CreateCampaignDto>({
          request: req,
          schema: createCampaignSchema,
          ClassRef: CreateCampaignDto,
          execute: (instance, data) => campaignController.createCampaign(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      // Schedule campaign for future sending
      .post(this.routerPath('schedule'), ...guards, async (req, res) => {
        const response = await this.dataValidate<ScheduleCampaignDto>({
          request: req,
          schema: scheduleCampaignSchema,
          ClassRef: ScheduleCampaignDto,
          execute: (instance, data) => campaignController.scheduleCampaign(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      // Send campaign immediately
      .post(this.routerPath('send'), ...guards, async (req, res) => {
        const response = await this.dataValidate<SendCampaignDto>({
          request: req,
          schema: sendCampaignSchema,
          ClassRef: SendCampaignDto,
          execute: (instance, data) => campaignController.sendCampaign(instance, data),
        });

        return res.status(HttpStatus.CREATED).json(response);
      })
      // Get campaign status
      .get(this.routerPath('status/:campaignId'), ...guards, async (req, res) => {
        const { campaignId } = req.params;
        const response = await campaignController.getCampaignStatus(campaignId);
        return res.status(HttpStatus.OK).json(response);
      })
      // List all campaigns
      .get(this.routerPath('list'), ...guards, async (req, res) => {
        const instanceName = req.query.instanceName as string;
        const response = await campaignController.listCampaigns({ instanceName } as any);
        return res.status(HttpStatus.OK).json(response);
      })
      // Pause a campaign
      .post(this.routerPath('pause/:campaignId'), ...guards, async (req, res) => {
        const { campaignId } = req.params;
        const response = await campaignController.pauseCampaign(campaignId);
        return res.status(HttpStatus.OK).json(response);
      })
      // Resume a campaign
      .post(this.routerPath('resume/:campaignId'), ...guards, async (req, res) => {
        const { campaignId } = req.params;
        const response = await campaignController.resumeCampaign(campaignId);
        return res.status(HttpStatus.OK).json(response);
      })
      // Cancel a campaign
      .post(this.routerPath('cancel/:campaignId'), ...guards, async (req, res) => {
        const { campaignId } = req.params;
        const response = await campaignController.cancelCampaign(campaignId);
        return res.status(HttpStatus.OK).json(response);
      })
      // Delete a campaign
      .delete(this.routerPath('delete/:campaignId'), ...guards, async (req, res) => {
        const { campaignId } = req.params;
        await campaignController.deleteCampaign(campaignId);
        return res.status(HttpStatus.NO_CONTENT).json({ success: true });
      });
  }
}

import { RouterBroker } from '@api/abstract/abstract.router';
import { AnalyticsQueryDto } from '@api/dto/analytics.dto';
import { analyticsController } from '@api/server.module';
import { RequestHandler, Router } from 'express';

import { HttpStatus } from './index.router';

export class AnalyticsRouter extends RouterBroker {
  constructor(...guards: RequestHandler[]) {
    super();
    this.router = Router();
    this.router
      // Get instance-specific analytics
      .get(this.routerPath('instance/:instanceName'), ...guards, async (req, res) => {
        const { instanceName } = req.params;
        const query: AnalyticsQueryDto = {
          startDate: req.query.startDate as string,
          endDate: req.query.endDate as string,
          limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        };

        const response = await analyticsController.getInstanceAnalytics({ instanceName } as any, query);
        return res.status(HttpStatus.OK).json(response);
      })
      // Get platform-wide analytics
      .get(this.routerPath('platform'), ...guards, async (req, res) => {
        const query: AnalyticsQueryDto = {
          startDate: req.query.startDate as string,
          endDate: req.query.endDate as string,
          limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        };

        const response = await analyticsController.getPlatformAnalytics(query);
        return res.status(HttpStatus.OK).json(response);
      })
      // Get real-time metrics for an instance
      .get(this.routerPath('realtime/:instanceName'), ...guards, async (req, res) => {
        const { instanceName } = req.params;
        const response = await analyticsController.getRealTimeMetrics({ instanceName } as any);
        return res.status(HttpStatus.OK).json(response);
      });
  }
}

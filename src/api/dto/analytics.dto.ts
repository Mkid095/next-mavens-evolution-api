/**
 * Analytics DTOs for Next Mavens Fidscript WhatsApp API
 */

export class AnalyticsQueryDto {
  instanceName?: string;
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  limit?: number;
}

export class MessageStatsDto {
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  pending: number;
}

export class DeliveryRateDto {
  deliveryRate: number; // percentage
  readRate: number; // percentage
  failedRate: number; // percentage
}

export class HourlyStatsDto {
  hour: number; // 0-23
  total: number;
  sent: number;
  delivered: number;
  read: number;
}

export class InstanceAnalyticsDto {
  instanceName: string;
  status: 'connected' | 'disconnected' | 'connecting';
  uptime: number; // in seconds
  messageStats: MessageStatsDto;
  deliveryRate: DeliveryRateDto;
  topContacts: { phone: string; messageCount: number }[];
  hourlyStats: HourlyStatsDto[];
}

export class PlatformAnalyticsDto {
  totalInstances: number;
  connectedInstances: number;
  disconnectedInstances: number;
  totalMessages: number;
  totalDelivered: number;
  totalRead: number;
  totalFailed: number;
  overallDeliveryRate: number;
  overallReadRate: number;
  topInstances: { instanceName: string; messageCount: number }[];
}

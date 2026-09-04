import { JSONSchema7 } from 'json-schema';
import { v4 } from 'uuid';

export const analyticsQuerySchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    instanceName: { type: 'string' },
    startDate: { type: 'string' },
    endDate: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
  },
};

export const instanceAnalyticsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    instanceName: { type: 'string' },
    status: { type: 'string', enum: ['connected', 'disconnected', 'connecting'] },
    uptime: { type: 'number' },
    messageStats: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        sent: { type: 'number' },
        delivered: { type: 'number' },
        read: { type: 'number' },
        failed: { type: 'number' },
        pending: { type: 'number' },
      },
    },
    deliveryRate: {
      type: 'object',
      properties: {
        deliveryRate: { type: 'number' },
        readRate: { type: 'number' },
        failedRate: { type: 'number' },
      },
    },
    topContacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
          messageCount: { type: 'number' },
        },
      },
    },
    hourlyStats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hour: { type: 'number' },
          total: { type: 'number' },
          sent: { type: 'number' },
          delivered: { type: 'number' },
          read: { type: 'number' },
        },
      },
    },
  },
};

export const platformAnalyticsSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    totalInstances: { type: 'number' },
    connectedInstances: { type: 'number' },
    disconnectedInstances: { type: 'number' },
    totalMessages: { type: 'number' },
    totalDelivered: { type: 'number' },
    totalRead: { type: 'number' },
    totalFailed: { type: 'number' },
    overallDeliveryRate: { type: 'number' },
    overallReadRate: { type: 'number' },
    topInstances: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instanceName: { type: 'string' },
          messageCount: { type: 'number' },
        },
      },
    },
  },
};

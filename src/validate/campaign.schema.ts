import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { v4 } from 'uuid';

const numberDefinition: JSONSchema7Definition = {
  type: 'string',
  description: 'Invalid format',
};

const quotedOptionsSchema: JSONSchema7 = {
  properties: {
    key: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
      },
      required: ['id'],
    },
    message: { type: 'object' },
  },
};

export const createCampaignSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    instanceName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
  },
  required: ['name', 'instanceName'],
};

export const scheduleCampaignSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    instanceName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    message: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'media', 'template', 'interactive'] },
        text: { type: 'string' },
        mediaUrl: { type: 'string' },
        mediaType: { type: 'string', enum: ['image', 'video', 'document'] },
        mediaCaption: { type: 'string' },
        templateName: { type: 'string' },
        templateLanguage: { type: 'string' },
        templateComponents: { type: 'array' },
        interactiveButtons: { type: 'array' },
      },
      required: ['type'],
    },
    recipients: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          phone: { ...numberDefinition },
          variables: { type: 'object' },
        },
        required: ['phone'],
      },
    },
    scheduledAt: { type: 'string' },
    maxPerMinute: { type: 'integer', minimum: 1, maximum: 100 },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    everyOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['name', 'instanceName', 'message', 'recipients'],
};

export const sendCampaignSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    instanceName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    message: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'media', 'template', 'interactive'] },
        text: { type: 'string' },
        mediaUrl: { type: 'string' },
        mediaType: { type: 'string', enum: ['image', 'video', 'document'] },
        mediaCaption: { type: 'string' },
        templateName: { type: 'string' },
        templateLanguage: { type: 'string' },
        templateComponents: { type: 'array' },
        interactiveButtons: { type: 'array' },
      },
      required: ['type'],
    },
    recipients: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          phone: { ...numberDefinition },
          variables: { type: 'object' },
        },
        required: ['phone'],
      },
    },
    maxPerMinute: { type: 'integer', minimum: 1, maximum: 100 },
    delay: {
      type: 'integer',
      description: 'Enter a value in milliseconds',
    },
    quoted: { ...quotedOptionsSchema },
    everyOne: { type: 'boolean', enum: [true, false] },
    mentioned: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"mentioned" must be an array of numeric strings',
      },
    },
  },
  required: ['name', 'instanceName', 'message', 'recipients'],
};

export const campaignStatusSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    campaignId: { type: 'string', minLength: 1 },
  },
  required: ['campaignId'],
};

export const cancelCampaignSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    campaignId: { type: 'string', minLength: 1 },
  },
  required: ['campaignId'],
};

import { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { v4 } from 'uuid';

const isNotEmpty = (...propertyNames: string[]): JSONSchema7 => {
  const properties = {};
  propertyNames.forEach(
    (property) =>
      (properties[property] = {
        minLength: 1,
        description: `The "${property}" cannot be empty`,
      }),
  );
  return {
    if: {
      propertyNames: {
        enum: [...propertyNames],
      },
    },
    then: { properties },
  };
};

const numberDefinition: JSONSchema7Definition = {
  type: 'string',
  description: 'Invalid format',
};

export const templateMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    name: { type: 'string' },
    language: { type: 'string' },
    components: { type: 'array' },
    webhookUrl: { type: 'string' },
  },
  required: ['name', 'language'],
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
      ...isNotEmpty('id'),
    },
    message: { type: 'object' },
  },
};

export const offerCallSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    isVideo: { type: 'boolean', enum: [true, false] },
    callDuration: { type: 'integer', minimum: 1, maximum: 15 },
  },
  required: ['number', 'callDuration'],
};

export const textMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    text: { type: 'string' },
    linkPreview: { type: 'boolean' },
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
  required: ['number', 'text'],
};

export const mediaMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    mediatype: { type: 'string', enum: ['image', 'document', 'video', 'audio'] },
    mimetype: { type: 'string' },
    media: { type: 'string' },
    fileName: { type: 'string' },
    caption: { type: 'string' },
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
  required: ['number', 'mediatype'],
};

export const ptvMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    video: { type: 'string' },
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
  required: ['number'],
};

export const audioMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    audio: { type: 'string' },
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
  required: ['number'],
};

export const statusMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['text', 'image', 'audio', 'video'] },
    content: { type: 'string' },
    caption: { type: 'string' },
    backgroundColor: { type: 'string' },
    font: { type: 'integer', minimum: 0, maximum: 5 },
    statusJidList: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^\\d+',
        description: '"statusJidList" must be an array of numeric strings',
      },
    },
    allContacts: { type: 'boolean', enum: [true, false] },
  },
  required: ['type'],
};

export const stickerMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    sticker: { type: 'string' },
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
  required: ['number'],
};

export const locationMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    name: { type: 'string' },
    address: { type: 'string' },
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
  required: ['number', 'latitude', 'longitude', 'name', 'address'],
};

export const contactMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    contact: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fullName: { type: 'string' },
          wuid: {
            type: 'string',
            minLength: 10,
            pattern: '\\d+',
            description: '"wuid" must be a numeric string',
          },
          phoneNumber: { type: 'string', minLength: 10 },
          organization: { type: 'string' },
          email: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['fullName', 'phoneNumber'],
        ...isNotEmpty('fullName'),
      },
      minItems: 1,
      uniqueItems: true,
    },
  },
  required: ['number', 'contact'],
};

export const reactionMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    key: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        remoteJid: { type: 'string' },
        fromMe: { type: 'boolean', enum: [true, false] },
      },
      required: ['id', 'remoteJid', 'fromMe'],
      ...isNotEmpty('id', 'remoteJid'),
    },
    reaction: { type: 'string' },
  },
  required: ['key', 'reaction'],
};

export const pollMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    name: { type: 'string' },
    selectableCount: { type: 'integer', minimum: 0, maximum: 10 },
    values: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      uniqueItems: true,
      items: {
        type: 'string',
      },
    },
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
  required: ['number', 'name', 'selectableCount', 'values'],
};

export const listMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    title: { type: 'string' },
    description: { type: 'string' },
    footerText: { type: 'string' },
    buttonText: { type: 'string' },
    sections: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          rows: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                rowId: { type: 'string' },
              },
              required: ['title', 'rowId'],
              ...isNotEmpty('title', 'description', 'rowId'),
            },
          },
        },
        required: ['title', 'rows'],
        ...isNotEmpty('title'),
      },
    },
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
  required: ['number', 'title', 'footerText', 'buttonText', 'sections'],
};

export const buttonsMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    thumbnailUrl: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    footer: { type: 'string' },
    buttons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['reply', 'copy', 'url', 'call', 'pix'],
          },
          displayText: { type: 'string' },
          id: { type: 'string' },
          url: { type: 'string' },
          phoneNumber: { type: 'string' },
          currency: { type: 'string' },
          name: { type: 'string' },
          keyType: { type: 'string', enum: ['phone', 'email', 'cpf', 'cnpj', 'random'] },
          key: { type: 'string' },
        },
        required: ['type'],
        ...isNotEmpty('id', 'url', 'phoneNumber'),
      },
    },
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
  required: ['number'],
};

// ============================================================================
// Latest WhatsApp Business API Interactive Features
// ============================================================================

export const interactiveButtonsMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    header: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['text', 'image', 'video', 'document'] },
        text: { type: 'string' },
        media: { type: 'string' },
        mimeType: { type: 'string' },
        filename: { type: 'string' },
      },
    },
    body: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    footer: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
    },
    action: {
      type: 'object',
      properties: {
        buttons: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['reply', 'url', 'copy'] },
              reply: {
                type: 'object',
                properties: {
                  title: { type: 'string', maxLength: 20 },
                  id: { type: 'string' },
                },
                required: ['title'],
              },
              url: {
                type: 'object',
                properties: {
                  title: { type: 'string', maxLength: 20 },
                  url: { type: 'string' },
                },
                required: ['title', 'url'],
              },
              copy: {
                type: 'object',
                properties: {
                  title: { type: 'string', maxLength: 20 },
                  copyCode: { type: 'string' },
                },
                required: ['title', 'copyCode'],
              },
            },
            required: ['type'],
          },
        },
      },
      required: ['buttons'],
    },
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
  required: ['number', 'body', 'action'],
};

export const productMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    catalogId: { type: 'string' },
    productId: { type: 'string' },
    storefrontName: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          productIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['title', 'productIds'],
      },
    },
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
  required: ['number', 'catalogId', 'productId'],
};

export const productCarouselMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    header: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        media: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['text'],
    },
    body: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    footer: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
    },
    catalogId: { type: 'string' },
    productItems: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string' },
          thumbnailUrl: { type: 'string' },
          title: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 80 },
          price: { type: 'string' },
          currency: { type: 'string' },
        },
        required: ['productId'],
      },
    },
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
  required: ['number', 'header', 'body', 'catalogId', 'productItems'],
};

export const flowMessageSchema: JSONSchema7 = {
  $id: v4(),
  type: 'object',
  properties: {
    number: { ...numberDefinition },
    flowId: { type: 'string' },
    flowToken: { type: 'string' },
    screen: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        helpText: { type: 'string' },
        data: { type: 'object' },
      },
    },
    action: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        jsonPath: { type: 'string' },
      },
    },
    final: { type: 'boolean' },
    data: { type: 'object' },
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
  required: ['number', 'flowId', 'flowToken'],
};

// @ts-expect-error Constructor is a legacy helper that is not exported by integration.dto
import { Constructor } from '@api/integrations/integration.dto';
import { JsonValue } from '@prisma/client/runtime/library';

export class EventDto {
  webhook?: {
    enabled?: boolean;
    events?: string[];
    url?: string;
    headers?: JsonValue;
    byEvents?: boolean;
    base64?: boolean;
  };

  websocket?: {
    enabled?: boolean;
    events?: string[];
  };

  sqs?: {
    enabled?: boolean;
    events?: string[];
  };

  rabbitmq?: {
    enabled?: boolean;
    events?: string[];
  };

  nats?: {
    enabled?: boolean;
    events?: string[];
  };

  pusher?: {
    enabled?: boolean;
    appId?: string;
    key?: string;
    secret?: string;
    cluster?: string;
    useTLS?: boolean;
    events?: string[];
  };

  kafka?: {
    enabled?: boolean;
    events?: string[];
  };
}

export function EventInstanceMixin<TBase extends Constructor>(Base: TBase) {
  // @ts-expect-error the mixin class type is not assignable to the base constructor type
  return class extends Base {
    webhook?: {
      enabled?: boolean;
      events?: string[];
      headers?: JsonValue;
      url?: string;
      byEvents?: boolean;
      base64?: boolean;
    };

    websocket?: {
      enabled?: boolean;
      events?: string[];
    };

    sqs?: {
      enabled?: boolean;
      events?: string[];
    };

    rabbitmq?: {
      enabled?: boolean;
      events?: string[];
    };

    nats?: {
      enabled?: boolean;
      events?: string[];
    };

    pusher?: {
      enabled?: boolean;
      appId?: string;
      key?: string;
      secret?: string;
      cluster?: string;
      useTLS?: boolean;
      events?: string[];
    };

    kafka?: {
      enabled?: boolean;
      events?: string[];
    };
  };
}

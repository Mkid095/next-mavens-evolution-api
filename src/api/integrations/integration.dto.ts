import { EventInstanceMixin } from '@api/integrations/event/event.dto';

export class IntegrationDto extends EventInstanceMixin(class {}) {}

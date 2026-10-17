// messaging provider adapters. Owner: Agent C. Export adapters and their ProviderDescriptor here.
import { messagingSandboxAdapter } from './sandbox';
import { whatsappCloudAdapter } from './whatsapp-cloud';

export * from './whatsapp-cloud';
export * from './sandbox';

export const messagingAdapters = [whatsappCloudAdapter, messagingSandboxAdapter] as const;

// messaging provider adapters. Owner: Agent C. Export adapters and their ProviderDescriptor here.
import { messagingSandboxAdapter } from './sandbox';
import { metaPagesAdapter } from './meta-pages';
import { whatsappCloudAdapter } from './whatsapp-cloud';

export * from './whatsapp-cloud';
export * from './sandbox';
export * from './meta-pages';

export const messagingAdapters = [whatsappCloudAdapter, metaPagesAdapter, messagingSandboxAdapter] as const;

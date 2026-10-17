import { z } from 'zod';

/** Resuto product modules. Entitlements are decided per module by the backend. */
export const MODULE_KEYS = [
  'core', 'connect', 'pay', 'marketing', 'driver', 'studio', 'finance', 'compliance', 'intelligence', 'mcp',
] as const;
export const moduleKey = z.enum(MODULE_KEYS);
export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_INFO: Record<ModuleKey, { name: string; nameAr: string; description: string }> = {
  core: { name: 'Resuto Core', nameAr: 'ريزوتو الأساسي', description: 'Menu, QR ordering, reservations, floor, kitchen, inventory, staff.' },
  connect: { name: 'Resuto Connect', nameAr: 'ريزوتو كونكت', description: 'WhatsApp ordering, unified inbox and customer messaging.' },
  pay: { name: 'ResutoPay', nameAr: 'ريزوتو باي', description: 'Checkout links, QR payment, split bills, deposits, reconciliation.' },
  marketing: { name: 'Resuto Marketing', nameAr: 'ريزوتو للتسويق', description: 'CRM segments, campaigns, offers, attribution and ad reporting.' },
  driver: { name: 'ResutoDriver', nameAr: 'ريزوتو درايفر', description: 'Delivery dispatch and the driver web app.' },
  studio: { name: 'ResutoStudio', nameAr: 'ريزوتو ستوديو', description: 'Restaurant website, custom domains and AI creative.' },
  finance: { name: 'Resuto Finance', nameAr: 'ريزوتو المالية', description: 'Revenue, expenses, profitability and accounting exports.' },
  compliance: { name: 'Resuto Compliance', nameAr: 'ريزوتو الامتثال', description: 'Tax profiles, fiscal documents, licences and expiry reminders.' },
  intelligence: { name: 'Resuto Intelligence', nameAr: 'ريزوتو الذكاء', description: 'Forecasting, segmentation, recommendations and the owner assistant.' },
  mcp: { name: 'ResutoMCP', nameAr: 'ريزوتو MCP', description: 'Secure connection for external AI clients (Claude, ChatGPT).' },
};

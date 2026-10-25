// WhatsApp official onboarding (21-INT, plan §6.9): the stepper's steps, the staff routing modes and the template
// library the "Templates and language" step prefills from. Zod-free (also exported from '@resuto/contracts/lite').
//
// The QR "compatibility mode" of §6.9 is NOT part of this: it is gated research (G-WA) and is never offered here.

export const WHATSAPP_ONBOARDING_STEPS = ['connect', 'number', 'ordering', 'templates', 'routing', 'test', 'activate'] as const;
export type WhatsAppOnboardingStep = (typeof WHATSAPP_ONBOARDING_STEPS)[number];

/**
 * How new conversations on a channel are assigned to staff: 'manual' (nobody until someone takes it), 'round_robin'
 * (the active member with connect:reply who was assigned least recently), 'by_branch' (the same, among members who
 * can see the channel's branch).
 */
export const CHANNEL_ROUTING_MODES = ['manual', 'round_robin', 'by_branch'] as const;
export type ChannelRoutingMode = (typeof CHANNEL_ROUTING_MODES)[number];

export interface WhatsAppLibraryTemplate {
  name: string;
  language: 'en' | 'ar';
  category: 'utility';
  body: string;
  variables: string[];
}

/**
 * Utility templates a restaurant usually needs, in English and Arabic (Western digits). The stepper creates the ones
 * the owner ticks through the existing template API and submits them to Meta for review; Meta decides approval.
 * `resuto_connection_test` is what "Send a test template to my phone" sends.
 */
export const WHATSAPP_TEMPLATE_LIBRARY: readonly WhatsAppLibraryTemplate[] = [
  { name: 'resuto_connection_test', language: 'en', category: 'utility', variables: ['restaurant_name'],
    body: 'This is a test message from {{1}}. Your WhatsApp number is connected to Resuto.' },
  { name: 'resuto_connection_test', language: 'ar', category: 'utility', variables: ['restaurant_name'],
    body: 'هذه رسالة تجريبية من {{1}}. رقم واتساب الخاص بك متصل بريسوتو.' },
  { name: 'resuto_order_confirmed', language: 'en', category: 'utility', variables: ['customer_name', 'order_number'],
    body: 'Hi {{1}}, your order {{2}} is confirmed. We will message you when it is ready.' },
  { name: 'resuto_order_confirmed', language: 'ar', category: 'utility', variables: ['customer_name', 'order_number'],
    body: 'مرحبًا {{1}}، تم تأكيد طلبك رقم {{2}}. سنراسلك عندما يكون جاهزًا.' },
  { name: 'resuto_order_ready', language: 'en', category: 'utility', variables: ['order_number'],
    body: 'Your order {{1}} is ready.' },
  { name: 'resuto_order_ready', language: 'ar', category: 'utility', variables: ['order_number'],
    body: 'طلبك رقم {{1}} جاهز.' },
  { name: 'resuto_reservation_reminder', language: 'en', category: 'utility', variables: ['customer_name', 'time'],
    body: 'Hi {{1}}, a reminder of your table today at {{2}}. Reply to change or cancel.' },
  { name: 'resuto_reservation_reminder', language: 'ar', category: 'utility', variables: ['customer_name', 'time'],
    body: 'مرحبًا {{1}}، نذكّرك بحجز طاولتك اليوم الساعة {{2}}. رُدّ للتعديل أو الإلغاء.' },
];

/** The template "Send a test template to my phone" uses. */
export const WHATSAPP_TEST_TEMPLATE = 'resuto_connection_test';

// Bilingual copy for the structured ordering bot and order notifications.
// The bot never interprets free text as order items: it only recognises a few
// commands and interactive reply ids.
export type Locale = 'en' | 'ar';

const COPY = {
  welcome: { en: 'Welcome to {name}! 👋 Tap "Order now" to pick from our menu, or talk to our team.', ar: 'أهلًا بك في {name}! 👋 اضغط "اطلب الآن" لاختيار طلبك من القائمة، أو تحدث مع فريقنا.' },
  orderNow: { en: 'Order now', ar: 'اطلب الآن' },
  talkToUs: { en: 'Talk to our team', ar: 'تحدث مع الفريق' },
  chooseBranch: { en: 'Which branch would you like to order from?', ar: 'من أي فرع تحب أن تطلب؟' },
  branches: { en: 'Branches', ar: 'الفروع' },
  chooseFulfillment: { en: 'How would you like to receive your order?', ar: 'كيف تحب أن تستلم طلبك؟' },
  pickup: { en: 'Pickup', ar: 'استلام من الفرع' },
  delivery: { en: 'Delivery', ar: 'توصيل' },
  askName: { en: 'What name should we put on the order? (Reply with your name)', ar: 'ما الاسم الذي نكتبه على الطلب؟ (أرسل اسمك)' },
  useName: { en: 'Use "{name}"', ar: 'استخدم "{name}"' },
  askAddress: { en: 'Send your delivery address (street, building, floor) or share your location pin.', ar: 'أرسل عنوان التوصيل (الشارع، العمارة، الدور) أو شارك موقعك.' },
  menuLink: { en: 'Great, {name}! Tap below to choose your items. Prices and availability are checked by the restaurant when you confirm.', ar: 'تمام يا {name}! اضغط بالأسفل لاختيار طلبك. الأسعار والتوفر يتم التحقق منها عند التأكيد.' },
  openMenu: { en: 'Open menu', ar: 'افتح القائمة' },
  review: { en: 'Your order:\n{lines}\n\nSubtotal {subtotal}{delivery}\nTotal {total}\n\nHow would you like to pay?', ar: 'طلبك:\n{lines}\n\nالمجموع الفرعي {subtotal}{delivery}\nالإجمالي {total}\n\nكيف تحب أن تدفع؟' },
  deliveryFee: { en: '\nDelivery {fee}', ar: '\nالتوصيل {fee}' },
  chooseZone: { en: 'Almost done: choose your delivery area on the order page so we can confirm the delivery fee.', ar: 'خطوة أخيرة: اختر منطقة التوصيل في صفحة الطلب لنؤكد رسوم التوصيل.' },
  payOnline: { en: 'Pay online', ar: 'ادفع أونلاين' },
  payCod: { en: 'Cash on delivery', ar: 'الدفع عند الاستلام' },
  payAtPickup: { en: 'Pay at pickup', ar: 'الدفع عند الاستلام' },
  payLink: { en: 'Order #{number} is reserved. Complete the payment of {total} to send it to the kitchen.', ar: 'تم حجز الطلب رقم {number}. أكمل دفع {total} لإرساله إلى المطبخ.' },
  payNow: { en: 'Pay now', ar: 'ادفع الآن' },
  stillAwaitingPayment: { en: 'Your order #{number} is waiting for payment.', ar: 'طلبك رقم {number} في انتظار الدفع.' },
  cancelled: { en: 'Your order was cancelled. Send "order" any time to start again.', ar: 'تم إلغاء طلبك. أرسل "اطلب" في أي وقت للبدء من جديد.' },
  expired: { en: 'Your ordering session expired. Send "order" to start again.', ar: 'انتهت جلسة الطلب. أرسل "اطلب" للبدء من جديد.' },
  handoff: { en: 'Thanks! A team member will reply here shortly.', ar: 'شكرًا! سيرد عليك أحد أعضاء الفريق هنا قريبًا.' },
  unavailable: { en: 'Online ordering is not available right now. A team member can help you.', ar: 'الطلب أونلاين غير متاح حاليًا. يمكن لأحد أعضاء الفريق مساعدتك.' },
  invalidName: { en: 'Please send a name between 2 and 60 characters.', ar: 'من فضلك أرسل اسمًا بين حرفين و60 حرفًا.' },
  invalidAddress: { en: 'Please send a full address (at least 5 characters) or share your location.', ar: 'من فضلك أرسل عنوانًا كاملًا (5 أحرف على الأقل) أو شارك موقعك.' },
  // Order notifications
  orderReceivedCod: { en: '✅ Order #{number} received. Total {total}, payable on delivery.', ar: '✅ تم استلام الطلب رقم {number}. الإجمالي {total} يُدفع عند الاستلام.' },
  orderReceivedPickup: { en: '✅ Order #{number} received. Total {total}, payable at pickup.', ar: '✅ تم استلام الطلب رقم {number}. الإجمالي {total} يُدفع عند الاستلام من الفرع.' },
  orderReceived: { en: '✅ Order #{number} received. Total {total}.', ar: '✅ تم استلام الطلب رقم {number}. الإجمالي {total}.' },
  orderPaid: { en: '💳 Payment received for order #{number}. Thank you!', ar: '💳 تم استلام الدفع للطلب رقم {number}. شكرًا لك!' },
  status_accepted: { en: '👍 Order #{number} was accepted.', ar: '👍 تم قبول الطلب رقم {number}.' },
  status_preparing: { en: '👨‍🍳 Order #{number} is being prepared.', ar: '👨‍🍳 جارٍ تحضير الطلب رقم {number}.' },
  status_ready_pickup: { en: '🛍 Order #{number} is ready for pickup.', ar: '🛍 الطلب رقم {number} جاهز للاستلام.' },
  status_ready: { en: '✅ Order #{number} is ready.', ar: '✅ الطلب رقم {number} جاهز.' },
  status_picked_up: { en: 'Enjoy your meal! Order #{number} was collected.', ar: 'بالهناء والشفاء! تم استلام الطلب رقم {number}.' },
  status_delivered: { en: 'Order #{number} was delivered. Enjoy your meal!', ar: 'تم توصيل الطلب رقم {number}. بالهناء والشفاء!' },
  status_cancelled: { en: 'Order #{number} was cancelled.', ar: 'تم إلغاء الطلب رقم {number}.' },
  delivery_on_the_way: { en: '🛵 Order #{number} is on the way.', ar: '🛵 الطلب رقم {number} في الطريق إليك.' },
  delivery_on_the_way_eta: { en: '🛵 Order #{number} is on the way. Expected around {eta}.', ar: '🛵 الطلب رقم {number} في الطريق إليك. الوصول المتوقع حوالي {eta}.' },
  reservationConfirmed: { en: '📅 Your table for {party} on {when} is confirmed. Booking code {code}.', ar: '📅 تم تأكيد حجز طاولة لـ {party} في {when}. رمز الحجز {code}.' },
} as const;

export type CopyKey = keyof typeof COPY;

export function copy(locale: Locale, key: CopyKey, vars: Record<string, string | number> = {}): string {
  let s: string = COPY[key][locale] ?? COPY[key].en;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export const hasArabic = (s: string | null | undefined) => !!s && /[؀-ۿ]/.test(s);

const norm = (s: string) => s.trim().toLowerCase().replace(/[.!؟?]+$/u, '');
const START = /^(order|menu|start|hi|hello|hey|اطلب|طلب|ابدأ|ابدا|القائمة|المنيو|منيو|مرحبا|اهلا|أهلا|السلام عليكم)(\s|$)/u;
const CANCEL = /^(cancel|stop|الغاء|إلغاء|الغي|ألغي)$/u;
const HUMAN = /^(agent|human|staff|help|support|موظف|مساعدة|خدمة العملاء|كلم موظف)$/u;
const RESTART = /^(restart|start over|من جديد|ابدأ من جديد)$/u;

/** Recognised commands in free text. Anything else is NOT an order instruction. */
export function textCommand(text: string | null): 'start' | 'cancel' | 'human' | 'restart' | null {
  if (!text) return null;
  const t = norm(text);
  if (RESTART.test(t)) return 'restart';
  if (CANCEL.test(t)) return 'cancel';
  if (HUMAN.test(t)) return 'human';
  if (START.test(t)) return 'start';
  return null;
}

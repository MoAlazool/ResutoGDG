// Strings for the public pricing page (owner: Agent A). Colocated so the shared
// i18n index is untouched; pick the table with useT().locale.
import type { ModuleKey } from '@resuto/contracts';

const en = {
  navPlans: 'Plans', navCompare: 'Compare', navBuild: 'Build your Resuto', navFaq: 'Questions', signIn: 'Sign in', startFree: 'Start free',
  overline: 'Pricing',
  title: 'One price for the whole service.',
  subtitle: 'QR ordering, reservations, the kitchen board, payments, WhatsApp, delivery and AI — priced per restaurant in your currency. Paid plans start with a 14-day trial.',
  egypt: 'Egypt · EGP', saudi: 'Saudi Arabia · SAR',
  monthly: 'Monthly', yearly: 'Yearly', save: 'save {pct}%',
  perMonth: '/ month', perYear: '/ year', billedMonthly: 'Billed monthly', billedYearly: 'Billed yearly',
  priceMissing: 'Price not published for this country yet',
  recommended: 'Recommended for busy restaurants',
  startTrial: 'Start 14-day trial', startFreePlan: 'Start free', buildOwn: 'Build it',
  limitBranches: '{n} branch(es)', limitStaff: '{n} staff accounts', limitOrders: '{n} orders / month', limitAi: '{n} AI requests / month', noAi: 'No AI requests',
  customLead: 'Base price includes Resuto Core. Add only the modules you need.',
  compareTitle: 'Compare every plan', compareSub: 'Every module and limit, straight from the live price list.',
  feature: 'Feature', included: 'Included', notIncluded: 'Not included', addon: 'Add-on {price}', modulesGroup: 'Modules', limitsGroup: 'Limits',
  rowBranches: 'Branches', rowStaff: 'Staff accounts', rowOrders: 'Orders per month', rowAi: 'AI requests per month', unlimited: 'Unlimited',
  buildTitle: 'Build your Resuto', buildSub: 'Start from any plan and add modules. The quote is calculated by the same pricing service your invoice uses.',
  basePlan: 'Starting plan', modulesPick: 'Add modules', inPlan: 'In plan', total: 'Total', quoteError: 'Could not calculate this quote. Try again.',
  calculating: 'Calculating…', perInterval: 'per {interval}', month: 'month', year: 'year', getStarted: 'Get started with this setup',
  externalTitle: 'What is not included',
  billingNote: 'Launch pricing. Online card payment for Resuto subscriptions is not available yet: paid plans are invoiced by Resuto after the trial. Nothing is charged automatically.',
  faqTitle: 'Common questions',
  q1: 'Is there a free plan?', a1: 'Yes. Free QR covers a digital menu and QR table ordering for one branch, with a monthly order limit. Upgrade any time.',
  q2: 'Can I change plans later?', a2: 'Upgrades apply immediately. Downgrades take effect at the end of your billing period, and only if your branches and staff fit the smaller plan.',
  q3: 'Who charges the payment and WhatsApp fees?', a3: 'Your payment provider (for example Paymob or Stripe), Meta for WhatsApp conversations, and ad platforms bill you directly from your own accounts. Resuto never marks those up.',
  q4: 'Do you hold my customers’ money?', a4: 'No. Each restaurant connects its own payment provider account; Resuto records payments and reconciles them.',
  loading: 'Loading prices…', error: 'Prices could not be loaded.', retry: 'Retry',
};

type Strings = typeof en;

const ar: Strings = {
  navPlans: 'الخطط', navCompare: 'المقارنة', navBuild: 'ابنِ ريسوتو', navFaq: 'الأسئلة', signIn: 'تسجيل الدخول', startFree: 'ابدأ مجانًا',
  overline: 'الأسعار',
  title: 'سعر واحد للخدمة كلها.',
  subtitle: 'الطلب عبر QR والحجوزات وشاشة المطبخ والمدفوعات وواتساب والتوصيل والذكاء الاصطناعي — بسعر لكل مطعم وبعملتك. الخطط المدفوعة تبدأ بتجربة 14 يومًا.',
  egypt: 'مصر · جنيه', saudi: 'السعودية · ريال',
  monthly: 'شهري', yearly: 'سنوي', save: 'وفّر {pct}٪',
  perMonth: '/ شهريًا', perYear: '/ سنويًا', billedMonthly: 'فوترة شهرية', billedYearly: 'فوترة سنوية',
  priceMissing: 'لم يُنشر السعر لهذه الدولة بعد',
  recommended: 'مقترحة للمطاعم المزدحمة',
  startTrial: 'ابدأ تجربة 14 يومًا', startFreePlan: 'ابدأ مجانًا', buildOwn: 'ابنِها',
  limitBranches: '{n} فرع', limitStaff: '{n} حساب موظف', limitOrders: '{n} طلب شهريًا', limitAi: '{n} طلب ذكاء اصطناعي شهريًا', noAi: 'بدون طلبات ذكاء اصطناعي',
  customLead: 'السعر الأساسي يشمل ريسوتو الأساسي. أضف الوحدات التي تحتاجها فقط.',
  compareTitle: 'قارن كل الخطط', compareSub: 'كل وحدة وكل حد، مباشرة من قائمة الأسعار الحالية.',
  feature: 'الميزة', included: 'مضمّنة', notIncluded: 'غير مضمّنة', addon: 'إضافة {price}', modulesGroup: 'الوحدات', limitsGroup: 'الحدود',
  rowBranches: 'الفروع', rowStaff: 'حسابات الموظفين', rowOrders: 'الطلبات شهريًا', rowAi: 'طلبات الذكاء الاصطناعي شهريًا', unlimited: 'غير محدود',
  buildTitle: 'ابنِ ريسوتو الخاص بك', buildSub: 'ابدأ من أي خطة وأضف الوحدات. يُحسب العرض بخدمة التسعير نفسها التي تُصدر فاتورتك.',
  basePlan: 'الخطة الأساسية', modulesPick: 'أضف وحدات', inPlan: 'ضمن الخطة', total: 'الإجمالي', quoteError: 'تعذّر حساب العرض. حاول مرة أخرى.',
  calculating: 'جارٍ الحساب…', perInterval: 'لكل {interval}', month: 'شهر', year: 'سنة', getStarted: 'ابدأ بهذا الإعداد',
  externalTitle: 'ما لا تشمله الأسعار',
  billingNote: 'أسعار الإطلاق. الدفع الإلكتروني لاشتراكات ريسوتو غير متاح بعد: تصدر ريسوتو فواتير الخطط المدفوعة بعد التجربة، ولا يتم أي خصم تلقائي.',
  faqTitle: 'أسئلة شائعة',
  q1: 'هل توجد خطة مجانية؟', a1: 'نعم. خطة QR المجانية تشمل قائمة رقمية وطلب الطاولات عبر QR لفرع واحد مع حد شهري للطلبات. يمكنك الترقية في أي وقت.',
  q2: 'هل يمكنني تغيير الخطة لاحقًا؟', a2: 'الترقية تُطبّق فورًا. التخفيض يسري في نهاية فترة الفوترة، وبشرط أن تناسب فروعك وموظفوك الخطة الأصغر.',
  q3: 'من يحصّل رسوم الدفع وواتساب؟', a3: 'مزوّد الدفع (مثل Paymob أو Stripe)، وميتا لمحادثات واتساب، ومنصات الإعلانات يحاسبونك مباشرة من حساباتك. ريسوتو لا تضيف عليها أي هامش.',
  q4: 'هل تحتفظ ريسوتو بأموال عملائي؟', a4: 'لا. يربط كل مطعم حساب مزوّد الدفع الخاص به، وتسجّل ريسوتو المدفوعات وتطابقها.',
  loading: 'جارٍ تحميل الأسعار…', error: 'تعذّر تحميل الأسعار.', retry: 'إعادة المحاولة',
};

export const PRICING_STRINGS = { en, ar };

export const MODULE_DESC_AR: Record<ModuleKey, string> = {
  core: 'القائمة وطلب QR والحجوزات والصالة والمطبخ والمخزون والموظفون.',
  connect: 'الطلب عبر واتساب وصندوق رسائل موحّد ومراسلة العملاء.',
  pay: 'روابط الدفع والدفع عبر QR وتقسيم الفاتورة والعرابين والمطابقة.',
  marketing: 'شرائح العملاء والحملات والعروض وقياس النتائج وتقارير الإعلانات.',
  driver: 'توزيع طلبات التوصيل وتطبيق السائق على الويب.',
  studio: 'موقع المطعم والنطاقات الخاصة والمحتوى بالذكاء الاصطناعي.',
  finance: 'الإيرادات والمصروفات والربحية وتصدير الحسابات.',
  compliance: 'الملفات الضريبية والمستندات الضريبية الإلكترونية والتراخيص وتذكيرات انتهائها.',
  intelligence: 'التنبؤ والتقسيم والتوصيات ومساعد المالك.',
  mcp: 'اتصال آمن لعملاء الذكاء الاصطناعي الخارجيين (Claude وChatGPT).',
};

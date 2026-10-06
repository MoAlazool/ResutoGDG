/* Resuto plans: one source for the /pricing cards and the landing page's
   comparison table. Prices and branch/staff numbers come from /api/plans;
   everything here is the approved plan copy. Nothing in the product gates a
   feature by plan yet, so a value here is a commitment, not a measurement.
   Strings are 'English|Arabic'. */

// The bullet lists on /pricing, in plan order: Starter, Growth, Pro, Business.
export const planLists=[
 ['1 branch|فرع واحد','QR menu & ordering|قائمة وطلبات QR','Reservations & floor map|الحجوزات وخريطة المطعم','Pickup & ratings|استلام الطلبات والتقييمات','Basic dashboard & analytics|لوحة إدارة وتحليلات أساسية','2 staff accounts|حسابان للموظفين'],
 ['Everything in Starter|كل مزايا Starter','Premium table selection|اختيار الطاولات المميزة','AI waiter & kitchen display|النادل الذكي وشاشة المطبخ','Split payments|تقسيم الفاتورة','Inventory & customer database|المخزون وبيانات العملاء','Integrations & advanced analytics|التكاملات والتحليلات المتقدمة','10 staff accounts|١٠ حسابات للموظفين','Priority support|دعم ذو أولوية'],
 ['Everything in Growth|كل مزايا Growth','Up to 3 branches|حتى ٣ فروع','AI operational insights|تحليلات تشغيلية ذكية','Multi-branch management|إدارة الفروع','Advanced inventory (planned)|مخزون متقدم (مخطط)','Custom policies & reports (planned)|سياسات وتقارير مخصصة (مخطط)','Staff permissions & onboarding (planned)|صلاحيات وإعداد مخصص (مخطط)'],
 ['Negotiated branch limits|عدد فروع حسب الاتفاق','Dedicated onboarding & migration|إعداد ونقل بيانات مخصص','Custom connectors & AI configuration|تكاملات وإعداد ذكاء اصطناعي مخصص','SLA & account manager|اتفاقية خدمة ومدير حساب','White-label & API access|علامة تجارية خاصة وواجهة برمجية','Custom analytics & permissions|تحليلات وصلاحيات مخصصة','Scoped and quoted separately|يحدد النطاق والسعر بالاتفاق']];

/* Cell values:
   yes / no        included / not included
   planned         on the roadmap, not available today
   quote           Business only: scoped and priced by agreement
   confirm         not stated in the plan copy; needs a decision before launch
   unknown         competitor: not stated on the page we checked
   'text|نص'       a limit, a price or a note */
export const competitor={
 name:'Foodics',
 tier:'Basic package|الباقة الأساسية',
 scope:'Egypt · EGP · billed annually|مصر · بالجنيه المصري · دفع سنوي',
 source:'https://www.foodics.com/ar/foodics-pricing-egypt/',
 checked:'2026-10-06',
 note:'Foodics is a full cloud POS. Resuto is not a POS and does not replace one: it runs reservations, guest ordering, the kitchen board and bill splitting. The two can sit side by side.|فودكس نظام كاشير سحابي كامل. ريسوتو ليس نظام كاشير ولا يحل محله: يدير الحجوزات وطلبات الضيوف وشاشة المطبخ وتقسيم الفاتورة، ويمكن أن يعمل النظامان معًا.'
};

const Q='quote';
export const comparison=[
 {group:'Ordering|الطلبات',rows:[
  ['QR menu and ordering|قائمة وطلبات QR',['yes','yes','yes',Q],'unknown'],
  ['Pickup orders|طلبات الاستلام',['yes','yes','yes',Q],'unknown'],
  ['AI waiter (menu assistant)|النادل الذكي (مساعد القائمة)',['no','yes','yes',Q],'unknown'],
  ['Cloud POS and cashier|نظام كاشير سحابي',['no','no','no','no'],'yes']
 ]},
 {group:'Menu and import|القائمة والاستيراد',rows:[
  ['Menu management|إدارة القائمة',['yes','yes','yes',Q],'yes'],
  ['AI menu import from PDF or photo|استيراد القائمة بالذكاء الاصطناعي من PDF أو صورة',['confirm','confirm','confirm',Q],'unknown'],
  ['CSV menu import|استيراد القائمة من CSV',['confirm','confirm','confirm',Q],'unknown'],
  ['Menu import from Foodics|استيراد القائمة من فودكس',['planned','planned','planned','planned'],'Not applicable|لا ينطبق'],
  ['Inventory|المخزون',['no','yes','yes',Q],'yes'],
  ['Advanced inventory|مخزون متقدم',['no','no','planned',Q],'unknown']
 ]},
 {group:'Kitchen|المطبخ',rows:[
  ['Kitchen display|شاشة المطبخ',['no','yes','yes',Q],'unknown']
 ]},
 {group:'Reservations and floor|الحجوزات والصالة',rows:[
  ['Reservations and floor map|الحجوزات وخريطة المطعم',['yes','yes','yes',Q],'Table management|إدارة الطاولات'],
  ['Premium table selection|اختيار الطاولات المميزة',['no','yes','yes',Q],'unknown']
 ]},
 {group:'Guest payments|مدفوعات الضيوف',rows:[
  ['Split payments|تقسيم الفاتورة',['no','yes','yes',Q],'unknown'],
  ['Guest ratings|تقييمات الضيوف',['yes','yes','yes',Q],'unknown'],
  ['Loyalty, gift cards, coupons and promotions|الولاء وبطاقات الهدايا والكوبونات والعروض',['confirm','confirm','confirm',Q],'yes'],
  ['Card processing|معالجة البطاقات',['Through Stripe or Paymob; their fees are separate|عبر Stripe أو Paymob ورسومهما منفصلة','Through Stripe or Paymob; their fees are separate|عبر Stripe أو Paymob ورسومهما منفصلة','Through Stripe or Paymob; their fees are separate|عبر Stripe أو Paymob ورسومهما منفصلة',Q],'Foodics Pay, a separate product|Foodics Pay، منتج منفصل']
 ]},
 {group:'Integrations|التكاملات',rows:[
  ['Integrations|التكاملات',['no','yes','yes',Q],'App store and delivery apps|متجر التطبيقات وتطبيقات التوصيل'],
  ['Custom connectors and API access|تكاملات مخصصة وواجهة برمجية',['no','no','no',Q],'yes'],
  ['WhatsApp automation|أتمتة واتساب',['planned','planned','planned','planned'],'unknown']
 ]},
 {group:'Reporting|التقارير',rows:[
  ['Dashboard and basic analytics|لوحة إدارة وتحليلات أساسية',['yes','yes','yes',Q],'yes'],
  ['Advanced analytics|تحليلات متقدمة',['no','yes','yes',Q],'BI reports; advanced BI is in the Advanced package|تقارير ذكاء الأعمال؛ المتقدمة في الباقة المطورة'],
  ['AI operational insights|تحليلات تشغيلية ذكية',['no','no','yes',Q],'unknown'],
  ['Custom policies and reports|سياسات وتقارير مخصصة',['no','no','planned',Q],'unknown']
 ]},
 {group:'Team and branches|الفريق والفروع',rows:[
  ['Branches|الفروع',['@branches','@branches','@branches','Negotiated|حسب الاتفاق'],'unknown'],
  ['Extra branch|فرع إضافي',['Add-on · 500 EGP / month|إضافة · ٥٠٠ جنيه شهريًا','Add-on · 500 EGP / month|إضافة · ٥٠٠ جنيه شهريًا','Add-on · 500 EGP / month|إضافة · ٥٠٠ جنيه شهريًا',Q],'unknown'],
  ['Staff accounts|حسابات الموظفين',['@staff','@staff','@staff',Q],'unknown'],
  ['Multi-branch management|إدارة الفروع',['no','no','yes',Q],'unknown'],
  ['Staff permissions and onboarding|صلاحيات وإعداد مخصص',['no','no','planned',Q],'unknown']
 ]},
 {group:'Support|الدعم',rows:[
  ['Priority support|دعم ذو أولوية',['no','yes','yes',Q],'unknown'],
  ['Onboarding|الإعداد',['confirm','confirm','confirm','Dedicated onboarding and migration|إعداد ونقل بيانات مخصص'],'Demo with tailored training|نسخة تجريبية وتدريب مخصص'],
  ['SLA and account manager|اتفاقية خدمة ومدير حساب',['no','no','no',Q],'unknown']
 ]},
 {group:'Commercial terms|الشروط التجارية',rows:[
  ['Monthly price|السعر الشهري',['@monthly','@monthly','@monthly','Custom|حسب الاتفاق'],'EGP 3,019.89 / month, billed quarterly|٣٬٠١٩٫٨٩ جنيه شهريًا بدفع ربع سنوي'],
  ['Yearly billing|الدفع السنوي',['@yearly','@yearly','@yearly','Custom|حسب الاتفاق'],'EGP 2,848.95 / month, billed annually|٢٬٨٤٨٫٩٥ جنيه شهريًا بدفع سنوي'],
  ['Free trial|تجربة مجانية',['14 days, no card|١٤ يومًا بدون بطاقة','14 days, no card|١٤ يومًا بدون بطاقة','14 days, no card|١٤ يومًا بدون بطاقة',Q],'Demo on request|عرض تجريبي عند الطلب'],
  ['Advanced AI|ذكاء اصطناعي متقدم',['Add-on · 400 EGP / month|إضافة · ٤٠٠ جنيه شهريًا','Add-on · 400 EGP / month|إضافة · ٤٠٠ جنيه شهريًا','Add-on · 400 EGP / month|إضافة · ٤٠٠ جنيه شهريًا',Q],'unknown'],
  ['Price basis (per branch or per account)|أساس السعر (لكل فرع أو لكل حساب)',['confirm','confirm','confirm',Q],'unknown'],
  ['VAT|ضريبة القيمة المضافة',['confirm','confirm','confirm','confirm'],'unknown'],
  ['After the trial ends|بعد انتهاء التجربة',['confirm','confirm','confirm',Q],'unknown'],
  ['Hardware|الأجهزة',['None required: runs in a browser|غير مطلوبة: يعمل في المتصفح','None required: runs in a browser|غير مطلوبة: يعمل في المتصفح','None required: runs in a browser|غير مطلوبة: يعمل في المتصفح','None required: runs in a browser|غير مطلوبة: يعمل في المتصفح'],'Quoted with the equipment you need|تُسعَّر حسب التجهيزات المطلوبة']
 ]}
];

/* Questions people ask before choosing a plan. Shown on /pricing and published
   as FAQ structured data, so every answer must stay true to the product. */
export const faq=[
 ['How much does Resuto cost?|كم سعر ريسوتو؟','Starter is 799 EGP a month, Growth is 1,499 EGP and Pro is 2,999 EGP. Paying yearly costs ten months instead of twelve. Business is priced by agreement.|Starter بسعر ٧٩٩ جنيهًا شهريًا، وGrowth بسعر ١٬٤٩٩ جنيهًا، وPro بسعر ٢٬٩٩٩ جنيهًا. الدفع السنوي يساوي عشرة أشهر بدل اثني عشر. وخطة Business بسعر حسب الاتفاق.'],
 ['Is there a free trial?|هل توجد تجربة مجانية؟','Yes. Every priced plan starts with a 14-day trial and you do not need a card to create the workspace.|نعم. كل خطة مسعّرة تبدأ بتجربة ١٤ يومًا، ولا تحتاج بطاقة لإنشاء مساحة العمل.'],
 ['Will I be charged when the trial ends?|هل سيُخصم مني عند انتهاء التجربة؟','Not at the moment. Subscription billing is not enabled yet, so nothing is charged. How the trial converts to a paid plan is still to be confirmed.|ليس حاليًا. فوترة الاشتراكات غير مفعّلة بعد، فلا يُخصم أي مبلغ. وطريقة التحول من التجربة إلى خطة مدفوعة ما زالت تحتاج إلى تأكيد.'],
 ['Does Resuto replace my POS?|هل يغني ريسوتو عن نظام الكاشير؟','No. Resuto is not a cashier or POS system. It runs reservations, QR ordering, the kitchen board, bill splitting and a manager view, and it can sit beside a POS such as Foodics.|لا. ريسوتو ليس نظام كاشير. هو يدير الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة وشاشة المدير، ويمكن أن يعمل بجانب نظام كاشير مثل فودكس.'],
 ['Which payment methods can guests use?|ما طرق الدفع المتاحة للضيوف؟','Guests can pay by card through Stripe or Paymob once you add your own keys. Their processing fees are charged by them and are not part of the Resuto subscription.|يمكن للضيوف الدفع بالبطاقة عبر Stripe أو Paymob بعد إضافة مفاتيحك. رسوم المعالجة يحصّلها المزوّد وليست جزءًا من اشتراك ريسوتو.'],
 ['Do I need any hardware?|هل أحتاج إلى أجهزة؟','No. Resuto runs in a browser on the phones, tablets and screens you already have, and guests order from their own phones.|لا. ريسوتو يعمل في المتصفح على الهواتف والأجهزة اللوحية والشاشات المتوفرة لديك، والضيوف يطلبون من هواتفهم.'],
 ['Does it work in Arabic?|هل يعمل بالعربية؟','Yes. Every screen works in Arabic and English, for guests and for staff, including right-to-left layout.|نعم. كل الشاشات تعمل بالعربية والإنجليزية للضيوف والموظفين، مع دعم الاتجاه من اليمين إلى اليسار.'],
 ['Can I import my existing menu?|هل يمكنني استيراد قائمتي الحالية؟','Yes. Upload a PDF, a photo or a CSV file and Resuto drafts the dishes and prices in both languages. You review and approve every item before it is published. Reading a PDF or photo needs a Google Gemini key.|نعم. ارفع ملف PDF أو صورة أو ملف CSV وسيعدّ ريسوتو مسودة بالأصناف والأسعار باللغتين. تراجع وتعتمد كل صنف قبل نشره. قراءة PDF أو الصور تحتاج مفتاح Google Gemini.']
];

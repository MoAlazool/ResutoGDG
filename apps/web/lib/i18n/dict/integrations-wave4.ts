// Wave-4 provider strings (ws7b): routing, tracking sinks, POS OAuth, accounting, tax, notification channels, push.
// Keys exist in both languages; provider names, keys, URLs and ids stay Latin and are isolated in the UI.
export const integrationsWave4 = {
  en: {
    'intg.field.googleRoutesKey': 'Google Maps Platform API key (Routes API)',
    'intg.field.dailyRequestCap': 'Daily request cap',
    'marketing.consent.bodyPartners': 'With your permission, this restaurant shares the orders you place here with its advertising partners ({partners}) to see which ads bring orders. Your email and phone are shared only in hashed form. You can say no and order the same way.',
    'intg.field.tiktokEventsToken': 'Events API access token', 'intg.field.tiktokPixelCode': 'Pixel code', 'intg.field.tiktokTestEventCode': 'Test event code',
    'intg.field.tiktokTestEventCodeHint': 'Events Manager > the Pixel > Test events. Test connections send it with every event; the health check uses it on Live too, so checks never count as conversions.',
    'intg.field.snapCapiToken': 'Conversions API token', 'intg.field.snapPixelId': 'Snap Pixel id', 'intg.field.snapTestEventCode': 'Test event code (optional, test connections only)',
    'intg.field.dailyRequestCapHint': 'Resuto makes at most this many Routes requests per day (default 300), then uses the offline estimate.',
  },
  ar: {
    'intg.field.googleRoutesKey': 'مفتاح Google Maps Platform (واجهة Routes)',
    'intg.field.dailyRequestCap': 'الحد اليومي للطلبات',
    'marketing.consent.bodyPartners': 'بإذنك، يشارك هذا المطعم الطلبات التي تضعها هنا مع شركائه الإعلانيين ({partners}) لمعرفة أي الإعلانات تجلب الطلبات. لا تتم مشاركة بريدك وهاتفك إلا بصيغة مُشفَّرة (hash). يمكنك الرفض والطلب بالطريقة نفسها.',
    'intg.field.tiktokEventsToken': 'رمز وصول Events API', 'intg.field.tiktokPixelCode': 'رمز البكسل', 'intg.field.tiktokTestEventCode': 'رمز حدث الاختبار',
    'intg.field.tiktokTestEventCodeHint': 'مدير الأحداث > البكسل > أحداث الاختبار. ترسله اتصالات الاختبار مع كل حدث، ويستخدمه فحص الحالة في الوضع المباشر أيضًا حتى لا يُحتسب الفحص تحويلًا.',
    'intg.field.snapCapiToken': 'رمز واجهة التحويلات', 'intg.field.snapPixelId': 'معرّف بكسل Snap', 'intg.field.snapTestEventCode': 'رمز حدث الاختبار (اختياري، لاتصالات الاختبار فقط)',
    'intg.field.dailyRequestCapHint': 'يرسل ريسوتو هذا العدد من طلبات Routes يوميًا على الأكثر (الافتراضي 300)، ثم يستخدم التقدير دون اتصال.',
  },
} as const;

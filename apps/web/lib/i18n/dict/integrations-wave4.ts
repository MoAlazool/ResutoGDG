// Wave-4 provider strings (ws7b): routing, tracking sinks, POS OAuth, accounting, tax, notification channels, push.
// Keys exist in both languages; provider names, keys, URLs and ids stay Latin and are isolated in the UI.
export const integrationsWave4 = {
  en: {
    'intg.field.googleRoutesKey': 'Google Maps Platform API key (Routes API)',
    'intg.field.dailyRequestCap': 'Daily request cap',
    'intg.field.dailyRequestCapHint': 'Resuto makes at most this many Routes requests per day (default 300), then uses the offline estimate.',
  },
  ar: {
    'intg.field.googleRoutesKey': 'مفتاح Google Maps Platform (واجهة Routes)',
    'intg.field.dailyRequestCap': 'الحد اليومي للطلبات',
    'intg.field.dailyRequestCapHint': 'يرسل ريسوتو هذا العدد من طلبات Routes يوميًا على الأكثر (الافتراضي 300)، ثم يستخدم التقدير دون اتصال.',
  },
} as const;

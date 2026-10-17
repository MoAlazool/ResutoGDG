// Restaurant settings strings (owner: Agent A).
const en = {
  title: 'Restaurant settings', subtitle: 'Profile, legal details, branches and your launch checklist.',
  profile: 'Restaurant profile', name: 'Restaurant name', nameAr: 'Arabic name', locale: 'Default language', english: 'English', arabic: 'Arabic',
  timezone: 'Time zone', legalName: 'Legal name', taxNumber: 'Tax registration number', crNumber: 'Commercial registration', countryLocked: 'Country and currency: {country} · {currency} (fixed after signup)',
  save: 'Save', saving: 'Saving…', saved: 'Saved',
  branches: 'Branches', addBranch: 'Add branch', editBranch: 'Edit branch', code: 'Code', address: 'Address', city: 'City', phone: 'Phone',
  services: 'Services', dineIn: 'Dine-in', pickup: 'Pickup', delivery: 'Delivery', reservations: 'Reservations', deliveryFee: 'Delivery fee ({currency})',
  minOrder: 'Minimum order ({currency})', active: 'Branch is active', inactive: 'Inactive', cancel: 'Cancel', limitHit: 'Your plan’s branch limit is reached.', upgrade: 'See plans',
  checklist: 'Launch checklist', checklistSub: 'Work through these to go live. Steps are marked done automatically or by you.',
  st_profile: 'Complete your restaurant profile', st_branch: 'Check your branch details and hours', st_menu: 'Build your menu', st_floor: 'Draw your floor and print table QR codes',
  st_website: 'Publish your website', st_payments: 'Connect online payments', st_launched: 'Launch — open for orders',
  open: 'Open', markDone: 'Mark done', done: 'Done', launchedNote: 'Launching moves the restaurant from onboarding to active.',
  loadError: 'Could not load settings.', retry: 'Retry', noAccess: 'Only the owner or an admin can change restaurant settings.',
};
type S = typeof en;
const ar: S = {
  title: 'إعدادات المطعم', subtitle: 'الملف والبيانات القانونية والفروع وقائمة الإطلاق.',
  profile: 'ملف المطعم', name: 'اسم المطعم', nameAr: 'الاسم بالعربية', locale: 'اللغة الافتراضية', english: 'الإنجليزية', arabic: 'العربية',
  timezone: 'المنطقة الزمنية', legalName: 'الاسم القانوني', taxNumber: 'رقم التسجيل الضريبي', crNumber: 'السجل التجاري', countryLocked: 'الدولة والعملة: {country} · {currency} (ثابتة بعد التسجيل)',
  save: 'حفظ', saving: 'جارٍ الحفظ…', saved: 'تم الحفظ',
  branches: 'الفروع', addBranch: 'إضافة فرع', editBranch: 'تعديل الفرع', code: 'الرمز', address: 'العنوان', city: 'المدينة', phone: 'الهاتف',
  services: 'الخدمات', dineIn: 'تناول في المطعم', pickup: 'استلام', delivery: 'توصيل', reservations: 'حجوزات', deliveryFee: 'رسوم التوصيل ({currency})',
  minOrder: 'الحد الأدنى للطلب ({currency})', active: 'الفرع نشط', inactive: 'غير نشط', cancel: 'إلغاء', limitHit: 'تم بلوغ حد الفروع في خطتك.', upgrade: 'عرض الخطط',
  checklist: 'قائمة الإطلاق', checklistSub: 'أكمل هذه الخطوات لبدء العمل. تُعلَّم الخطوات تلقائيًا أو يدويًا.',
  st_profile: 'أكمل ملف المطعم', st_branch: 'راجع بيانات الفرع ومواعيده', st_menu: 'أنشئ قائمتك', st_floor: 'ارسم الصالة واطبع رموز QR للطاولات',
  st_website: 'انشر موقعك', st_payments: 'اربط المدفوعات الإلكترونية', st_launched: 'الإطلاق — ابدأ استقبال الطلبات',
  open: 'فتح', markDone: 'تعليم كمكتمل', done: 'مكتمل', launchedNote: 'الإطلاق ينقل المطعم من مرحلة الإعداد إلى نشط.',
  loadError: 'تعذّر تحميل الإعدادات.', retry: 'إعادة المحاولة', noAccess: 'يمكن للمالك أو المسؤول فقط تغيير إعدادات المطعم.',
};
export const SETTINGS_STRINGS = { en, ar };

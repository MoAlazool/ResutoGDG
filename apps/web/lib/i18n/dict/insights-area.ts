// UI strings of the Insights area (21-INSIGHTS): section names, the toolbar and saved reports. Keys prefixed
// "insights.area." and "insights.report.". Western digits in both languages (lib/digits-policy.test.ts).
const en: Record<string, string> = {
  'insights.area.overview': 'Overview', 'insights.area.sales': 'Sales', 'insights.area.menu': 'Menu performance',
  'insights.area.customers': 'Customers', 'insights.area.ratings': 'Ratings', 'insights.area.marketing': 'Marketing',
  'insights.area.operations': 'Operations', 'insights.area.sustainability': 'Sustainability', 'insights.area.roi': 'ROI calculator',
  'insights.area.findings': 'Findings', 'insights.area.forecast': 'Forecast', 'insights.area.recommendations': 'Recommendations',
  'insights.area.research': 'Research', 'insights.area.routes': 'Routes',
  'insights.area.toolbar': 'Period and saved reports',
  'insights.area.compareLastYear': 'Compared with {from} – {to} (the same dates last year).',
  'insights.area.series.lastYear': 'Same period last year',
  'insights.area.openMenu': 'Menu performance', 'insights.area.openSales': 'Sales', 'insights.area.qty': '{n, plural, one {# sold} other {# sold}}',
  'insights.area.openIn': 'Open in Insights',

  'insights.report.list': 'Saved reports', 'insights.report.none': 'No saved reports yet. Open a view, choose its period, then "Save view".',
  'insights.report.hint': 'Each report reopens its view, period, comparison, branch and filters.',
  'insights.report.mine': 'Mine', 'insights.report.sharedWithMe': 'Shared by colleagues', 'insights.report.manage': 'Manage saved reports',
  'insights.report.save': 'Save view', 'insights.report.saveConfirm': 'Save report', 'insights.report.name': 'Report name',
  'insights.report.share': 'Share with the team', 'insights.report.shareHint': 'Colleagues who can see analytics can open it; only you can change it.',
  'insights.report.branchOne': 'Saved for the branch selected in the switcher.', 'insights.report.branchAll': 'Saved for all branches.',
  'insights.report.open': 'Open report', 'insights.report.sharedBadge': 'Shared', 'insights.report.by': 'by {name}',
  'insights.report.shareAction': 'Share', 'insights.report.unshare': 'Stop sharing',
  'insights.report.deleteTitle': 'Delete "{name}"?', 'insights.report.deleteBody': 'The report is removed for you and anyone you shared it with. Your data is not affected.',
};

const ar: Record<string, string> = {
  'insights.area.overview': 'نظرة عامة', 'insights.area.sales': 'المبيعات', 'insights.area.menu': 'أداء القائمة',
  'insights.area.customers': 'العملاء', 'insights.area.ratings': 'التقييمات', 'insights.area.marketing': 'التسويق',
  'insights.area.operations': 'التشغيل', 'insights.area.sustainability': 'الاستدامة', 'insights.area.roi': 'حاسبة العائد على الاستثمار',
  'insights.area.findings': 'الملاحظات', 'insights.area.forecast': 'التوقعات', 'insights.area.recommendations': 'التوصيات',
  'insights.area.research': 'نتائج البحث', 'insights.area.routes': 'مسارات التوصيل',
  'insights.area.toolbar': 'الفترة والتقارير المحفوظة',
  'insights.area.compareLastYear': 'مقارنة مع {from} – {to} (نفس التواريخ من العام الماضي).',
  'insights.area.series.lastYear': 'نفس الفترة من العام الماضي',
  'insights.area.openMenu': 'أداء القائمة', 'insights.area.openSales': 'المبيعات', 'insights.area.qty': '{n, plural, zero {لم يُبع} one {بيعت قطعة واحدة} two {بيعت قطعتان} few {بيعت # قطع} many {بيعت # قطعة} other {بيعت # قطعة}}',
  'insights.area.openIn': 'افتح في الرؤى',

  'insights.report.list': 'التقارير المحفوظة', 'insights.report.none': 'لا توجد تقارير محفوظة بعد. افتح عرضًا واختر فترته ثم «احفظ العرض».',
  'insights.report.hint': 'كل تقرير يعيد فتح عرضه وفترته ومقارنته وفرعه وعوامل التصفية.',
  'insights.report.mine': 'تقاريري', 'insights.report.sharedWithMe': 'شاركها الزملاء', 'insights.report.manage': 'إدارة التقارير المحفوظة',
  'insights.report.save': 'احفظ العرض', 'insights.report.saveConfirm': 'احفظ التقرير', 'insights.report.name': 'اسم التقرير',
  'insights.report.share': 'شارك مع الفريق', 'insights.report.shareHint': 'يمكن للزملاء الذين يرون التحليلات فتحه، ولا يعدّله أحد غيرك.',
  'insights.report.branchOne': 'يُحفظ للفرع المختار في مبدّل الفروع.', 'insights.report.branchAll': 'يُحفظ لكل الفروع.',
  'insights.report.open': 'افتح التقرير', 'insights.report.sharedBadge': 'مُشارَك', 'insights.report.by': 'من {name}',
  'insights.report.shareAction': 'شارك', 'insights.report.unshare': 'أوقف المشاركة',
  'insights.report.deleteTitle': 'حذف «{name}»؟', 'insights.report.deleteBody': 'يُحذف التقرير لك ولكل من شاركته معه. لا تتأثر بياناتك.',
};

export const insightsArea = { en, ar };

// UI strings of the 21-OPS operations redesign: the Orders board and kitchen display keys, bulk moves, the full-screen
// kitchen display, front-of-house sections, the reservation timeline, dispatch and inventory. Keys exist in both
// languages; numbers are formatted by the caller (Western digits).

const en: Record<string, string> = {
  'ops.orders.view': 'View',
  'ops.board.key.next': 'Next order', 'ops.board.key.prev': 'Previous order', 'ops.board.key.open': 'Open the order',
  'ops.board.key.bump': 'Move to the next step', 'ops.board.key.select': 'Select for a bulk move',
  'ops.board.hintMove': 'move', 'ops.board.hintOpen': 'open', 'ops.board.hintBump': 'next step', 'ops.board.hintPick': 'pick a ticket',
  'ops.board.selectOrder': 'Select order #{number}', 'ops.board.bulk': 'Selected orders',
  'ops.board.selected': '{n, plural, one {# order selected} other {# orders selected}}',
  'ops.board.advanceSelected': 'Move to next step', 'ops.board.clear': 'Clear',
  'ops.board.bulkDone': '{n, plural, one {# order moved to its next step.} other {# orders moved to their next step.}}',
  'ops.board.bulkSome': '{ok} moved, {failed} not moved: {error}',
  'ops.kds.keys': 'Keyboard and bump bar',
  'ops.kds.keys.pick': '1 to 9: pick that ticket (counted across the open lanes)',
  'ops.kds.keys.move': 'Arrow keys or j and k: move between tickets and lanes',
  'ops.kds.keys.bump': 'Enter, Space or b: move the ticket to its next step',
  'ops.kds.back': 'Back to the workspace',
  'ops.foh.nav': 'Front of house', 'ops.floor.areas': 'Floor areas',
  'ops.res.timeline': 'Timeline', 'ops.res.noTable': 'No table yet', 'ops.res.code': 'Booking code',
  'ops.res.prevDay': 'Previous day', 'ops.res.nextDay': 'Next day', 'ops.res.today': 'Today',
  'ops.inv.search': 'Search stock items',
  'ops.walkin.soon': 'Next to free up','ops.walkin.soonHint': 'These tables fit the party and are closest to free. Quote the wait from here.',
};

const ar: Record<string, string> = {
  'ops.orders.view': 'العرض',
  'ops.board.key.next': 'الطلب التالي', 'ops.board.key.prev': 'الطلب السابق', 'ops.board.key.open': 'فتح الطلب',
  'ops.board.key.bump': 'نقل إلى الخطوة التالية', 'ops.board.key.select': 'تحديد للنقل الجماعي',
  'ops.board.hintMove': 'تنقّل', 'ops.board.hintOpen': 'فتح', 'ops.board.hintBump': 'الخطوة التالية', 'ops.board.hintPick': 'اختيار تذكرة',
  'ops.board.selectOrder': 'تحديد الطلب رقم {number}', 'ops.board.bulk': 'الطلبات المحددة',
  'ops.board.selected': '{n, plural, one {تم تحديد طلب واحد} two {تم تحديد طلبين} few {تم تحديد # طلبات} many {تم تحديد # طلبًا} other {تم تحديد # طلب}}',
  'ops.board.advanceSelected': 'نقل إلى الخطوة التالية', 'ops.board.clear': 'إلغاء',
  'ops.board.bulkDone': '{n, plural, one {نُقل طلب واحد إلى خطوته التالية.} two {نُقل طلبان إلى خطوتهما التالية.} few {نُقلت # طلبات إلى خطواتها التالية.} many {نُقل # طلبًا إلى خطواتها التالية.} other {نُقل # طلب إلى خطواتها التالية.}}',
  'ops.board.bulkSome': 'نُقل {ok}، ولم يُنقل {failed}: {error}',
  'ops.kds.keys': 'لوحة المفاتيح ولوحة الإنهاء',
  'ops.kds.keys.pick': 'من 1 إلى 9: اختيار تلك التذكرة (بالعدّ عبر الأعمدة المفتوحة)',
  'ops.kds.keys.move': 'الأسهم أو j و k: التنقل بين التذاكر والأعمدة',
  'ops.kds.keys.bump': 'Enter أو المسافة أو b: نقل التذكرة إلى خطوتها التالية',
  'ops.kds.back': 'العودة إلى مساحة العمل',
  'ops.foh.nav': 'الصالة والاستقبال', 'ops.floor.areas': 'مناطق الصالة',
  'ops.res.timeline': 'المخطط الزمني', 'ops.res.noTable': 'بدون طاولة بعد', 'ops.res.code': 'رمز الحجز',
  'ops.res.prevDay': 'اليوم السابق', 'ops.res.nextDay': 'اليوم التالي', 'ops.res.today': 'اليوم',
  'ops.inv.search': 'ابحث في أصناف المخزون',
  'ops.walkin.soon': 'الأقرب للتفرّغ','ops.walkin.soonHint': 'هذه الطاولات تتسع للمجموعة وهي الأقرب للتفرّغ. حدّد وقت الانتظار من هنا.',
};

export const opsBoard = { en, ar };

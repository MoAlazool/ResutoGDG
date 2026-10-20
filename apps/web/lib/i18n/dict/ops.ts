// UI strings for the operations screens restored from the original workspace (ws5): kitchen board, service requests,
// sold out, floor overview, front desk, active visits, overview, settings service model, guided setup, import & export.
// Keys are prefixed "ops." and exist in both languages. Arabic copy follows legacy/public (tr(...) pairs) where the
// legacy app had it.

const en: Record<string, string> = {
  // Kitchen board
  'ops.kds.lane.new': 'New orders', 'ops.kds.lane.preparing': 'Preparing', 'ops.kds.lane.ready': 'Ready to serve',
  'ops.kds.lane.out': 'On the way', 'ops.kds.lane.done': 'Completed',
  'ops.kds.hint': 'Drag a card between columns to advance it.',
  'ops.kds.forwardOnly': 'An order can only move forward. {lane} is not a valid next step.',
  'ops.kds.moved': 'Order moved to {lane}',
  'ops.kds.markReady': 'Mark ready',
  'ops.kds.handOver.dine_in': 'Mark served', 'ops.kds.handOver.pickup': 'Mark picked up', 'ops.kds.handOver.delivery': 'Send for delivery',
  'ops.kds.markDelivered': 'Mark delivered', 'ops.kds.withDriver': 'With the driver',
  'ops.kds.cashDue': 'Cash due {amount}: record it on the order before marking it delivered', 'ops.kds.openOrders': 'Open orders',
  'ops.kds.cancelTitle': 'Cancel order #{number}', 'ops.kds.cancelled': 'Order #{number} cancelled',
  'ops.kds.counter': 'Counter', 'ops.kds.placedAt': 'Placed at {time}', 'ops.kds.soldOut': 'Sold out items',
  // Service requests
  'ops.req.title': 'Service requests', 'ops.req.resolve': 'Resolve', 'ops.req.done': 'Done',
  'ops.req.caughtUp': 'You’re all caught up', 'ops.req.caughtUpHint': 'New guest requests appear here.',
  'ops.req.kind.waiter': 'Waiter requested', 'ops.req.kind.bill': 'Bill requested', 'ops.req.kind.help': 'Help requested',
  // Sold out (86)
  'ops.soldOut.title': 'Sold out today', 'ops.soldOut.hint': 'Guests still see these dishes, marked sold out, until you turn them back on or the day ends.',
  'ops.soldOut.search': 'Find a dish', 'ops.soldOut.mark': 'Sold out', 'ops.soldOut.restore': 'Back on',
  'ops.soldOut.until': 'Sold out until {time}', 'ops.soldOut.untilCleared': 'Sold out until turned back on',
};

const ar: Record<string, string> = {
  'ops.kds.lane.new': 'طلبات جديدة', 'ops.kds.lane.preparing': 'تحت التحضير', 'ops.kds.lane.ready': 'جاهز للتقديم',
  'ops.kds.lane.out': 'في الطريق', 'ops.kds.lane.done': 'مكتمل',
  'ops.kds.hint': 'اسحب البطاقة بين الأعمدة لتحديث حالتها.',
  'ops.kds.forwardOnly': 'الطلب يتحرك للأمام فقط. {lane} ليست الخطوة التالية.',
  'ops.kds.moved': 'تم نقل الطلب إلى {lane}',
  'ops.kds.markReady': 'جاهز',
  'ops.kds.handOver.dine_in': 'تم التقديم', 'ops.kds.handOver.pickup': 'تم الاستلام', 'ops.kds.handOver.delivery': 'إرسال للتوصيل',
  'ops.kds.markDelivered': 'تم التوصيل', 'ops.kds.withDriver': 'مع السائق',
  'ops.kds.cashDue': 'مبلغ نقدي مستحق {amount}: سجّله على الطلب قبل تأكيد التوصيل', 'ops.kds.openOrders': 'فتح الطلبات',
  'ops.kds.cancelTitle': 'إلغاء الطلب رقم {number}', 'ops.kds.cancelled': 'تم إلغاء الطلب رقم {number}',
  'ops.kds.counter': 'الكاونتر', 'ops.kds.placedAt': 'وقت الطلب {time}', 'ops.kds.soldOut': 'الأصناف النافدة',
  'ops.req.title': 'طلبات الخدمة', 'ops.req.resolve': 'تم', 'ops.req.done': 'تم',
  'ops.req.caughtUp': 'لا توجد طلبات معلّقة', 'ops.req.caughtUpHint': 'تظهر طلبات الضيوف الجديدة هنا.',
  'ops.req.kind.waiter': 'طلب نادل', 'ops.req.kind.bill': 'طلب الحساب', 'ops.req.kind.help': 'طلب مساعدة',
  'ops.soldOut.title': 'نفد اليوم', 'ops.soldOut.hint': 'يظل الضيوف يرون هذه الأطباق مكتوبًا عليها «نفد» حتى تعيد تفعيلها أو ينتهي اليوم.',
  'ops.soldOut.search': 'ابحث عن طبق', 'ops.soldOut.mark': 'نفد', 'ops.soldOut.restore': 'متاح مجددًا',
  'ops.soldOut.until': 'نفد حتى {time}', 'ops.soldOut.untilCleared': 'نفد حتى إعادة التفعيل',
};

export const ops = { en, ar };

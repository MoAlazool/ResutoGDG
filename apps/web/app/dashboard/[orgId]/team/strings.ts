// Team page strings (owner: Agent A).
import type { Role } from '@resuto/contracts';

const en = {
  title: 'Team', subtitle: 'Invite staff, choose their role and the branches they work in.',
  invite: 'Invite a team member', email: 'Email', phone: 'Phone (international, optional)', role: 'Role', branches: 'Branches', allBranches: 'All branches',
  someBranches: 'Only selected branches', send: 'Create invitation', sending: 'Creating…', contactRequired: 'Enter an email or a phone number.',
  linkReady: 'Invitation created. Share this link with {who} — it is shown only once and expires on {date}.', copy: 'Copy link', copied: 'Copied',
  members: 'Members', pending: 'Pending invitations', noPending: 'No pending invitations.', name: 'Name', status: 'Status', actions: 'Actions',
  you: 'You', owner: 'Owner', suspend: 'Suspend', reactivate: 'Reactivate', remove: 'Remove', removeConfirm: 'Remove {name} from this restaurant?',
  st_active: 'Active', st_suspended: 'Suspended', st_invited: 'Invited', st_removed: 'Removed', expires: 'Expires {date}', saved: 'Saved',
  limitHit: 'Your plan’s staff limit is reached.', upgrade: 'See plans', cannotAssign: 'Your role cannot invite or change members.',
  editBranches: 'Branches', save: 'Save', cancel: 'Cancel', loadError: 'Could not load the team.', retry: 'Retry',
  driverHint: 'Drivers use the Resuto Driver web app and do not count towards staff limits.',
};
type S = typeof en;
const ar: S = {
  title: 'الفريق', subtitle: 'ادعُ الموظفين واختر دورهم والفروع التي يعملون بها.',
  invite: 'دعوة عضو في الفريق', email: 'البريد الإلكتروني', phone: 'الهاتف (بالصيغة الدولية، اختياري)', role: 'الدور', branches: 'الفروع', allBranches: 'كل الفروع',
  someBranches: 'الفروع المحددة فقط', send: 'إنشاء الدعوة', sending: 'جارٍ الإنشاء…', contactRequired: 'أدخل بريدًا إلكترونيًا أو رقم هاتف.',
  linkReady: 'تم إنشاء الدعوة. شارك هذا الرابط مع {who} — يظهر مرة واحدة فقط وينتهي في {date}.', copy: 'نسخ الرابط', copied: 'تم النسخ',
  members: 'الأعضاء', pending: 'دعوات معلّقة', noPending: 'لا توجد دعوات معلّقة.', name: 'الاسم', status: 'الحالة', actions: 'إجراءات',
  you: 'أنت', owner: 'المالك', suspend: 'إيقاف', reactivate: 'إعادة تفعيل', remove: 'إزالة', removeConfirm: 'إزالة {name} من هذا المطعم؟',
  st_active: 'نشط', st_suspended: 'موقوف', st_invited: 'مدعو', st_removed: 'محذوف', expires: 'تنتهي {date}', saved: 'تم الحفظ',
  limitHit: 'تم بلوغ حد الموظفين في خطتك.', upgrade: 'عرض الخطط', cannotAssign: 'دورك لا يسمح بدعوة الأعضاء أو تعديلهم.',
  editBranches: 'الفروع', save: 'حفظ', cancel: 'إلغاء', loadError: 'تعذّر تحميل الفريق.', retry: 'إعادة المحاولة',
  driverHint: 'يستخدم السائقون تطبيق ريسوتو للسائق على الويب ولا يُحتسبون ضمن حد الموظفين.',
};
export const TEAM_STRINGS = { en, ar };

export const ROLE_LABELS: Record<'en' | 'ar', Record<Role, string>> = {
  en: { owner: 'Owner', admin: 'Admin', manager: 'Manager', cashier: 'Cashier', waiter: 'Waiter', kitchen: 'Kitchen', host: 'Host', marketing: 'Marketing', accountant: 'Accountant', driver: 'Driver' },
  ar: { owner: 'المالك', admin: 'مسؤول', manager: 'مدير', cashier: 'كاشير', waiter: 'نادل', kitchen: 'المطبخ', host: 'الاستقبال', marketing: 'التسويق', accountant: 'محاسب', driver: 'سائق' },
};

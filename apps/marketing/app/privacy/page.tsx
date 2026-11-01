'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function Privacy() {
  return <BilingualPage eyebrow={['Legal', 'قانوني']} title={['Privacy Policy', 'سياسة الخصوصية']} intro={['Effective 1 November 2026. This policy covers the public website at resuto.app.', 'سارية من 1 نوفمبر 2026. تغطي هذه السياسة الموقع العام على resuto.app.']}>
    {(ar) => <div className="mk-copy">
      <section><h2>{ar ? 'نطاق هذه السياسة' : 'Scope'}</h2><p>{ar ? 'ينطبق هذا النص على صفحات التسويق العامة فقط. خدمات المطاعم التي تعمل عبر ريسوتو قد تعرض إشعارات خصوصية إضافية تخص المطعم المشغّل.' : 'This notice applies to the public marketing pages only. Restaurant services powered by Resuto may present additional privacy notices from the restaurant operating them.'}</p></section>
      <section><h2>{ar ? 'البيانات التي نعالجها' : 'Data we process'}</h2><p>{ar ? 'لا يحتوي الموقع الثابت على حسابات أو تسجيل دخول أو نماذج تُرسل إلى خادم. عند مراسلتنا بالبريد، نعالج عنوانك ومحتوى الرسالة للرد على استفسارك. قد تسجل Cloudflare بيانات تقنية وأمنية قياسية مثل عنوان IP ونوع المتصفح وفق إعدادات الاستضافة.' : 'The static site has no accounts, login or forms that submit to a server. If you email us, we process your address and message content to answer your inquiry. Cloudflare may process standard technical and security data such as IP address and browser type as part of hosting.'}</p></section>
      <section><h2>{ar ? 'الأغراض والاحتفاظ' : 'Purpose and retention'}</h2><p>{ar ? 'نستخدم رسائل التواصل للرد على الطلبات وتقييم فرص المبيعات أو الشراكات والاحتفاظ بسجل تجاري مناسب. نحتفظ بها فقط للمدة اللازمة لهذه الأغراض أو للالتزامات القانونية.' : 'We use contact emails to respond, evaluate sales or partnership opportunities, and maintain appropriate business records. We retain them only as long as needed for those purposes or legal obligations.'}</p></section>
      <section><h2>{ar ? 'حقوقك والتواصل' : 'Your choices and contact'}</h2><p>{ar ? 'يمكنك طلب الوصول إلى بيانات مراسلاتك أو تصحيحها أو حذفها، بحسب القانون المنطبق، عبر' : 'You may request access, correction or deletion of your inquiry data, subject to applicable law, at'} <a href="mailto:contact@resuto.app">contact@resuto.app</a>.</p></section>
    </div>}
  </BilingualPage>;
}

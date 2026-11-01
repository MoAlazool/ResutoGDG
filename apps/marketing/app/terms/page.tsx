'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function Terms() {
  return <BilingualPage eyebrow={['Legal', 'قانوني']} title={['Website Terms', 'شروط الموقع']} intro={['Effective 1 November 2026. These terms govern use of Resuto’s public marketing website.', 'سارية من 1 نوفمبر 2026. تحكم هذه الشروط استخدام موقع ريسوتو التسويقي العام.']}>
    {(ar) => <div className="mk-copy">
      <section><h2>{ar ? 'المعلومات العامة' : 'Public information'}</h2><p>{ar ? 'محتوى الموقع للتعريف بالمنتج وليس عرضًا ملزمًا. يخضع توفر المنتج والتطبيق والتكاملات والتسعير النهائي لاتفاق مكتوب مع ريسوتو.' : 'Site content describes the product and is not a binding offer. Product availability, implementation, integrations and final pricing are subject to a written agreement with Resuto.'}</p></section>
      <section><h2>{ar ? 'التسعير ومزودو الخدمات' : 'Pricing and providers'}</h2><p>{ar ? 'الأسعار المنشورة أسعار إطلاق قابلة للتحديث. رسوم بوابات الدفع والتوصيل وواتساب والرسائل والإعلانات تفرضها الجهات المزودة وليست ضمن اشتراك ريسوتو ما لم يُذكر خلاف ذلك كتابةً.' : 'Published prices are launch prices and may be updated. Payment gateway, delivery, WhatsApp, SMS and advertising fees are charged by their providers and are not included in a Resuto subscription unless agreed in writing.'}</p></section>
      <section><h2>{ar ? 'الملكية والاستخدام المقبول' : 'Ownership and acceptable use'}</h2><p>{ar ? 'العلامات والتصميمات والنصوص والبرمجيات تخص ريسوتو أو مرخصيها. لا يجوز إساءة استخدام الموقع أو محاولة الوصول إلى أنظمة غير عامة أو تعطيل الخدمة.' : 'Brand assets, designs, text and software belong to Resuto or its licensors. You may not misuse the site, attempt to access non-public systems or disrupt the service.'}</p></section>
      <section><h2>{ar ? 'إخلاء المسؤولية والتواصل' : 'Disclaimer and contact'}</h2><p>{ar ? 'يُقدّم الموقع العام كما هو بالقدر الذي يسمح به القانون. للاستفسارات حول هذه الشروط تواصل عبر' : 'The public site is provided as-is to the extent permitted by law. Questions about these terms may be sent to'} <a href="mailto:contact@resuto.app">contact@resuto.app</a>.</p></section>
    </div>}
  </BilingualPage>;
}

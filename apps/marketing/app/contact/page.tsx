'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function Contact() {
  return <BilingualPage eyebrow={['Contact', 'تواصل معنا']} title={['Let’s shape your Resuto setup.', 'لنصمم إعداد ريسوتو المناسب لك.']} intro={['Tell us about your restaurant, branches and the workflows you want to connect. A real person will reply by email.', 'أخبرنا عن مطعمك وفروعك ومسارات العمل التي تريد ربطها. سيرد عليك شخص من الفريق عبر البريد.']}>
    {(ar) => <div className="mk-grid">
      <article className="mk-card"><h2>{ar ? 'طلبات الوصول والتواصل التجاري' : 'Access requests and business contact'}</h2><p>{ar ? 'تتولى توب هاندلز ذ.م.م.، المسجلة في وايومنغ بالولايات المتحدة عام 2025 والتي تنسّق أعمالها من مصر، دور جهة التواصل التجاري لريسوتو. اذكر اسم المطعم والدولة وعدد الفروع وما تحتاجه.' : 'Top Handles LLC, incorporated in Wyoming, USA in 2025 with operations coordinated from Egypt, serves as Resuto’s business contact. Include your restaurant name, country, branch count and what you need.'}</p><div className="mk-actions"><a className="lp-btn lp-btn-solid" href="mailto:contact@resuto.app?subject=Resuto%20access%20request">{ar ? 'أرسل طلبك بالبريد' : 'Email your request'}</a></div><p><a href="mailto:contact@resuto.app">contact@resuto.app</a></p></article>
      <article className="mk-card"><h2>{ar ? 'الشراكات والتواصل مع المؤسس' : 'Partnerships and founder contact'}</h2><p>{ar ? 'لشراكات المنصات والمزودين أو الاستفسارات الإعلامية أو التواصل المباشر مع المؤسس:' : 'For platform and provider partnerships, media inquiries or a direct founder conversation:'}</p><p><a href="mailto:founder@resuto.app">founder@resuto.app</a></p></article>
      <article className="mk-card"><h2>{ar ? 'لا توجد استمارة وهمية' : 'No pretend submission'}</h2><p>{ar ? 'هذا الموقع ثابت ولا يرسل بيانات إلى خادم. أزرار التواصل تفتح تطبيق البريد لديك بوضوح.' : 'This static website does not send data to a backend. Contact buttons clearly open your email application.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'من يطور المنتج؟' : 'Who develops the product?'}</h2><p>{ar ? 'يطور ريسوتو فريق مشروع جامعي من خمسة أعضاء. دور توب هاندلز ذ.م.م. المذكور هنا هو التقديم والتواصل التجاري، ولا يصف أعضاء الفريق كموظفين أو يحدد ملكية المنتج.' : 'Resuto is developed by a five-member university project team. Top Handles LLC’s stated role is application and business contact; this does not describe team members as employees or determine product ownership.'}</p></article>
    </div>}
  </BilingualPage>;
}

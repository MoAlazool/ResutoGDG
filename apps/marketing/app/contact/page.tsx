'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function Contact() {
  return <BilingualPage eyebrow={['Contact', 'تواصل معنا']} title={['Let’s shape your Resuto setup.', 'لنصمم إعداد ريسوتو المناسب لك.']} intro={['Tell us about your restaurant, branches and the workflows you want to connect. A real person will reply by email.', 'أخبرنا عن مطعمك وفروعك ومسارات العمل التي تريد ربطها. سيرد عليك شخص من الفريق عبر البريد.']}>
    {(ar) => <div className="mk-grid">
      <article className="mk-card"><h2>{ar ? 'المبيعات وطلبات الوصول' : 'Sales and access requests'}</h2><p>{ar ? 'اكتب اسم المطعم، الدولة، عدد الفروع، وما الذي تحتاجه.' : 'Include your restaurant name, country, branch count and what you need.'}</p><div className="mk-actions"><a className="lp-btn lp-btn-solid" href="mailto:contact@resuto.app?subject=Resuto%20access%20request">{ar ? 'راسل فريق المبيعات' : 'Email sales'}</a></div><p><a href="mailto:contact@resuto.app">contact@resuto.app</a></p></article>
      <article className="mk-card"><h2>{ar ? 'الشراكات والإعلام' : 'Partnerships and media'}</h2><p>{ar ? 'لشراكات المنصات والمزودين أو الاستفسارات الإعلامية، تواصل مباشرة مع المؤسس.' : 'For platform and provider partnerships or media inquiries, contact the founder directly.'}</p><p><a href="mailto:founder@resuto.app">founder@resuto.app</a></p></article>
      <article className="mk-card"><h2>{ar ? 'لا توجد استمارة وهمية' : 'No pretend submission'}</h2><p>{ar ? 'هذا الموقع ثابت ولا يرسل بيانات إلى خادم. أزرار التواصل تفتح تطبيق البريد لديك بوضوح.' : 'This static website does not send data to a backend. Contact buttons clearly open your email application.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'وقت الرد' : 'What happens next'}</h2><p>{ar ? 'سيراجع الفريق احتياجاتك ويرد بخطوات مناسبة، بما في ذلك التوفر والتسعير وأي متطلبات للمزودين.' : 'The team will review your needs and reply with appropriate next steps, including availability, pricing and any provider requirements.'}</p></article>
    </div>}
  </BilingualPage>;
}

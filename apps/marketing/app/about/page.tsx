'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function About() {
  return <BilingualPage eyebrow={['About Resuto', 'عن ريسوتو']} title={['Hospitality first. Operations connected.', 'الضيافة أولًا. والتشغيل مترابط.']} intro={['Resuto gives restaurant teams one shared view of the dining room, from the first reservation to the final payment.', 'يمنح ريسوتو فرق المطاعم رؤية واحدة مشتركة لصالة المطعم، من أول حجز حتى آخر دفعة.']}>
    {(ar) => <div className="mk-grid">
      <article className="mk-card"><h2>{ar ? 'لماذا نبني ريسوتو' : 'Why we are building Resuto'}</h2><p>{ar ? 'تضيع التفاصيل عندما تعمل الحجوزات والطلبات والمطبخ والمدفوعات في أدوات منفصلة. يربط ريسوتو هذه الرحلة حول مخطط حي واحد للمطعم.' : 'Details get lost when reservations, ordering, kitchen operations and payments live in separate tools. Resuto connects that journey around one live restaurant floor.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'مصمم للمنطقة' : 'Built for the region'}</h2><p>{ar ? 'العربية والإنجليزية واتجاه RTL جزء أساسي من المنتج، مع دعم احتياجات المطاعم في مصر والسعودية.' : 'Arabic, English and right-to-left layouts are foundational, with the needs of restaurants in Egypt and Saudi Arabia in mind.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'واضح وعملي' : 'Clear and practical'}</h2><p>{ar ? 'نوضح ما هو متاح اليوم، وما يحتاج إلى مزود خارجي، وما يتم الاتفاق عليه مع فريق المبيعات.' : 'We distinguish what is available today, what depends on an external provider, and what is scoped with the sales team.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'تواصل مع المؤسس' : 'Founder contact'}</h2><p>{ar ? 'للشراكات أو التواصل المباشر مع المؤسس:' : 'For partnerships or a direct founder conversation:'} <a href="mailto:founder@resuto.app">founder@resuto.app</a></p></article>
    </div>}
  </BilingualPage>;
}

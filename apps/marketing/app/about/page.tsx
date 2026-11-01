'use client';
import { BilingualPage } from '@/components/PublicShell';

export default function About() {
  return <BilingualPage eyebrow={['About Resuto', 'عن ريسوتو']} title={['Hospitality first. Operations connected.', 'الضيافة أولًا. والتشغيل مترابط.']} intro={['Resuto gives restaurant teams one shared view of the dining room, from the first reservation to the final payment.', 'يمنح ريسوتو فرق المطاعم رؤية واحدة مشتركة لصالة المطعم، من أول حجز حتى آخر دفعة.']}>
    {(ar) => <div className="mk-grid">
      <article className="mk-card"><h2>{ar ? 'لماذا نبني ريسوتو' : 'Why we are building Resuto'}</h2><p>{ar ? 'تضيع التفاصيل عندما تعمل الحجوزات والطلبات والمطبخ والمدفوعات في أدوات منفصلة. يربط ريسوتو هذه الرحلة حول مخطط حي واحد للمطعم.' : 'Details get lost when reservations, ordering, kitchen operations and payments live in separate tools. Resuto connects that journey around one live restaurant floor.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'مصمم للمنطقة' : 'Built for the region'}</h2><p>{ar ? 'العربية والإنجليزية واتجاه RTL جزء أساسي من المنتج، مع دعم احتياجات المطاعم في مصر والسعودية.' : 'Arabic, English and right-to-left layouts are foundational, with the needs of restaurants in Egypt and Saudi Arabia in mind.'}</p></article>
      <article className="mk-card"><h2>{ar ? 'الجهة المتقدمة والتواصل التجاري' : 'Applicant and business contact'}</h2><p>{ar ? 'توب هاندلز ذ.م.م. (Top Handles LLC) شركة مسجلة في ولاية وايومنغ بالولايات المتحدة عام 2025، وتنسّق أعمالها من مصر. وهي الجهة القانونية المتقدمة بطلب فريق ريسوتو إلى برنامج NVIDIA Inception وجهة التواصل التجاري للمشروع.' : 'Top Handles LLC was incorporated in Wyoming, USA in 2025, with operations coordinated from Egypt. It is the legal applicant for the Resuto team’s NVIDIA Inception application and the project’s business contact.'}</p><p><a href="mailto:contact@resuto.app">contact@resuto.app</a></p></article>
      <article className="mk-card"><h2>{ar ? 'فريق تطوير ريسوتو' : 'The Resuto development team'}</h2><p>{ar ? 'ريسوتو منتج تقني للمطاعم يطوره فريق مشروع جامعي من خمسة أعضاء. هذا الوصف يميّز دور الفريق في التطوير عن دور توب هاندلز ذ.م.م. في التقديم والتواصل التجاري، ولا يقرر علاقة توظيف أو ملكية بينهما.' : 'Resuto is a restaurant technology product developed by a five-member university project team. This distinguishes the team’s development role from Top Handles LLC’s applicant and business-contact role; it does not state an employment or ownership relationship between them.'}</p></article>
    </div>}
  </BilingualPage>;
}

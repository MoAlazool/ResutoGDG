'use client';

import Link from 'next/link';
import { PublicShell } from '@/components/PublicShell';
import { useT } from '@/lib/i18n/client';
import { InceptionMembership } from '../../../web/components/landing/InceptionMembership';

export default function About() {
  const { locale } = useT();
  const ar = locale === 'ar';
  const c = (pair: readonly [string, string]) => pair[ar ? 1 : 0];
  return (
    <PublicShell>
      <main className="mk-main mk-about" id="mk-main">
        <header className="mk-editorial-hero" data-mk-reveal>
          <div><span className="mk-eyebrow">{c(['About Resuto', 'عن ريسوتو'])}</span><h1>{c(['One restaurant. One operating rhythm.', 'مطعم واحد. إيقاع تشغيل واحد.'])}</h1></div>
          <div className="mk-hero-side"><p>{c(['Restaurants deserve one intelligent environment instead of a patchwork of disconnected tools. Resuto connects the guest journey with the work happening behind it.', 'تستحق المطاعم بيئة ذكية واحدة بدلًا من مجموعة أدوات منفصلة. يربط ريسوتو رحلة الضيف بالعمل التشغيلي الذي يحدث خلفها.'])}</p><Link className="lp-inline" href="/contact/?subject=request-access">{c(['Request access →', 'اطلب الوصول ←'])}</Link></div>
          <div className="mk-orbit" aria-label={c(['Connected restaurant workflow', 'مسار تشغيل مطعم مترابط'])}>
            <div className="mk-orbit-core"><img src="/brand/resuto-icon.png" alt="" width="512" height="512" /><strong>Resuto</strong><small>{c(['Shared restaurant context', 'سياق مطعم موحّد'])}</small></div>
            <ol><li>{c(['Reservations', 'الحجوزات'])}</li><li>{c(['Guest service', 'خدمة الضيوف'])}</li><li>{c(['Kitchen', 'المطبخ'])}</li><li>{c(['Payments', 'المدفوعات'])}</li><li>{c(['Insights', 'الرؤى'])}</li></ol>
          </div>
        </header>

        <section className="mk-manifesto" data-mk-reveal>
          <span className="mk-section-no">01</span>
          <div><span className="mk-eyebrow">{c(['Why Resuto exists', 'لماذا يوجد ريسوتو'])}</span><h2>{c(['Hospitality loses momentum when every handoff starts from zero.', 'تفقد الضيافة زخمها عندما تبدأ كل عملية تسليم من الصفر.'])}</h2></div>
          <div><p>{c(['A reservation should already understand the floor. An order should already understand the table. The kitchen, payment and manager view should follow the same reality — without teams retyping the story.', 'يجب أن يفهم الحجز مخطط الصالة، وأن يفهم الطلب الطاولة، وأن يتبع المطبخ والدفع ورؤية المدير الواقع نفسه — من دون أن يعيد الفريق كتابة التفاصيل.'])}</p><p>{c(['Our vision is a more connected, efficient and intelligent restaurant industry, where technology protects the human moments that make hospitality memorable.', 'رؤيتنا هي قطاع مطاعم أكثر ترابطًا وكفاءة وذكاءً، تحمي فيه التقنية اللحظات الإنسانية التي تجعل الضيافة تجربة لا تُنسى.'])}</p></div>
        </section>

        <section className="mk-region" data-mk-reveal>
          <div className="mk-region-copy"><span className="mk-eyebrow">{c(['Built for the region', 'مصمم للمنطقة'])}</span><h2>{c(['Local by design, not translated at the edge.', 'محلي في جوهر التصميم، لا مجرد ترجمة لاحقة.'])}</h2><p>{c(['Arabic and English, RTL layouts, regional restaurant workflows and a focus on Egypt and Saudi Arabia shape the product foundation.', 'تشكل العربية والإنجليزية واتجاه RTL ومسارات تشغيل المطاعم الإقليمية والتركيز على مصر والسعودية أساس المنتج.'])}</p></div>
          <div className="mk-locale-panel" aria-hidden><span>مصر</span><i /><span>Egypt</span><b>AR ↔ EN</b><span>السعودية</span><i /><span>Saudi Arabia</span></div>
        </section>

        <section className="mk-technology" data-mk-reveal>
          <header><span className="mk-eyebrow">{c(['Technology & innovation', 'التقنية والابتكار'])}</span><h2>{c(['A modular foundation. A governed path to intelligence.', 'أساس معياري. ومسار منضبط نحو الذكاء.'])}</h2><p>{c(['Resuto is being built as connected product modules around shared restaurant data, with a roadmap for useful, reviewable AI assistance — not ungoverned automation.', 'يُبنى ريسوتو كوحدات منتج مترابطة حول بيانات مطعم مشتركة، مع خارطة طريق لمساعدة ذكية مفيدة وقابلة للمراجعة — لا أتمتة بلا ضوابط.'])}</p></header>
          <ol><li><b>01</b><strong>{c(['Connected operations', 'تشغيل مترابط'])}</strong><span>{c(['One context from booking to settlement.', 'سياق واحد من الحجز حتى التسوية.'])}</span></li><li><b>02</b><strong>{c(['Modular architecture', 'بنية معيارية'])}</strong><span>{c(['Capabilities can evolve without fragmenting the experience.', 'تتطور القدرات من دون تفتيت التجربة.'])}</span></li><li><b>03</b><strong>{c(['Governed intelligence', 'ذكاء منضبط'])}</strong><span>{c(['Human review and operational context remain central.', 'تبقى المراجعة البشرية والسياق التشغيلي في المركز.'])}</span></li></ol>
        </section>

        <InceptionMembership rtl={ar} variant="about" />

        <section className="mk-company" data-mk-reveal>
          <div className="mk-team-stat"><strong>5</strong><span>{c(['member university project team developing Resuto', 'أعضاء في فريق مشروع جامعي يطور ريسوتو'])}</span></div>
          <div className="mk-company-copy"><span className="mk-eyebrow">{c(['Company & development', 'الشركة والتطوير'])}</span><h2>{c(['A serious product in active development.', 'منتج جاد قيد التطوير النشط.'])}</h2><p>{c(['Resuto is a restaurant technology product developed by a five-member university project team pursuing commercialization.', 'ريسوتو منتج تقني للمطاعم يطوره فريق مشروع جامعي من خمسة أعضاء ويسعى إلى الوصول للسوق.'])}</p><p>{c(['Top Handles LLC was incorporated in Wyoming, USA in 2025, with operations coordinated from Egypt. It is the accepted NVIDIA Inception member company and the business contact for Resuto inquiries.', 'تأسست توب هاندلز ذ.م.م. في وايومنغ بالولايات المتحدة عام 2025، وتنسّق أعمالها من مصر. وهي الشركة المقبولة عضوًا في NVIDIA Inception وجهة التواصل التجاري لاستفسارات ريسوتو.'])}</p><small>{c(['These roles do not by themselves state an employment relationship, exclusive ownership or other unverified legal rights.', 'لا تعني هذه الأدوار بذاتها وجود علاقة توظيف أو ملكية حصرية أو أي حقوق قانونية أخرى غير متحقق منها.'])}</small><a className="lp-inline" href="mailto:contact@resuto.app">contact@resuto.app</a></div>
        </section>
      </main>
    </PublicShell>
  );
}

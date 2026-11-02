'use client';

import { useEffect, useState } from 'react';
import { PublicShell } from '@/components/PublicShell';
import { useT } from '@/lib/i18n/client';

type Subject = 'request-access' | 'sales' | 'partnerships' | 'founder';
const validSubjects = new Set<Subject>(['request-access', 'sales', 'partnerships', 'founder']);

function mailto(address: string, subject: string, body?: string) {
  const params = new URLSearchParams({ subject });
  if (body) params.set('body', body);
  return `mailto:${address}?${params.toString()}`;
}

export default function Contact() {
  const { locale } = useT();
  const ar = locale === 'ar';
  const c = (pair: readonly [string, string]) => pair[ar ? 1 : 0];
  const [subject, setSubject] = useState<Subject>('sales');
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('subject') as Subject | null;
    if (value && validSubjects.has(value)) setSubject(value);
  }, []);

  const access = subject === 'request-access';
  const primarySubject = access ? c(['Resuto access request', 'طلب وصول إلى ريسوتو']) : c(['Resuto restaurant inquiry', 'استفسار مطعم عن ريسوتو']);
  const body = c([
    'Hello Resuto team,\n\nRestaurant / company name:\nCountry:\nNumber of branches:\nBusiness requirements:\n\nThank you,',
    'مرحبًا فريق ريسوتو،\n\nاسم المطعم / الشركة:\nالدولة:\nعدد الفروع:\nمتطلبات العمل:\n\nشكرًا،',
  ]);
  const primaryHref = mailto('contact@resuto.app', primarySubject, body);

  return (
    <PublicShell>
      <main className="mk-main mk-contact" id="mk-main">
        <header className="mk-contact-hero" data-mk-reveal>
          <div className="mk-contact-intro"><span className="mk-eyebrow">{access ? c(['Request access', 'اطلب الوصول']) : c(['Contact Resuto', 'تواصل مع ريسوتو'])}</span><h1>{access ? c(['Bring your restaurant into one connected workflow.', 'اجمع تشغيل مطعمك في مسار واحد مترابط.']) : c(['Let’s talk about how your restaurant operates.', 'لنتحدث عن طريقة تشغيل مطعمك.'])}</h1><p>{access ? c(['Tell us about your restaurant, locations and the workflows you want to improve. We will continue the conversation by email.', 'أخبرنا عن مطعمك وفروعك ومسارات العمل التي تريد تحسينها. سنكمل المحادثة عبر البريد الإلكتروني.']) : c(['Whether you are exploring Resuto, a commercial collaboration or a platform partnership, your message will reach the right person.', 'سواء كنت تستكشف ريسوتو أو تعاونًا تجاريًا أو شراكة منصة، ستصل رسالتك إلى الشخص المناسب.'])}</p></div>
          <section className="mk-request-panel" aria-labelledby="request-title">
            <div className="mk-request-top"><span>{c(['Direct email request', 'طلب مباشر عبر البريد'])}</span><i>{c(['Typical reply: a real person', 'الرد: شخص من الفريق'])}</i></div>
            <h2 id="request-title">{c(['Request access to Resuto', 'اطلب الوصول إلى ريسوتو'])}</h2>
            <p>{c(['Your email opens with a useful structure so we can understand the restaurant before replying.', 'يفتح بريدك بهيكل مفيد يساعدنا على فهم المطعم قبل الرد.'])}</p>
            <dl><div><dt>{c(['Restaurant / company', 'المطعم / الشركة'])}</dt><dd>________________</dd></div><div><dt>{c(['Country', 'الدولة'])}</dt><dd>________________</dd></div><div><dt>{c(['Branches', 'الفروع'])}</dt><dd>________________</dd></div><div><dt>{c(['Requirements', 'المتطلبات'])}</dt><dd>________________</dd></div></dl>
            <a className="lp-btn lp-btn-solid lp-btn-full" href={primaryHref}>{c(['Open access request email →', 'افتح بريد طلب الوصول ←'])}</a>
            <small>{c(['Sends to contact@resuto.app using your email application.', 'يُرسل إلى contact@resuto.app باستخدام تطبيق البريد لديك.'])}</small>
          </section>
        </header>

        <section className="mk-contact-paths" data-mk-reveal>
          <header><span className="mk-eyebrow">{c(['Choose the right conversation', 'اختر جهة التواصل المناسبة'])}</span><h2>{c(['A clear path for every inquiry.', 'مسار واضح لكل استفسار.'])}</h2></header>
          <div>
            <a href={mailto('contact@resuto.app', c(['Resuto sales & restaurant inquiry', 'استفسار مبيعات ومطاعم عن ريسوتو']))}><span>01</span><strong>{c(['Sales & restaurant inquiries', 'المبيعات واستفسارات المطاعم'])}</strong><p>{c(['Plans, rollout, branch needs and product fit.', 'الخطط والإطلاق واحتياجات الفروع ومدى ملاءمة المنتج.'])}</p><i>contact@resuto.app</i></a>
            <a href={mailto('founder@resuto.app', c(['Resuto partnership inquiry', 'استفسار شراكة مع ريسوتو']))}><span>02</span><strong>{c(['Partnerships', 'الشراكات'])}</strong><p>{c(['Platform, provider, ecosystem and program conversations.', 'محادثات المنصات والمزودين والمنظومة والبرامج.'])}</p><i>founder@resuto.app</i></a>
            <a href={mailto('founder@resuto.app', c(['Resuto founder / business inquiry', 'استفسار للمؤسس / الأعمال في ريسوتو']))}><span>03</span><strong>{c(['Founder / business contact', 'المؤسس / التواصل التجاري'])}</strong><p>{c(['Direct business, media or company-level inquiry.', 'استفسار مباشر عن الأعمال أو الإعلام أو الشركة.'])}</p><i>founder@resuto.app</i></a>
          </div>
        </section>

        <section className="mk-contact-company" data-mk-reveal>
          <div><span className="mk-eyebrow">{c(['Business contact', 'جهة التواصل التجاري'])}</span><h2>Top Handles LLC</h2></div>
          <div><p>{c(['Incorporated in Wyoming, USA in 2025, with operations coordinated from Egypt. Top Handles LLC coordinates business inquiries and joined NVIDIA Inception in November 2026, with Resuto associated with its application.', 'تأسست في وايومنغ بالولايات المتحدة عام 2025، وتنسّق أعمالها من مصر. تتولى توب هاندلز ذ.م.م. تنسيق الاستفسارات التجارية، وانضمت إلى NVIDIA Inception في نوفمبر 2026، وريسوتو هو المنتج المرتبط بطلبها.'])}</p><small>{c(['Resuto is developed by a five-member university project team. The stated roles do not establish employment or exclusive ownership.', 'يطور ريسوتو فريق مشروع جامعي من خمسة أعضاء. ولا تثبت الأدوار المذكورة علاقة توظيف أو ملكية حصرية.'])}</small></div>
        </section>
      </main>
    </PublicShell>
  );
}

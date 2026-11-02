const INCEPTION_URL = 'https://www.nvidia.com/en-us/startups/';

export function InceptionMembership({ rtl, variant = 'band' }: { rtl: boolean; variant?: 'band' | 'about' | 'footer' }) {
  if (variant === 'footer') {
    return (
      <a className="inception-footer" href={INCEPTION_URL} target="_blank" rel="noopener noreferrer" aria-label={rtl ? 'عضوية NVIDIA Inception — فتح صفحة البرنامج الرسمية' : 'NVIDIA Inception membership — open the official program page'}>
        <i aria-hidden />
        <span><b>NVIDIA Inception</b><small>{rtl ? 'عضو منذ نوفمبر 2026' : 'Member since November 2026'}</small></span>
      </a>
    );
  }

  if (variant === 'about') {
    return (
      <section className="inception-about" data-mk-reveal aria-labelledby="inception-about-title">
        <div className="inception-about-lead">
          <span className="mk-eyebrow">{rtl ? 'محطة في مسيرة التقنية' : 'Technology milestone'}</span>
          <p className="inception-program">NVIDIA Inception</p>
          <h2 id="inception-about-title">{rtl ? 'عضوية تدعم مسار البحث والتطوير.' : 'Membership supporting the path from research to product.'}</h2>
        </div>
        <div className="inception-about-copy">
          <p>{rtl ? 'انضمت توب هاندلز ذ.م.م. إلى برنامج NVIDIA Inception في نوفمبر 2026، وريسوتو هو منتج تقنية المطاعم المرتبط بطلب العضوية.' : 'Top Handles LLC joined the NVIDIA Inception program in November 2026, with Resuto presented as the restaurant technology product associated with the application.'}</p>
          <p>{rtl ? 'تدعم العضوية استكشافنا لموارد التطوير والتدريب، والتنبؤ بالطلب، وذكاء العملاء، والمساعدة التشغيلية الوكيلة، وتقييم تقنيات الحوسبة بالـ GPU والاستدلال.' : 'The membership supports our exploration of development resources and training, demand forecasting, customer intelligence, agentic operational assistance, and the evaluation of GPU computing and inference technologies.'}</p>
          <div className="inception-about-meta"><a href={INCEPTION_URL} target="_blank" rel="noopener noreferrer">{rtl ? 'تعرف على البرنامج الرسمي ←' : 'Explore the official program →'}</a><small>{rtl ? 'العضوية لا تعني استثمارًا أو اعتمادًا أو تأييدًا من NVIDIA.' : 'Membership does not imply NVIDIA investment, certification or endorsement.'}</small></div>
        </div>
      </section>
    );
  }

  return (
    <aside className="inception-band" aria-label={rtl ? 'عضوية NVIDIA Inception' : 'NVIDIA Inception membership'}>
      <div className="lp-shell inception-band-inner" data-reveal>
        <div className="inception-title"><i aria-hidden /><span><strong>NVIDIA Inception Member</strong><small>{rtl ? 'منذ نوفمبر 2026' : 'Since November 2026'}</small></span></div>
        <p>{rtl ? 'انضمت توب هاندلز ذ.م.م. إلى NVIDIA Inception، برنامج NVIDIA العالمي لدعم الشركات التقنية الناشئة.' : 'Top Handles LLC has joined NVIDIA Inception, NVIDIA’s global program supporting technology startups.'}</p>
        <a href={INCEPTION_URL} target="_blank" rel="noopener noreferrer">{rtl ? 'عن البرنامج ←' : 'About the program →'}</a>
      </div>
    </aside>
  );
}

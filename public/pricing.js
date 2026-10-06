/* /pricing: plans, add-ons, the full plan comparison (with one named
   competitor tier), common questions and the sales form. Plan copy comes from
   plan-comparison.js, prices from /api/plans. */
import {copy as c,e,api,notice} from './experience-ui.js';
import {t,language,switcher} from './i18n.js';
import {planLists,faq} from './plan-comparison.js';
import {comparisonTable,countTo} from './landing-pricing.js';

// `salesUrl` is set only on the static build, where there is no server to receive the form.
const {plans,salesUrl}=await api('plans');
const rtl=language==='ar',arrow=rtl?'←':'→';
const num=n=>new Intl.NumberFormat(rtl?'ar-EG':'en-US').format(n);
const wanted=new URLSearchParams(location.search).get('plan');
const state={yearly:false,focus:plans.some(p=>p.id===wanted)?wanted:'growth'};
const root=document.querySelector('#app');
const blurb=[c('One room getting started with QR ordering and bookings.','صالة واحدة تبدأ بطلبات QR والحجوزات.'),c('A busy restaurant that wants the kitchen board and split bills.','مطعم نشط يريد شاشة المطبخ وتقسيم الفاتورة.'),c('Up to three branches managed together.','حتى ثلاثة فروع تُدار معًا.'),c('Groups that need custom terms.','مجموعات تحتاج شروطًا خاصة.')];
const price=p=>p.monthly*(state.yearly?10:1);

const nav=()=>`<header class="lp-nav is-stuck"><div class="lp-nav-inner">
 <a class="lp-logo" href="/" aria-label="Resuto">${rtl?'<img class="lp-logo-ar" src="/assets/resuto-arabic-logo.webp" alt="ريسوتو" width="308" height="96">':'<span class="lp-logo-mark" aria-hidden="true">r</span><span class="lp-logo-type">resuto<i>.</i></span>'}</a>
 <nav class="lp-nav-links" aria-label="${c('Sections','الأقسام')}"><a href="#plans"><span>${c('Plans','الخطط')}</span></a><a href="#compare"><span>${c('Compare','المقارنة')}</span></a><a href="#faq"><span>${c('Questions','الأسئلة')}</span></a><a href="/"><span>${c('Product','المنتج')}</span></a></nav>
 <div class="lp-nav-end">${switcher()}<a class="lp-btn lp-btn-solid" href="/restaurant"><span class="lp-cta-long">${c('Open the live demo','جرّب العرض المباشر')}</span><span class="lp-cta-short">${c('Live demo','عرض مباشر')}</span></a></div>
</div></header>`;

const cards=()=>plans.map((p,i)=>`<article class="price-card pr-card${i===1?' is-featured':''}${state.focus===p.id?' is-focus':''}">
 <header><h2>${e(p.name)}</h2>${i===1?`<span class="pr-badge">${c('Most popular','الأكثر اختيارًا')}</span>`:''}</header>
 <p class="pr-for">${blurb[i]}</p>
 <div class="pr-price">${p.monthly?`<b data-amount="${price(p)}">${price(p).toLocaleString('en-EG')}</b><span>${c('EGP / '+(state.yearly?'year':'month'),'جنيه / '+(state.yearly?'سنويًا':'شهريًا'))}</span>`:`<b class="is-talk">${c('Let’s talk','لنتحدث')}</b><span>${c('Custom pricing','سعر حسب احتياجك')}</span>`}</div>
 <small class="pr-billed">${p.monthly?(state.yearly?c('Billed annually · 10 months for 12','دفع سنوي · ١٠ أشهر مقابل ١٢'):c('Billed monthly','دفع شهري')):c('Scoped and quoted separately','يحدد النطاق والسعر بالاتفاق')}</small>
 <a class="lp-btn ${i===1?'lp-btn-solid':'lp-btn-line-ink'} lp-btn-full" href="${p.monthly?`/account?mode=signup&plan=${p.id}`:'#sales'}">${p.monthly?c('Start 14-day trial','ابدأ تجربة ١٤ يومًا'):c('Contact sales','تواصل للمبيعات')}</a>
 <ul>${planLists[i].map(f=>`<li>${c(...f.split('|'))}</li>`).join('')}</ul>
</article>`).join('');

function render(){
 document.title=c('Resuto pricing: plans from 799 EGP a month','أسعار ريسوتو: خطط تبدأ من ٧٩٩ جنيهًا شهريًا');
 root.className='lp pr';
 root.innerHTML=nav()+`<main class="lp-main">
 <section class="pr-hero" id="plans"><div class="lp-shell">
  <div class="pr-head">
   <span class="lp-chapter-tag">${c('Pricing','الأسعار')}</span>
   <h1>${c('One price for the whole service.','سعر واحد للخدمة كلها.')}</h1>
   <p>${c('Reservations, QR ordering, the kitchen board and split bills, priced in Egyptian pounds. Start with a 14-day trial; no card is needed.','الحجوزات وطلبات QR وشاشة المطبخ وتقسيم الفاتورة، بأسعار بالجنيه المصري. ابدأ بتجربة ١٤ يومًا دون بطاقة.')}</p>
   <div class="lp-seg lp-seg-pill billing-toggle" role="group" aria-label="${c('Billing period','فترة الدفع')}"><button type="button" data-billing="monthly" class="${state.yearly?'':'is-on'}" aria-pressed="${!state.yearly}">${c('Monthly','شهري')}</button><button type="button" data-billing="yearly" class="${state.yearly?'is-on':''}" aria-pressed="${state.yearly}">${c('Yearly · 2 months free','سنوي · شهران مجانًا')}</button></div>
  </div>
  <div class="pr-grid pricing-grid" id="pr-grid">${cards()}</div>
  <p class="pr-terms">${c('Launch pricing. Subscription billing is not enabled yet, so nothing is charged during or after the trial for now. Payment gateway, delivery, WhatsApp and SMS provider fees are separate.','أسعار الإطلاق. فوترة الاشتراكات غير مفعّلة بعد، فلا يُخصم أي مبلغ أثناء التجربة أو بعدها حاليًا. رسوم بوابات الدفع والتوصيل وواتساب والرسائل منفصلة.')}</p>
  <div class="pr-addons" aria-label="${c('Add-ons','الإضافات')}">
   <h2>${c('Add-ons','إضافات')}</h2>
   <ul>
    <li><b>${c('Extra branch','فرع إضافي')}</b><span>${c('500 EGP / month','٥٠٠ جنيه / شهر')}</span></li>
    <li><b>${c('Advanced AI','ذكاء اصطناعي متقدم')}</b><span>${c('400 EGP / month','٤٠٠ جنيه / شهر')}</span></li>
    <li class="is-planned"><b>${c('WhatsApp automation','أتمتة واتساب')}</b><span>${c('Planned · 300 EGP / month + provider fees','مخطط · ٣٠٠ جنيه / شهر + رسوم المزود')}</span></li>
    <li><b>${c('Premium onboarding and custom integrations','إعداد متميز وتكاملات مخصصة')}</b><span>${c('Quoted separately','بعرض سعر مستقل')}</span></li>
   </ul>
  </div>
 </div></section>
 <section class="pr-compare" id="compare"><div class="lp-shell">
  <div class="pr-sec-head"><h2>${c('Compare every plan','قارن كل الخطط')}</h2><p>${c('Every feature and limit for the four Resuto plans, beside the Foodics Basic package in Egypt. Each cell says whether something is included, planned, priced by agreement or still to be confirmed.','كل ميزة وحدّ في خطط ريسوتو الأربع، بجانب الباقة الأساسية من فودكس في مصر. كل خانة توضح هل الميزة متضمَّنة أم مخططة أم بسعر حسب الاتفاق أم تحتاج إلى تأكيد.')}</p></div>
  <div class="cmp-wrap" id="pr-table"></div>
 </div></section>
 <section class="pr-faq" id="faq"><div class="lp-shell">
  <div class="pr-sec-head"><h2>${c('Common questions','أسئلة شائعة')}</h2></div>
  <div class="pr-qa">${faq.map(([q,a],i)=>`<details${i?'':' open'}><summary>${c(...q.split('|'))}</summary><p>${c(...a.split('|'))}</p></details>`).join('')}</div>
 </div></section>
 <section class="pr-sales sales-panel" id="sales"><div class="lp-shell pr-sales-in">
  <div><h2>${c('Let’s shape your setup.','لنصمم ما يناسبك.')}</h2><p>${c('Tell us what you need. Your request is saved to this installation’s private manager inbox. Email notifications are not enabled.','أخبرنا بما تحتاجه. يُحفظ طلبك في صندوق المدير الخاص بهذه النسخة. إشعارات البريد غير مفعّلة.')}</p></div>
  ${salesUrl?`<div class="pr-form"><a class="lp-btn lp-btn-solid" href="${e(salesUrl)}">${c('Open the inquiry form','افتح نموذج الطلب')} ${arrow}</a></div>`:`<form id="sales-form" class="pr-form">
   <label>${c('Restaurant / company','المطعم / الشركة')}<input name="restaurant" required maxlength="120" autocomplete="organization"></label>
   <label>${c('Email','البريد الإلكتروني')}<input name="email" type="email" required autocomplete="email" dir="ltr"></label>
   <label>${c('Branches','الفروع')}<input name="branches" type="number" min="1" max="500" value="1" required></label>
   <label class="is-wide">${c('What do you need?','ماذا تحتاج؟')}<textarea name="requirements" required maxlength="1000" rows="3"></textarea></label>
   <button class="lp-btn lp-btn-solid" type="submit">${c('Send inquiry','إرسال الطلب')} ${arrow}</button>
  </form>`}
 </div></section>
 </main>
 <footer class="pr-foot"><div class="lp-shell"><a href="/">${c('Resuto home','الرئيسية')}</a><a href="/restaurant">${c('Restaurant demo','تجربة المطعم')}</a><a href="/reserve">${c('Reserve a table','احجز طاولة')}</a><a href="/menu">${c('Menu','القائمة')}</a><small>© ${new Date().getFullYear()} Resuto</small></div></footer>`;
 table();
}
function table(){root.querySelector('#pr-table').innerHTML=comparisonTable({t,num,rtl,e,plans,yearly:state.yearly,focus:state.focus})}
function focus(id){
 state.focus=id;
 root.querySelector('.cmp').dataset.focus=id;
 root.querySelector('[data-cmp="plan"]').value=id;
 root.querySelectorAll('.pr-card').forEach((el,i)=>el.classList.toggle('is-focus',plans[i].id===id));
}
root.addEventListener('click',ev=>{
 const bill=ev.target.closest('[data-billing]'),col=ev.target.closest('[data-cmp="focus"]');
 if(col)return focus(col.dataset.arg);
 if(!bill)return;
 const grid=root.querySelector('#pr-grid'),old=[...grid.querySelectorAll('[data-amount]')].map(b=>Number(b.dataset.amount));
 state.yearly=bill.dataset.billing==='yearly';
 root.querySelectorAll('[data-billing]').forEach(b=>{const on=(b.dataset.billing==='yearly')===state.yearly;b.classList.toggle('is-on',on);b.setAttribute('aria-pressed',String(on))});
 grid.innerHTML=cards();
 table();
 // Western digits here, as on the cards, so the figure does not change script mid-count.
 if(!matchMedia('(prefers-reduced-motion: reduce)').matches)countTo([...grid.querySelectorAll('[data-amount]')],old,n=>n.toLocaleString('en-EG'));
});
root.addEventListener('change',ev=>{if(ev.target.dataset.cmp==='plan')focus(ev.target.value)});
root.addEventListener('submit',async ev=>{
 if(ev.target.id!=='sales-form')return;
 ev.preventDefault();
 const data=Object.fromEntries(new FormData(ev.target));data.branches=Number(data.branches);
 ev.submitter.disabled=true;
 try{const result=await api('sales-inquiry',{...data,key:crypto.randomUUID()});ev.target.innerHTML=`<p role="status">${c('Request received. Reference:','تم استلام الطلب. الرقم:')} ${e(result.id)}</p>`}
 catch(err){notice(err.message);ev.submitter.disabled=false}
});
render();
if(location.hash)document.querySelector(location.hash)?.scrollIntoView();

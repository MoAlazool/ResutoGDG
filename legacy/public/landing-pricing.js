/* Pricing cards on the landing page, and the plan comparison table that the
   /pricing page shows in full. Plan copy and competitor facts live in
   plan-comparison.js; prices and branch/staff numbers come from /api/plans. */
import {comparison,competitor} from './plan-comparison.js';

export const WORD={yes:'Included',no:'Not included',planned:'Planned',quote:'By agreement',confirm:'Requires confirmation',unknown:'Not publicly specified'};
const MARK={yes:'✓',no:'–',planned:'◷',quote:'↗',confirm:'?',unknown:'·'};
const cardBullets={
 starter:['QR menu and ordering','Floor plan and reservations','Pickup, ratings and basic analytics'],
 growth:['Everything in Starter','AI waiter and kitchen display','Split payments and integrations'],
 pro:['Everything in Growth','Up to three branches','AI operational insights'],
 business:['Negotiated branch limits','Dedicated onboarding and migration','SLA, API and white label']
};
export const valueChip=(k,t)=>`<span class="cmp-v is-${k}"><i aria-hidden="true">${MARK[k]}</i>${t(WORD[k])}</span>`;

/* The full table: every Resuto plan beside the named competitor tier. */
export function comparisonTable({t,num,rtl,e,plans,yearly=false,focus='growth'}){
 const ar=s=>s.split('|')[rtl?1:0];
 const cell=(v,plan)=>{
  if(v==='@branches')v=plan.branches>1?`Up to ${plan.branches}|حتى ${num(plan.branches)}`:`${plan.branches}|${num(plan.branches)}`;
  if(v==='@staff')v=plan.staff?`${plan.staff}|${num(plan.staff)}`:'confirm';
  if(v==='@monthly')v=`${plan.monthly.toLocaleString('en-US')} EGP / month|${num(plan.monthly)} جنيه شهريًا`;
  if(v==='@yearly')v=`${(plan.monthly*10).toLocaleString('en-US')} EGP / year (10 months)|${num(plan.monthly*10)} جنيه سنويًا (١٠ أشهر)`;
  return WORD[v]?valueChip(v,t):`<span class="cmp-v is-text"><bdi>${e(ar(v))}</bdi></span>`;
 };
 const date=new Date(competitor.checked+'T00:00:00').toLocaleDateString(rtl?'ar-EG':'en-GB',{day:'numeric',month:'long',year:'numeric'});
 return `<ul class="cmp-legend">${Object.keys(WORD).map(k=>`<li>${valueChip(k,t)}</li>`).join('')}</ul>
  <label class="cmp-pick"><span>${t('Plan to compare')}</span><select data-cmp="plan">${plans.map(p=>`<option value="${p.id}"${p.id===focus?' selected':''}>${e(p.name)}</option>`).join('')}</select></label>
  <div class="cmp-scroll" tabindex="0" role="region" aria-label="${t('Plan comparison')}">
  <table class="cmp" data-focus="${focus}">
   <thead><tr><th scope="col">${t('Feature')}</th>${plans.map(p=>`<th scope="col" data-plan="${p.id}"><button type="button" data-cmp="focus" data-arg="${p.id}"><b>${e(p.name)}</b><small>${p.monthly?`<bdi>${num(p.monthly*(yearly?10:1))} ${t('EGP')}</bdi> / ${yearly?t('year'):t('month')}`:t('Let’s talk')}</small></button></th>`).join('')}
    <th scope="col" data-plan="rival"><b>${competitor.name} · ${e(ar(competitor.tier))}</b><small>${e(ar(competitor.scope))}</small></th></tr></thead>
   <tbody>${comparison.map(g=>`<tr class="cmp-group"><th colspan="${plans.length+2}" scope="colgroup"><span>${e(ar(g.group))}</span></th></tr>${g.rows.map(([label,values,rival])=>`<tr><th scope="row">${e(ar(label))}</th>${plans.map((p,i)=>`<td data-plan="${p.id}">${cell(values[i],p)}</td>`).join('')}<td data-plan="rival">${cell(rival)}</td></tr>`).join('')}`).join('')}</tbody>
  </table></div>
  <div class="cmp-notes">
   <p><b>${competitor.name}:</b> ${e(ar(competitor.note))}</p>
   <p>${t('Competitor details are from the official page for that package, last checked')} ${date}: <a href="${competitor.source}" target="_blank" rel="noopener">foodics.com/ar/foodics-pricing-egypt</a>. ${t('“Not publicly specified” means the page does not say; it does not mean the feature is missing.')}</p>
   <p>${t('Payment gateway, delivery, WhatsApp and SMS provider fees are charged by those providers and are not part of the subscription.')}</p>
  </div>`;
}

// Figures count to their new value instead of snapping when billing changes.
export function countTo(els,from,num){
 els.forEach((b,i)=>{
  const a=from[i],to=Number(b.dataset.amount),start=performance.now();
  if(a===undefined||a===to)return;
  const step=now=>{
   const p=Math.min(1,(now-start)/520),k=1-Math.pow(1-p,3);
   b.textContent=num(Math.round(a+(to-a)*k));
   if(p<1)requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
 });
}

export function pricingSection({t}){
 return `<section class="lp-chapter lp-pricing" id="pricing">
 <div class="lp-shell">
  <div class="lp-pricing-head" data-reveal>
   <div><span class="lp-chapter-tag">${t('Pricing')}</span><h2>${t('Egyptian pricing, from one room to three branches.')}</h2></div>
   <div class="lp-seg lp-seg-pill" role="group" aria-label="${t('Billing period')}">
    <button type="button" class="is-on" data-lp="billing" data-arg="monthly" aria-pressed="true">${t('Monthly')}</button>
    <button type="button" data-lp="billing" data-arg="yearly" aria-pressed="false">${t('Yearly · 2 months free')}</button>
   </div>
  </div>
  <div class="lp-plans" id="plan-grid"></div>
  <p class="lp-pricing-note" data-reveal>${t('Launch pricing. You can create a workspace and start a 14-day trial without a card. Subscription billing is not enabled yet, so nothing is charged.')} <a class="lp-inline" href="/pricing#compare">${t('Compare every feature')}</a></p>
 </div>
</section>`;
}

export function mountPricing(root,{t,num,e,plans,reduced}){
 const grid=root.querySelector('#plan-grid');
 let yearly=false;
 function cards(){
  grid.innerHTML=plans.map((p,i)=>`<article class="lp-plan${i===1?' is-featured':''}" style="--i:${i}">
   <h3>${e(p.name)}</h3>
   <div class="lp-plan-price">${p.monthly?`<b data-amount="${p.monthly*(yearly?10:1)}">${num(p.monthly*(yearly?10:1))}</b><small>${t('EGP')} / ${yearly?t('year'):t('month')}</small>`:`<b class="lp-plan-talk">${t('Let’s talk')}</b>`}</div>
   <ul>${cardBullets[p.id].map(f=>`<li>${t(f)}</li>`).join('')}</ul>
   <a class="lp-btn ${i===1?'lp-btn-solid':'lp-btn-line-ink'} lp-btn-full" href="${p.monthly?`/pricing?plan=${p.id}#compare`:'/pricing#sales'}">${p.monthly?t('See what is included'):t('Talk to us')}</a>
  </article>`).join('');
 }
 root.addEventListener('click',ev=>{
  const el=ev.target.closest('[data-lp="billing"]');
  if(!el)return;
  const old=[...grid.querySelectorAll('[data-amount]')].map(b=>Number(b.dataset.amount));
  yearly=el.dataset.arg==='yearly';
  root.querySelectorAll('[data-lp="billing"]').forEach(b=>{const on=(b.dataset.arg==='yearly')===yearly;b.classList.toggle('is-on',on);b.setAttribute('aria-pressed',String(on))});
  cards();
  if(!reduced)countTo([...grid.querySelectorAll('[data-amount]')],old,num);
 });
 cards();
}

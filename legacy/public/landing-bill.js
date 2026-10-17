/* Landing page · bill splitting.
   One example and nothing else: the bill, four guests each paying an equal
   share, and the receipt. The bar under the total fills as they pay. By-item and custom
   splits exist in the product and are mentioned in the copy, not animated.
   Sample data only: no payment is created. */
import {createStage} from './landing-stage.js';

// Prices are the demo menu's own, in piastres.
const ITEMS=[['Seabass with lemon butter',34500],['Hibiscus cooler',6500],['Burrata & heirloom tomato',14500],['Wild mushroom risotto',24500],['Grilled chicken supreme',28500],['Chocolate fondant',12500]];
const PEOPLE=['Ahmed','Mariam','Omar','Lina'];
const TOTAL=ITEMS.reduce((n,i)=>n+i[1],0);
const SHARE=TOTAL/PEOPLE.length;

export function billSection({t,money,e,arrow}){
 return `<section class="lp-chapter lp-payments" id="payments">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">${t('Payments')}</span><h2>${t('The bill stops being the awkward part.')}</h2></div>
   <p>${t('One bill, a private link for each guest. Here four guests split it equally; they can also split by item or by a custom amount.')}</p>
  </div>
  <div class="pb" id="pay" data-reveal>
   <div class="pb-bill">
    <small>${t('Table')} T5 · ${t('Bill')}</small>
    <b class="pb-total"><bdi>${money(TOTAL)}</bdi></b>
    <div class="pb-bar" aria-hidden="true">${PEOPLE.map((_,p)=>`<i data-p="${p}"><u></u></i>`).join('')}</div>
    <span class="pb-status" id="pb-status"></span>
   </div>
   <ol class="pb-guests">${PEOPLE.map((name,p)=>`<li data-p="${p}" data-state="idle">
    <span class="pb-face"><b>${e(t(name).slice(0,1))}</b><i aria-hidden="true">✓</i></span>
    <span class="pb-name">${t(name)}</span>
    <span class="pb-amt"><bdi>${money(SHARE)}</bdi></span>
   </li>`).join('')}</ol>
   <div class="pb-out">
    <article class="pb-receipt">
     <span class="pb-stamp">✓ ${t('Paid')}</span>
     <strong>${t('Receipt')}</strong>
     <b><bdi>${money(TOTAL)}</bdi></b>
     <span class="pb-stars" aria-hidden="true">${'<i>★</i>'.repeat(5)}</span>
    </article>
    <p class="pb-wait">${t('Receipt')}</p>
   </div>
  </div>
  <p class="pb-foot"><a class="lp-inline" href="/restaurant">${t('Open the guest experience')} ${arrow}</a></p>
 </div>
</section>`;
}

export function mountBill(root,{t,money,num,reduced}){
 const box=root.querySelector('#pay'),$=s=>box.querySelector(s);
 let paid=0;
 const phone=p=>$(`.pb-guests [data-p="${p}"]`);
 function setState(p,state){
  phone(p).dataset.state=state;
  $(`.pb-bar [data-p="${p}"]`).classList.toggle('is-on',state==='paid');
 }
 function status(){
  const left=PEOPLE.length-paid;
  $('#pb-status').textContent=left?`${num(paid)} ${t('of')} ${num(PEOPLE.length)} ${t('paid')}`:'✓ '+t('Paid in full');
 }
 const count=async()=>{};
 // "Paid" and the receipt appear only once the last share has landed.
 const settle=done=>box.classList.toggle('is-settled',done);
 if(reduced){
  PEOPLE.forEach((_,p)=>setState(p,'paid'));
  paid=PEOPLE.length;status();settle(true);
  return;
 }
 status();
 const stage=createStage(box);
 stage.whenVisible(()=>stage.loop(async c=>{
  await c.wait(800);
  for(let p=0;p<PEOPLE.length;p++){
   setState(p,'paying');
   await c.wait(420);
   setState(p,'paid');
   paid=p+1;status();
   await c.wait(430);
  }
  settle(true);
 },{hold:3400,rewind:async c=>{
  settle(false);
  await c.wait(380);
  PEOPLE.forEach((_,p)=>setState(p,'idle'));
  paid=0;status();
  await count(c);
  await c.wait(200);
 }}));
}

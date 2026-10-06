/* Landing page · kitchen demo.
   One state object (the order list) drives the board, every counter, the
   station load and the guest's status preview, so nothing on screen can
   disagree. Statuses, column names and button labels are the real app's.
   Sample data only: no order is created. */
import {createTour,EASE} from './landing-stage.js';

const FLOW=['received','preparing','ready','served'];
const COLUMNS=[['received','New orders'],['preparing','Preparing'],['ready','Ready to serve'],['served','Completed']];
const NEXT={received:'Start preparing',preparing:'Mark ready',ready:'Mark served'};
const GUEST=['Order received','Preparing','Ready','Served'];
const STATIONS=['Grill','Hot kitchen','Cold kitchen','Pastry','Bar'];
const TEMPLATES=[
 {table:'T5',lines:[[1,'Burrata & heirloom tomato','Cold kitchen'],[1,'Grilled chicken supreme','Grill']]},
 {table:'T2',lines:[[2,'Roasted pumpkin soup','Hot kitchen'],[2,'Hibiscus cooler','Bar']]},
 {table:'T8',lines:[[1,'Seabass with lemon butter','Grill'],[1,'Wild mushroom risotto','Hot kitchen']]},
 {table:'T11',lines:[[2,'Chocolate fondant','Pastry'],[1,'Hibiscus cooler','Bar']]}
];
const KEEP_DONE=2;

export function kitchenSection({t,arrow}){
 return `<section class="lp-kitchen" id="kitchen">
 <div class="lp-shell">
  <div class="lp-head-row is-light" data-reveal>
   <div><span class="lp-chapter-tag is-dark">${t('Kitchen')}</span><h2>${t('One board. Every line knows its station.')}</h2></div>
   <p>${t('An order reaches the kitchen the moment the guest confirms it. Each line carries the station that cooks it, and the status the kitchen sets is the status the guest sees.')}</p>
  </div>
  <div class="kds" id="kds">
   <div class="kds-main">
    <header class="kds-bar">
     <strong>${t('Kitchen display')}</strong>
     <span class="kds-active">${t('Active orders')} <b id="kds-active">0</b></span>
     <button type="button" class="kds-new" data-kds="new">+ ${t('Sample order')}</button>
    </header>
    <div class="kds-board">${COLUMNS.map(([id,label])=>`<section class="kds-col" data-col="${id}"><header><i></i>${t(label)}<b data-count="${id}">0</b></header><div class="kds-list" data-list="${id}"></div></section>`).join('')}</div>
    <footer class="kds-stations">
     <span class="kds-stations-label">${t('Station load')}</span>
     <div class="kds-chips" role="group" aria-label="${t('Highlight a station')}"><button type="button" data-kds="station" data-arg="" aria-pressed="true">${t('All')}</button>${STATIONS.map(s=>`<button type="button" data-kds="station" data-arg="${s}" aria-pressed="false"><span>${t(s)}</span><i><u data-load="${s}"></u></i><b data-portions="${s}">0</b></button>`).join('')}</div>
    </footer>
   </div>
   <aside class="kds-guest">
    <span class="kds-guest-tag">${t('What the guest sees')}</span>
    <div class="kds-phone"><div class="kds-phone-in" id="kds-guest"></div></div>
    <a class="lp-inline is-dark" href="/kitchen">${t('Open the kitchen screen')} ${arrow}</a>
   </aside>
   <div class="kds-guide" data-guide></div>
  </div>
 </div>
</section>`;
}

export function mountKitchen(root,{t,num,e,reduced}){
 const $=s=>root.querySelector(s),box=$('#kds');
 const lists=Object.fromEntries(COLUMNS.map(([id])=>[id,box.querySelector(`[data-list="${id}"]`)]));
 const guestEl=$('#kds-guest');
 let seq=39,minute=36,orders=[],follow=null,station='',cards=new Map();
 const pad=n=>'#'+String(n).padStart(3,'0');
 const label=n=>'#'+num(n).padStart(3,num(0));
 const clock=m=>new Date(2024,0,1,19,m).toLocaleTimeString(document.documentElement.lang==='ar'?'ar-EG':'en-US',{hour:'numeric',minute:'2-digit'});

 function add(status='received'){
  const tpl=TEMPLATES[seq%TEMPLATES.length];
  const o={n:++seq,table:tpl.table,lines:tpl.lines,status,at:clock(minute+=2)};
  orders.push(o);
  return o;
 }
 function advance(n){
  const o=orders.find(x=>x.n===n);
  if(!o||o.status==='served')return;
  o.status=FLOW[FLOW.indexOf(o.status)+1];
  follow=o.n;
  // Only the most recent completed orders stay on the board.
  const done=orders.filter(x=>x.status==='served');
  if(done.length>KEEP_DONE)orders=orders.filter(x=>x!==done[0]);
  render();
 }

 function cardFor(o){
  let el=cards.get(o.n);
  if(!el){
   el=document.createElement('article');
   el.className='kds-card is-new';
   el.dataset.n=o.n;
   cards.set(o.n,el);
  }
  el.dataset.status=o.status;
  el.classList.toggle('is-followed',o.n===follow);
  el.innerHTML=`<header><b>${label(o.n)}</b><time>${o.at}</time></header>
   <span class="kds-from">${t('Table')} ${e(o.table)} · ${t('Table QR')}</span>
   <ul>${o.lines.map(([q,name,st])=>`<li data-station="${st}"><span>${num(q)} × ${t(name)}</span><small>${t(st)}</small></li>`).join('')}</ul>
   ${NEXT[o.status]?`<button type="button" data-kds="advance" data-arg="${o.n}">${t(NEXT[o.status])}</button>`:`<span class="kds-done">✓ ${t('Served')}</span>`}`;
  return el;
 }

 function render(){
  // FLIP: remember where every card is, rebuild, then glide each one to its new place.
  const before=new Map([...cards].map(([n,el])=>[n,el.isConnected?el.getBoundingClientRect():null]));
  for(const [n,el] of cards)if(!orders.some(o=>o.n===n)){
   cards.delete(n);
   if(reduced)el.remove();
   else el.animate([{opacity:1},{opacity:0,transform:'translateY(8px)'}],{duration:260,easing:EASE.state}).finished.then(()=>el.remove());
  }
  for(const [id] of COLUMNS){
   const inCol=orders.filter(o=>o.status===id);
   (id==='served'?inCol.reverse():inCol).forEach(o=>lists[id].append(cardFor(o)));
   box.querySelector(`[data-count="${id}"]`).textContent=num(orders.filter(o=>o.status===id).length);
  }
  if(!reduced)for(const [n,el] of cards){
   const a=before.get(n),b=el.getBoundingClientRect();
   if(!a){el.animate([{opacity:0,transform:'translateY(-14px) scale(.96)'},{opacity:1,transform:'none'}],{duration:420,easing:EASE.move});continue}
   const dx=a.left-b.left,dy=a.top-b.top;
   if(dx||dy)el.animate([{transform:`translate(${dx}px,${dy}px)`,zIndex:3},{transform:'none',zIndex:3}],{duration:560,easing:EASE.move});
  }
  cards.forEach(el=>el.classList.remove('is-new'));
  // Counters: the same rules the app uses.
  $('#kds-active').textContent=num(orders.filter(o=>o.status!=='served').length);
  const queued=orders.filter(o=>o.status==='received'||o.status==='preparing');
  for(const s of STATIONS){
   const portions=queued.reduce((sum,o)=>sum+o.lines.filter(l=>l[2]===s).reduce((x,l)=>x+l[0],0),0);
   box.querySelector(`[data-portions="${s}"]`).textContent=num(portions);
   box.querySelector(`[data-load="${s}"]`).style.transform=`scaleX(${Math.min(1,portions/5)})`;
  }
  renderGuest();
 }
 function renderGuest(){
  const o=orders.find(x=>x.n===follow)||orders[orders.length-1];
  if(!o)return;
  const at=FLOW.indexOf(o.status);
  guestEl.innerHTML=`<div class="kds-g-head"><small>${t('Order status')}</small><strong>${label(o.n)}</strong><span>${t('Table')} ${e(o.table)}</span></div>
   <ol class="kds-g-steps">${GUEST.map((s,i)=>`<li class="${i<at?'is-done':i===at?'is-now':''}"><i>${i<at?'✓':num(i+1)}</i>${t(s)}</li>`).join('')}</ol>
   <ul class="kds-g-lines">${o.lines.map(([q,name])=>`<li>${num(q)} × ${t(name)}</li>`).join('')}</ul>`;
 }
 function setStation(s){
  station=s;
  box.dataset.station=s;
  box.querySelectorAll('[data-kds="station"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.arg===s)));
  box.querySelectorAll('.kds-card li').forEach(li=>li.classList.toggle('is-dim',!!s&&li.dataset.station!==s));
 }
 const btn=n=>`.kds-card[data-n="${n}"] [data-kds="advance"]`;

 box.addEventListener('click',ev=>{
  const el=ev.target.closest('[data-kds]');
  if(!el)return;
  if(el.dataset.kds==='advance')advance(Number(el.dataset.arg));
  if(el.dataset.kds==='station')setStation(el.dataset.arg);
  if(el.dataset.kds==='new'){follow=add().n;render();setStation(station)}
 });

 // A board in mid-service: one order cooking, one waiting on the pass.
 add('preparing');add('ready');
 follow=orders[0].n;
 render();
 let cycle=0;
 createTour(box,{t,reduced,hold:500,
  manualHint:'Advance a ticket, add a sample order, or highlight a station.',
  script:async({c,tap,say})=>{
   const [cooking,passed]=orders.filter(o=>o.status!=='served').sort((a,b)=>FLOW.indexOf(a.status)-FLOW.indexOf(b.status)).slice(-2);
   say('A guest confirms: the order is on the board');
   await tap(c,'[data-kds="new"]',{wait:500});
   const fresh=orders[orders.length-1];
   box.querySelector(`.kds-card[data-n="${fresh.n}"]`)?.classList.add('is-routing');
   say('Each line shows the station that cooks it');
   await c.wait(1300);
   box.querySelector(`.kds-card[data-n="${fresh.n}"]`)?.classList.remove('is-routing');
   if(cycle++%2){
    say('Highlight one station across the board');
    await tap(c,'[data-kds="station"][data-arg="Grill"]',{wait:1100});
    await tap(c,'[data-kds="station"][data-arg=""]',{ms:420,wait:200});
   }
   if(passed){say('Mark served: it leaves the active count');await tap(c,btn(passed.n),{wait:700})}
   if(cooking&&cooking!==passed){say('Mark ready: the guest sees it at once');await tap(c,btn(cooking.n),{wait:900})}
   say('Start preparing the new order');
   await tap(c,btn(fresh.n),{wait:700});
  }
 });
}

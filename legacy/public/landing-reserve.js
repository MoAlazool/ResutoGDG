/* Landing page · reservations.
   A booking told in three choices (the table, the time, the party) and one
   large ticket that fills in as each choice is made. No floor plan here: the
   guest page also lists tables as cards, and that is the view this uses.
   Sample data only: no reservation is created and nothing is charged. */
import {createTour} from './landing-stage.js';

const DAYS=[['Thu','8'],['Fri','9'],['Sat','10'],['Sun','11']];
const SLOTS=[['19:00',2],['19:30',0],['20:00',4],['20:30',3]];
const STEPS=[['table','Choose your table'],['time','Pick the time'],['guests','How many guests']];
const REFERENCE='K7M2Q9XD';

export function reserveSection({t,num,e,arrow,tables,restaurant,branch}){
 // Three real tables that differ in a way a guest would care about.
 const pick=[tables.find(x=>x.premium)||tables[0],tables.find(x=>x.capacity>=6)||tables[1],tables.find(x=>(x.features||[]).includes('Center'))||tables[2]].filter((x,i,a)=>x&&a.indexOf(x)===i);
 const glyph=x=>`<span class="rsv-glyph is-${x.shape==='round'?'round':'square'}" style="--n:${x.capacity}" aria-hidden="true">${'<i></i>'.repeat(Math.min(8,x.capacity))}</span>`;
 const body={
  table:`<div class="rsv-tables">${pick.map(x=>`<button type="button" data-rsv="table" data-arg="${e(x.id)}" aria-pressed="false">${glyph(x)}<span class="rsv-t-main"><b>${e(x.label)}</b><small>${e(t(x.zone))} · ${num(x.capacity)} ${t('seats')}</small></span><span class="rsv-tags">${x.premium?`<em class="is-premium">${t('Premium')}</em>`:''}${(x.features||[]).slice(0,2).map(f=>`<em>${e(t(f))}</em>`).join('')}</span></button>`).join('')}</div>`,
  time:`<span class="rsv-label">${t('Date')}</span><div class="rsv-days">${DAYS.map(([d,n],i)=>`<button type="button" data-rsv="day" data-arg="${i}" aria-pressed="false"><small>${t(d)}</small><b>${num(Number(n))}</b></button>`).join('')}</div>
   <span class="rsv-label">${t('Time')}</span><div class="rsv-slots">${SLOTS.map(([s,free])=>`<button type="button" data-rsv="slot" data-arg="${s}" aria-pressed="false"${free?'':' disabled'}><b>${s}</b><small>${free?`${num(free)} ${t('free')}`:t('Full')}</small></button>`).join('')}</div>`,
  guests:`<div class="rsv-guests"><div class="rsv-stepper"><button type="button" data-rsv="less" aria-label="${t('Fewer guests')}">−</button><output id="rsv-count">2</output><button type="button" data-rsv="more" aria-label="${t('More guests')}">+</button></div><div class="rsv-quick">${[2,4,6].map(n=>`<button type="button" data-rsv="guests" data-arg="${n}">${num(n)}</button>`).join('')}</div></div>
   <button type="button" class="lp-btn lp-btn-solid rsv-confirm" data-rsv="confirm">${t('Confirm reservation')} ${arrow}</button>`
 };
 return `<section class="lp-reserve" id="reserve">
 <div class="lp-reserve-photo" aria-hidden="true"><img src="/assets/olive-interior.webp" alt="" loading="lazy" decoding="async" width="1600" height="900"></div>
 <div class="lp-shell rsv" id="rsv" data-step="0">
  <div class="rsv-left">
   <div class="lp-copy is-light" data-reveal>
    <span class="lp-chapter-tag is-dark">${t('Reservations')}</span>
    <h2>${t('Guests book a table, not a time slot.')}</h2>
    <p>${t('They choose the table they want from the room you drew, then the time and the party. The booking lands on the floor your team is watching.')}</p>
   </div>
   <ol class="rsv-steps" data-reveal>${STEPS.map(([id,title],i)=>`<li data-step="${i}"><button type="button" class="rsv-head" data-rsv="open" data-arg="${i}"><i>${num(i+1)}</i><b>${t(title)}</b><span data-summary="${id}"></span></button><div class="rsv-body"><div class="rsv-body-in">${body[id]}</div></div></li>`).join('')}</ol>
   <div class="rsv-foot"><div data-guide></div><a class="lp-inline is-dark" href="/reserve">${t('Open the booking page')} ${arrow}</a></div>
  </div>
  <article class="rsv-ticket" data-reveal aria-live="off">
   <header><small>${e(restaurant)} · ${e(branch)}</small><strong>${t('Reservation')}</strong></header>
   <dl>
    <div data-field="table"><dt>${t('Table')}</dt><dd>—</dd></div>
    <div data-field="when"><dt>${t('When')}</dt><dd>—</dd></div>
    <div data-field="guests"><dt>${t('Guests')}</dt><dd>—</dd></div>
   </dl>
   <div class="rsv-rip" aria-hidden="true"></div>
   <footer>
    <div class="rsv-stamp"><b><i aria-hidden="true">✓</i>${t('Your table is booked')}</b><small>${t('Reference')} <bdi>${REFERENCE}</bdi></small></div>
    <div class="rsv-code" aria-hidden="true"></div>
    <p class="rsv-wait">${t('Three choices and it is booked.')}</p>
   </footer>
   <small class="rsv-note">${t('Demo booking. No card is charged and no message is sent.')}</small>
  </article>
 </div>
</section>`;
}

export function mountReserve(root,{t,num,e,tables,reduced}){
 const box=root.querySelector('#rsv'),$=s=>box.querySelector(s),$$=s=>[...box.querySelectorAll(s)];
 const fresh=()=>({step:0,table:null,day:null,slot:null,guests:null,count:2,done:false});
 let s=fresh();
 const table=()=>tables.find(x=>x.id===s.table);
 const when=()=>s.day!==null&&s.slot?`${t(DAYS[s.day][0])} ${num(Number(DAYS[s.day][1]))} · ${s.slot}`:'';
 function field(name,value){
  const dd=$(`[data-field="${name}"] dd`),next=value||'—';
  if(dd.textContent===next)return;
  dd.textContent=next;
  dd.parentElement.classList.toggle('is-set',!!value);
  if(value&&!reduced)dd.animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:420,easing:'cubic-bezier(.32,.72,0,1)'});
 }
 function paint(){
  box.dataset.step=s.step;
  box.classList.toggle('is-done',s.done);
  $$('.rsv-steps li').forEach((li,i)=>{li.classList.toggle('is-open',i===s.step&&!s.done);li.classList.toggle('is-set',[!!s.table,!!when(),!!s.guests][i])});
  $$('[data-rsv="table"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.arg===s.table)));
  $$('[data-rsv="day"]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.arg)===s.day)));
  $$('[data-rsv="slot"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.arg===s.slot)));
  const cap=table()?.capacity||6;
  $$('[data-rsv="guests"]').forEach(b=>{b.disabled=Number(b.dataset.arg)>cap;b.classList.toggle('is-on',Number(b.dataset.arg)===s.guests)});
  $('#rsv-count').textContent=num(s.guests||s.count);
  $('[data-summary="table"]').textContent=table()?`${table().label} · ${t(table().zone)}`:'';
  $('[data-summary="time"]').textContent=when();
  $('[data-summary="guests"]').textContent=s.guests?num(s.guests):'';
  field('table',table()?`${table().label} · ${t(table().zone)}`:'');
  field('when',when());
  field('guests',s.guests?`${num(s.guests)} ${t('guests')}`:'');
  $('[data-rsv="confirm"]').disabled=!(s.table&&when()&&s.guests);
 }
 // A choice stays on screen for a beat, selected, before the next step opens.
 let pending=0;
 function next(step){
  clearTimeout(pending);
  if(reduced){s.step=step;return}
  const state=s;
  pending=setTimeout(()=>{if(s===state&&!s.done){s.step=step;paint()}},750);
 }
 box.addEventListener('click',ev=>{
  const el=ev.target.closest('[data-rsv]');
  if(!el||el.disabled)return;
  const arg=el.dataset.arg,cap=table()?.capacity||6;
  switch(el.dataset.rsv){
   case 'open':clearTimeout(pending);s.step=Number(arg);s.done=false;break;
   case 'table':s.table=arg;if(s.guests>table().capacity)s.guests=table().capacity;s.done=false;next(1);break;
   case 'day':s.day=Number(arg);break;
   case 'slot':s.slot=arg;if(s.day===null)s.day=2;next(2);break;
   case 'guests':s.guests=s.count=Number(arg);break;
   case 'less':s.guests=s.count=Math.max(1,(s.guests||s.count)-1);break;
   case 'more':s.guests=s.count=Math.min(cap,(s.guests||s.count)+1);break;
   case 'confirm':s.done=true;break;
  }
  paint();
 });
 const roomy=tables.find(x=>x.capacity>=6)||tables[0];
 if(reduced){s={step:2,table:roomy.id,day:2,slot:'20:00',guests:Math.min(6,roomy.capacity),count:6,done:true}}
 paint();
 createTour(box,{t,reduced,hold:5200,
  manualHint:'Choose a table, a time and the party size, then confirm.',
  script:async({c,tap,say})=>{
   say('First, the table they want');
   await c.wait(2400);
   await tap(c,`[data-rsv="table"][data-arg="${CSS.escape(roomy.id)}"]`,{wait:900});
   say('Then the date and time');
   await c.wait(1900);
   await tap(c,'[data-rsv="day"][data-arg="2"]',{wait:1000});
   await tap(c,'[data-rsv="slot"][data-arg="20:00"]',{wait:900});
   say('Then the number of guests');
   await c.wait(1800);
   await tap(c,`[data-rsv="guests"][data-arg="${Math.min(6,roomy.capacity)}"]`,{wait:1400});
   say('Confirm, and the ticket is theirs');
   await tap(c,'[data-rsv="confirm"]',{wait:500});
  },
  rewind:async({c})=>{
   box.classList.add('is-swap');
   await c.wait(380);
   clearTimeout(pending);s=fresh();paint();
   box.classList.remove('is-swap');
  }
 });
}

/* Reservation experience.
   A three-step, mobile-first flow: when and who, then the exact table on the
   saved floor, then details. The same endpoints and idempotency keys as before;
   only the interface changed. */
import {copy as c,e,header,api,notice} from './experience-ui.js';
import {money,language,t} from './i18n.js';
import {mountFloorPreview} from './floor-preview.js';

const root=document.querySelector('#app');
const data=await api('public');
const rtl=language==='ar';
const arrow=rtl?'←':'→';
const locale=rtl?'ar-EG':'en-GB';
const ZONE='Africa/Cairo';

/* ------------------------------------------------------------- calendar */
const cairoParts=d=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const isoOf=d=>{const p=cairoParts(d);return `${p.year}-${p.month}-${p.day}`};
const today=isoOf(new Date());
const dayList=Array.from({length:21},(_,i)=>isoOf(new Date(Date.now()+i*86400000)));
const dayLabel=iso=>{
 const d=new Date(iso+'T12:00:00Z');
 return {
  weekday:new Intl.DateTimeFormat(locale,{weekday:'short',timeZone:'UTC'}).format(d),
  day:new Intl.DateTimeFormat(locale,{day:'numeric',timeZone:'UTC'}).format(d),
  month:new Intl.DateTimeFormat(locale,{month:'short',timeZone:'UTC'}).format(d)
 };
};
// Cairo wall-clock time to a UTC instant, resolving the offset iteratively.
function startAt(date,time){
 const naive=Date.parse(date+'T'+time+':00Z');
 let utc=naive;
 for(let i=0;i<3;i++){
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,timeZoneName:'longOffset'}).formatToParts(new Date(utc));
  const offset=parts.find(p=>p.type==='timeZoneName').value.match(/GMT([+-])(\d{2}):(\d{2})/);
  const minutes=offset?(Number(offset[2])*60+Number(offset[3]))*(offset[1]==='-'?-1:1):0;
  utc=naive-minutes*60000;
 }
 return utc;
}
const services={
 dinner:{label:['Dinner','العشاء'],from:17,to:23},
 lunch:{label:['Lunch','الغداء'],from:12,to:16}
};
const slotsFor=key=>{
 const {from,to}=services[key],out=[];
 for(let h=from;h<=to;h++){out.push(String(h).padStart(2,'0')+':00');if(h<to)out.push(String(h).padStart(2,'0')+':30');}
 return out;
};
const timeText=value=>new Date(value).toLocaleString(locale,{timeZone:ZONE,dateStyle:'full',timeStyle:'short'});
const shortText=value=>new Intl.DateTimeFormat(locale,{timeZone:ZONE,weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const shortWhen=()=>`${dayLabel(date).weekday} ${dayLabel(date).day} ${dayLabel(date).month} · ${time}`;

/* ---------------------------------------------------------------- state */
const branches=data.branches.filter(b=>b.active&&b.reservations);
let step=1,date=today,service='dinner',time=null,party=2;
let branchId=branches[0]?.id||'main';
let filter='',selected=null,available=[],tableStates={};
let slotCounts={},slotRun=0,request=0,busy=false,reservation=null;

const filters=[['Non-smoking','Non-smoking','غير مدخنين'],['Smoking','Smoking','مدخنين'],['Window side','Window','الشباك'],['Terrace','Terrace','التراس'],['Quiet area','Quiet','هادئ'],['Outdoor','Outdoor','خارجي'],['Near bar','Near bar','قرب البار'],['Accessible','Accessible','سهولة الوصول']];
const query=()=>({branchId,start:startAt(date,time),party});
const branchName=b=>rtl&&b.nameAr?b.nameAr:b.name;
const visibleTables=()=>data.floor.tables.filter(x=>(x.branchId||'main')===branchId);
const matchingTables=()=>visibleTables().filter(x=>available.includes(x.id)&&(!filter||(x.features||[]).includes(filter)));
// Ten minutes of head room: a slot the kitchen could not realistically take.
const isPast=(d,tm)=>startAt(d,tm)<Date.now()+600000;

/* --------------------------------------------------------------- shell  */
function shell(){
 document.title=c('Reserve a table','احجز طاولة')+' · '+data.settings.name;
 root.className='bk';
 root.innerHTML=header()+`<main class="bk-page">
 <a class="bk-back" href="/restaurant">${rtl?'→':'←'} ${e(data.settings.name)}</a>
 <div class="bk-head">
  <h1>${c('Reserve a table','احجز طاولتك')}</h1>
  <p>${c('Choose when you are coming, pick the exact table on the floor, and hold it in under a minute.','اختر موعدك، ثم اختر طاولتك بالضبط على المخطط، واحجزها في أقل من دقيقة.')}</p>
 </div>
 <div class="bk-layout">
  <section class="bk-step" id="step-1"><header><button type="button" data-step="1"><span class="bk-step-index"><span>1</span></span><span class="bk-step-title"><strong>${c('Time and guests','الموعد والضيوف')}</strong><small data-slot="sum-1"></small></span><span class="bk-step-edit">${c('Edit','تعديل')}</span></button></header><div class="bk-step-body" id="body-1"></div></section>
  <section class="bk-step" id="step-2"><header><button type="button" data-step="2"><span class="bk-step-index"><span>2</span></span><span class="bk-step-title"><strong>${c('Your table','طاولتك')}</strong><small data-slot="sum-2"></small></span><span class="bk-step-edit">${c('Edit','تعديل')}</span></button></header><div class="bk-step-body" id="body-2"></div></section>
  <section class="bk-step" id="step-3"><header><button type="button" data-step="3"><span class="bk-step-index"><span>3</span></span><span class="bk-step-title"><strong>${c('Your details','بياناتك')}</strong><small data-slot="sum-3"></small></span><span class="bk-step-edit">${c('Edit','تعديل')}</span></button></header><div class="bk-step-body" id="body-3"></div></section>
 </div>
</main>
<div class="bk-bar"><div class="bk-bar-inner"><div class="bk-summary" id="bar-summary"></div><button type="button" class="bk-cta" id="bar-cta"></button></div></div>`;
 root.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>goto(Number(b.dataset.step)));
 root.querySelector('#bar-cta').onclick=advance;
}

const $=s=>root.querySelector(s);

function goto(next){
 if(next===2&&!time)return;
 if(next===3&&!selected)return notice(c('Choose a table first.','اختر طاولة أولًا.'));
 step=next;
 paintSteps();
 const el=$('#step-'+next);
 if(el)el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});
 if(next===3)setTimeout(()=>$('#bk-name')?.focus(),260);
}

function advance(){
 if(step===1)return goto(2);
 if(step===2)return goto(3);
 $('#bk-form')?.requestSubmit();
}

/* ------------------------------------------------------------- step one */
function renderStep1(){
 // Times that have already gone are dropped rather than shown greyed out.
 const all=slotsFor(service),slots=all.filter(x=>!isPast(date,x));
 const dropped=all.length-slots.length;
 const many=branches.length>1;
 $('#body-1').innerHTML=`
 ${many?`<div class="bk-field"><span class="bk-label">${c('Branch','الفرع')}</span><select class="bk-select" id="bk-branch">${branches.map(b=>`<option value="${e(b.id)}" ${branchId===b.id?'selected':''}>${e(branchName(b))}</option>`).join('')}</select></div>`:''}
 <div class="bk-field">
  <span class="bk-label">${c('Date','التاريخ')}<b>${date===today?c('Today','اليوم'):''}</b></span>
  <div class="bk-days" id="bk-days">${dayList.map(iso=>{const l=dayLabel(iso);return `<button type="button" class="bk-day${date===iso?' is-on':''}" data-date="${iso}"><small>${iso===today?c('Today','اليوم'):l.weekday}</small><b>${l.day}</b><i>${l.month}</i></button>`}).join('')}</div>
 </div>
 <div class="bk-field">
  <span class="bk-label">${c('Guests','الضيوف')}</span>
  <div class="bk-party">
   <div class="bk-stepper"><button type="button" data-party="-1" aria-label="${c('Fewer guests','ضيوف أقل')}" ${party<=1?'disabled':''}>−</button><output aria-live="polite">${party} ${party===1?c('guest','ضيف'):c('guests','ضيوف')}</output><button type="button" data-party="1" aria-label="${c('More guests','ضيوف أكثر')}" ${party>=20?'disabled':''}>+</button></div>
   <div class="bk-quick">${[2,4,6,8].map(n=>`<button type="button" class="${party===n?'is-on':''}" data-party-set="${n}">${n}</button>`).join('')}</div>
  </div>
 </div>
 <div class="bk-field">
  <span class="bk-label">${c('Time · Cairo','الوقت · القاهرة')}<b class="bk-service">${Object.entries(services).map(([k,v])=>`<button type="button" class="${service===k?'is-on':''}" data-service="${k}">${c(...v.label)}</button>`).join('')}</b></span>
  ${slots.length?`<div class="bk-slots" id="bk-slots">${slots.map(s=>{
   const n=slotCounts[s];
   return `<button type="button" class="bk-slot${time===s?' is-on':''}${n===undefined?' is-loading':''}" data-time="${s}" ${n===0?'disabled':''}>
    <b>${s}</b><small>${n===undefined?'···':n?`${n} ${c('free','متاحة')}`:c('Full','مكتمل')}</small></button>`;
  }).join('')}</div>`:`<div class="bk-empty"><p>${c('No more sittings today.','لا توجد مواعيد أخرى اليوم.')}</p><button type="button" data-date="${dayList[1]}">${c('Try tomorrow','جرّب الغد')} ${arrow}</button></div>`}
  <p class="bk-note">${dropped?c('Earlier sittings today have passed. ','مواعيد اليوم الأبكر مضت. '):''}${c('Tables are held for','تُحجز الطاولة لمدة')} ${data.settings.duration} ${c('minutes.','دقيقة.')}${dropped&&slots.length&&slots.length<4?` <button type="button" class="bk-inline" data-date="${dayList[1]}">${c('See tomorrow’s full list','اعرض مواعيد الغد كاملة')} ${arrow}</button>`:''}</p>
 </div>`;
 $('#bk-branch')&&($('#bk-branch').onchange=ev=>{branchId=ev.target.value;selected=null;refresh();});
 root.querySelectorAll('[data-date]').forEach(b=>b.onclick=()=>{date=b.dataset.date;selected=null;if(isPast(date,time))time=null;refresh();});
 root.querySelectorAll('[data-party]').forEach(b=>b.onclick=()=>{party=Math.min(20,Math.max(1,party+Number(b.dataset.party)));selected=null;refresh();});
 root.querySelectorAll('[data-party-set]').forEach(b=>b.onclick=()=>{party=Number(b.dataset.partySet);selected=null;refresh();});
 root.querySelectorAll('[data-service]').forEach(b=>b.onclick=()=>{service=b.dataset.service;slotCounts={};renderStep1();loadSlots();});
 root.querySelectorAll('[data-time]').forEach(b=>b.onclick=()=>{time=b.dataset.time;selected=null;refresh().then(()=>goto(2));});
}

/* Availability for every slot in the visible service, so a guest can see at a
   glance which times their party actually fits into. */
async function loadSlots(){
 const run=++slotRun,slots=slotsFor(service).filter(s=>!isPast(date,s));
 const results=await Promise.all(slots.map(s=>
  api('availability?'+new URLSearchParams({branchId,start:startAt(date,s),party}))
   .then(r=>r.tableIds.length).catch(()=>undefined)));
 if(run!==slotRun)return;
 slotCounts=Object.fromEntries(slots.map((s,i)=>[s,results[i]]));
 if(step===1)renderStep1();
 paintBar();
}

/* ------------------------------------------------------------- step two */
let mapMounted=false;
function renderStep2(){
 const list=matchingTables();
 $('#body-2').innerHTML=`
 <div class="bk-picker">
  <div class="bk-chips" role="group" aria-label="${c('Table features','مميزات الطاولة')}">
   <button type="button" data-filter="" aria-pressed="${!filter}">${c('All tables','كل الطاولات')}</button>
   ${filters.map(([value,en,ar])=>`<button type="button" data-filter="${value}" aria-pressed="${filter===value}">${c(en,ar)}</button>`).join('')}
  </div>
  <div class="bk-map" id="bk-map"></div>
  <div class="bk-tables" id="bk-list">${list.length?list.map(x=>{
   const on=selected===x.id;
   const tags=(x.features||[]).filter(f=>f!==x.zone).slice(0,2).map(f=>t(f));
   return `<button type="button" class="bk-table${on?' is-on':''}" data-table="${e(x.id)}" aria-pressed="${on}">
    <span class="bk-table-mark">${on?'✓':e(x.label)}</span>
    <strong>${e(t(x.zone))}</strong>
    <small>${x.capacity} ${c('seats','مقاعد')}${tags.length?' · '+tags.map(e).join(' · '):''}</small>
    ${x.premium?`<b>${c('Premium','مميزة')}</b>`:x.minimumSpend?`<b>${money(x.minimumSpend)}</b>`:''}
   </button>`}).join(''):`<div class="bk-empty"><p>${c('No table fits this time and party size.','لا توجد طاولة تناسب هذا الموعد والعدد.')}</p><button type="button" data-step="1">${c('Change the time or guests','غيّر الموعد أو عدد الضيوف')} ${arrow}</button></div>`}</div>
  <div class="bk-legend"><span><i></i>${c('Available','متاحة')}</span><span><i class="l-sel"></i>${c('Selected','المختارة')}</span><span><i class="l-off"></i>${c('Taken at this time','محجوزة في هذا الموعد')}</span></div>
 </div>`;
 root.querySelectorAll('#body-2 [data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;renderStep2();paintMap();});
 root.querySelectorAll('#body-2 [data-table]').forEach(b=>b.onclick=()=>select(b.dataset.table));
 root.querySelectorAll('#body-2 [data-step]').forEach(b=>b.onclick=()=>goto(Number(b.dataset.step)));
 mapMounted=false;
 mountMap();
}

function mountMap(){
 const host=$('#bk-map');
 if(!host||mapMounted)return;
 mountFloorPreview(host,{...data.floor,tables:visibleTables()},{onSelect:select});
 mapMounted=true;
 paintMap();
}

function paintMap(){
 const host=$('#bk-map');
 if(!host)return;
 for(const x of visibleTables()){
  const g=host.querySelector(`[data-object-id="${CSS.escape(x.id)}"]`);
  if(!g)continue;
  const free=available.includes(x.id)&&(!filter||(x.features||[]).includes(filter));
  const state=selected===x.id?'is-selected':free?'available':'unavailable';
  g.setAttribute('class','floor-object svg-table state-'+state);
  g.setAttribute('aria-disabled',String(!free));
  g.setAttribute('tabindex',free?'0':'-1');
 }
}

function select(id){
 if(!available.includes(id))return notice(c('That table is not free at this time.','هذه الطاولة غير متاحة في هذا الموعد.'));
 selected=id;
 renderStep2();
 paintSteps();
 paintBar();
}

/* ----------------------------------------------------------- step three */
function renderStep3(){
 const table=visibleTables().find(x=>x.id===selected);
 const live=data.payments.mode==='live';
 $('#body-3').innerHTML=`
 <form class="bk-form" id="bk-form">
  <label>${c('Your name','اسمك')}<input id="bk-name" name="name" required maxlength="100" autocomplete="name" placeholder="${c('Full name','الاسم بالكامل')}"></label>
  <label>${c('Phone or email','هاتف أو بريد إلكتروني')}<input name="contact" required maxlength="100" autocomplete="tel" placeholder="${c('So the restaurant can reach you','حتى يتواصل معك المطعم')}"></label>
  <label>${c('Anything we should know? (optional)','هل من ملاحظات؟ (اختياري)')}<textarea name="notes" maxlength="300" placeholder="${c('Birthday, high chair, allergy…','عيد ميلاد، كرسي أطفال، حساسية…')}"></textarea></label>
  <div class="bk-deposit"><div><strong>${money(data.settings.deposit)}</strong><small>${live?c('Online deposits are not enabled here. The restaurant will contact you.','العربون الإلكتروني غير مفعّل. سيتواصل معك المطعم.'):c('Test deposit only — no real charge. It is credited to your bill.','عربون تجريبي فقط دون خصم حقيقي، ويُخصم من فاتورتك.')}</small></div></div>
  ${table?`<p class="bk-note">${e(table.label)} · ${e(t(table.zone))} · ${timeText(startAt(date,time))} · ${party} ${c('guests','ضيوف')}</p>`:''}
 </form>`;
 $('#bk-form').onsubmit=confirmBooking;
}

async function confirmBooking(ev){
 ev.preventDefault();
 if(busy)return;
 const form=ev.target;
 if(!form.reportValidity())return;
 busy=true;paintBar();
 const cta=$('#bar-cta');
 reservation=null;
 try{
  const f=new FormData(form);
  const body={...query(),tableId:selected,name:f.get('name'),contact:f.get('contact'),notes:f.get('notes')||undefined};
  let pending;
  try{pending=JSON.parse(sessionStorage.getItem('resuto-booking-pending'));}catch{}
  if(!pending||JSON.stringify(pending.body)!==JSON.stringify(body))pending={body,key:crypto.randomUUID()};
  sessionStorage.setItem('resuto-booking-pending',JSON.stringify(pending));
  reservation=await api('reserve',{...body,key:pending.key});
  sessionStorage.setItem('resuto-reservation',reservation.token);
  reservation=await api('deposit',{token:reservation.token,key:'confirm-'+reservation.token});
  sessionStorage.removeItem('resuto-booking-pending');
  history.replaceState(null,'','/reserve#'+reservation.token);
  await confirmation(reservation.token);
 }catch(err){
  notice(t(err.message));
  if(reservation?.token){
   history.replaceState(null,'','/reserve#'+reservation.token);
   try{await confirmation(reservation.token);}
   catch{notice(c('Connection lost. Your hold is saved; retry the confirmation.','انقطع الاتصال. الحجز المؤقت محفوظ؛ أعد محاولة التأكيد.'));}
  }
 }finally{busy=false;if(cta&&document.contains(cta))paintBar();}
}

/* ---------------------------------------------------------------- paint */
function paintSteps(){
 for(let n=1;n<=3;n++){
  const el=$('#step-'+n);
  if(!el)continue;
  const done=n===1?!!time:n===2?!!selected:false;
  el.classList.toggle('is-open',step===n);
  el.classList.toggle('is-done',done&&step!==n);
 }
 const table=visibleTables().find(x=>x.id===selected);
 $('[data-slot="sum-1"]').textContent=time?`${shortWhen()} · ${party} ${party===1?c('guest','ضيف'):c('guests','ضيوف')}`:c('Pick a date and time','اختر التاريخ والوقت');
 $('[data-slot="sum-2"]').textContent=table?`${table.label} · ${t(table.zone)} · ${table.capacity} ${c('seats','مقاعد')}`:time?`${matchingTables().length} ${c('tables free','طاولة متاحة')}`:c('Choose your time first','اختر الموعد أولًا');
 $('[data-slot="sum-3"]').textContent=c('Name and contact','الاسم ووسيلة التواصل');
 if(step===1)renderStep1();
 if(step===2)renderStep2();
 if(step===3)renderStep3();
 paintBar();
}

function paintBar(){
 const summary=$('#bar-summary'),cta=$('#bar-cta');
 if(!summary||!cta)return;
 const table=visibleTables().find(x=>x.id===selected);
 summary.innerHTML=`<strong>${time?e(shortWhen()):c('Choose a time','اختر الموعد')}</strong><small>${party} ${party===1?c('guest','ضيف'):c('guests','ضيوف')}${table?' · '+e(table.label)+' · '+e(t(table.zone)):time?' · '+matchingTables().length+' '+c('tables free','طاولة متاحة'):''}</small>`;
 const label=step===1?c('Choose a table','اختر طاولة'):step===2?c('Continue','متابعة'):c('Confirm reservation','تأكيد الحجز');
 cta.innerHTML=busy?`<span class="bk-spinner"></span>${c('Holding…','جارٍ الحجز…')}`:`${label} ${arrow}`;
 cta.disabled=busy||(step===1&&!time)||(step===2&&!selected);
}

/* --------------------------------------------------------------- loader */
async function refresh(){
 const n=++request;
 if(!time){available=[];tableStates={};paintSteps();loadSlots();return;}
 try{
  const result=await api('availability?'+new URLSearchParams(query()));
  if(n!==request)return;
  available=result.tableIds;tableStates=result.tableStates;
  if(!available.includes(selected))selected=null;
 }catch(err){
  if(n!==request)return;
  available=[];tableStates={};selected=null;
  notice(t(err.message));
 }
 paintSteps();
 paintMap();
 loadSlots();
}

/* --------------------------------------------------------- confirmation */
async function confirmation(token){
 const r=await api('reservation?token='+encodeURIComponent(token));
 reservation=r;
 const held=r.status==='held';
 const good=r.status==='confirmed';
 document.title=(good?c('Reservation confirmed','تم تأكيد الحجز'):c('Your reservation','حجزك'))+' · '+r.restaurant;
 root.className='bk';
 root.innerHTML=header()+`<main class="bk-done">
 <span class="bk-seal${good?'':' is-wait'}">${good?'✓':held?'◷':'!'}</span>
 <h1>${good?c('Your table is booked','طاولتك محجوزة'):held?c('Table held for you','الطاولة محجوزة مؤقتًا'):r.status==='cancelled'?c('Reservation cancelled','تم إلغاء الحجز'):r.status==='expired'?c('The hold expired','انتهت مهلة الحجز'):c('Reservation','الحجز')}</h1>
 <p>${good?c('We sent nothing by email — this is a demo. Show this screen at the door.','لم نرسل بريدًا؛ هذا عرض تجريبي. اعرض هذه الشاشة عند الوصول.'):held?c('Complete the test deposit to confirm it.','أكمل العربون التجريبي لتأكيد الحجز.'):''}</p>
 <div class="bk-card">
  <h2>${e(r.restaurant)}</h2>
  <dl>
   <div><dt>${c('When','الموعد')}</dt><dd>${e(shortText(r.start))}</dd></div>
   <div><dt>${c('Guests','الضيوف')}</dt><dd>${r.party}</dd></div>
   <div><dt>${c('Table','الطاولة')}</dt><dd>${e(r.table.label)} · ${e(t(r.table.zone))}</dd></div>
   <div><dt>${c('Branch','الفرع')}</dt><dd>${e(r.branch.name)}</dd></div>
  </dl>
  <div class="bk-rip"></div>
  <dl><div><dt>${c('Test deposit','عربون تجريبي')}</dt><dd>${money(r.deposit)}</dd></div><div><dt>${c('Reference','الرقم المرجعي')}</dt><dd>${e(String(r.id).slice(0,8))}</dd></div></dl>
  <p class="bk-note" style="margin-block-start:14px">${c('The deposit is credited toward your visit. The rest depends on your order.','يُخصم العربون من حساب زيارتك، والباقي حسب طلبك.')}${r.refundStatus?' '+c('Contact the restaurant about the refund.','تواصل مع المطعم بخصوص الاسترداد.'):''}</p>
 </div>
 <div class="bk-actions">
  ${held?`<button type="button" class="is-primary" data-confirm="deposit">${c('Complete test deposit','إكمال العربون التجريبي')}</button>`:''}
  ${good?`<button type="button" class="is-primary" data-confirm="calendar">${c('Add to calendar','إضافة للتقويم')}</button><button type="button" data-confirm="share">${c('Share','مشاركة')}</button><button type="button" data-confirm="modify">${c('Change the time','تغيير الموعد')}</button><button type="button" class="is-danger" data-confirm="cancel">${c('Cancel','إلغاء')}</button>`:''}
  ${r.branch.mapsUrl?`<a href="${e(r.branch.mapsUrl)}" target="_blank" rel="noopener">${c('Directions','الاتجاهات')}</a>`:''}
  <a href="/restaurant">${c('Back to the restaurant','العودة للمطعم')}</a>
 </div>
</main>`;
 root.querySelectorAll('[data-confirm]').forEach(b=>b.onclick=()=>action(b,r,token));
}

async function action(button,r,token){
 const kind=button.dataset.confirm;
 try{
  if(kind==='deposit'){
   button.disabled=true;
   await api('deposit',{token:r.token,key:'confirm-'+r.token});
   return confirmation(token);
  }
  if(kind==='cancel'){
   if(!confirm(c('Cancel this reservation?','هل تريد إلغاء الحجز؟')))return;
   await api('reservation-change',{token:r.token,action:'cancel',key:crypto.randomUUID()});
   return confirmation(token);
  }
  if(kind==='share'){
   const text=`${r.restaurant} · ${timeText(r.start)} · ${r.table.label} · ${r.party} ${c('guests','ضيوف')}`;
   if(navigator.share)return navigator.share({title:r.restaurant,text});
   await navigator.clipboard.writeText(text);
   return notice(c('Reservation details copied','تم نسخ تفاصيل الحجز'));
  }
  if(kind==='calendar'){
   const stamp=n=>new Date(n).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
   const esc=s=>String(s).replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g,'\\$&');
   const text=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Resuto//Reservations//EN','BEGIN:VEVENT','UID:'+r.id+'@resuto','DTSTAMP:'+stamp(Date.now()),'DTSTART:'+stamp(r.start),'DTEND:'+stamp(r.end),'SUMMARY:'+esc(r.restaurant+' · '+r.table.label),'LOCATION:'+esc(r.branch.address||r.branch.name),'END:VEVENT','END:VCALENDAR'].join('\r\n');
   const url=URL.createObjectURL(new Blob([text],{type:'text/calendar'})),a=document.createElement('a');
   a.href=url;a.download='reservation.ics';a.click();
   return setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  if(kind==='modify'){
   button.disabled=true;
   root.querySelector('.bk-actions').insertAdjacentHTML('afterend',`<form class="bk-card bk-form" id="bk-modify"><h2>${c('Pick a new time','اختر موعدًا جديدًا')}</h2><label>${c('Date','التاريخ')}<input name="date" type="date" value="${isoOf(new Date(r.start))}" min="${today}" required></label><label>${c('Time · Cairo','الوقت · القاهرة')}<input name="time" type="time" value="${new Intl.DateTimeFormat('en-GB',{timeZone:ZONE,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(r.start))}" required></label><button class="bk-cta" type="submit">${c('Save the new time','حفظ الموعد الجديد')}</button></form>`);
   const form=root.querySelector('#bk-modify');
   form.onsubmit=async ev=>{
    ev.preventDefault();
    const f=new FormData(form);
    date=f.get('date');time=f.get('time');
    try{
     await api('reservation-change',{token:r.token,action:'modify',tableId:r.table.id,party:r.party,branchId:r.branch.id,start:startAt(date,time),key:crypto.randomUUID()});
     await confirmation(token);
    }catch(err){notice(t(err.message));}
   };
   return;
  }
 }catch(err){
  button.disabled=false;
  if(err.name!=='AbortError')notice(t(err.message));
 }
}

/* ----------------------------------------------------------------- boot */
// Open on the first slot the restaurant could still take today, otherwise
// tomorrow evening, so the guest never lands on an impossible time.
function openingSlot(){
 for(const key of ['dinner','lunch']){
  const open=slotsFor(key).filter(x=>!isPast(date,x));
  // One or two sittings left is not a choice; start the guest on tomorrow.
  if(open.length>=3)return {service:key,time:open[Math.min(open.length-1,open.indexOf(open.find(x=>x>='20:00'))>=0?open.indexOf(open.find(x=>x>='20:00')):0)]};
 }
 date=dayList[1];
 return {service:'dinner',time:'20:00'};
}
if(!time){const pick=openingSlot();service=pick.service;time=pick.time;}

if(location.hash.length>1){
 try{await confirmation(location.hash.slice(1));}
 catch(err){notice(t(err.message));history.replaceState(null,'','/reserve');shell();await refresh();}
}else{
 shell();
 await refresh();
}

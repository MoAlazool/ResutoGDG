// Front-of-house (host / door) workspace.
//
// One screen for the person standing at the entrance: what is free right now,
// who is booked, and who is waiting to be settled. Deliberately narrow — no
// menu editing, no floor layout, no exports, no analytics. Those stay with the
// manager, and the server enforces that regardless of what this renders.
import {tr} from './owner-import.js';
import {t} from './i18n.js';
import {escapeHtml as e} from './floor-shared.js';

const money=n=>new Intl.NumberFormat('en-EG',{maximumFractionDigits:2}).format(n/100);
const clock=at=>new Date(at).toLocaleTimeString('en-GB',{timeZone:'Africa/Cairo',hour:'2-digit',minute:'2-digit'});
const day=at=>new Date(at).toLocaleDateString('en-GB',{timeZone:'Africa/Cairo',day:'numeric',month:'short'});
const isToday=at=>day(at)===day(Date.now());

// Seat count a table can still take, used to rank walk-in options.
const zoneName=zone=>zone?t(zone):'';
const seatable=(tables,party)=>tables.filter(t=>t.capacity>=party).sort((a,b)=>a.capacity-b.capacity);

export function hostPage(data,{floorSvg,tableState}){
 const tables=data.tables.filter(t=>t.active);
 const state=Object.fromEntries(tables.map(t=>[t.id,tableState(t)]));
 const free=tables.filter(t=>state[t.id].state==='available');
 const freeSeats=free.reduce((n,t)=>n+t.capacity,0);
 const openVisits=(data.visits||[]).filter(v=>v.status==='open');
 const needsAttention=openVisits.filter(v=>v.bill?.due>0&&['payment','partially-paid'].includes(state[v.tableId]?.state));
 const waiting=(data.requests||[]).filter(r=>r.status==='open');

 const soon=(data.reservations||[])
  .filter(r=>['confirmed','held'].includes(r.status)&&r.end>Date.now()&&isToday(r.start))
  .sort((a,b)=>a.start-b.start).slice(0,12);

 const stat=(label,value,note)=>`<div><span>${label}</span><strong>${value}</strong><p>${note}</p></div>`;

 return `<div class="page-heading"><div><div class="eyebrow">${e(data.settings.name)} <span> / </span> ${e(data.settings.branch)}</div>
   <h1>${tr('Front desk','الاستقبال')}</h1><p>${tr('Who is in, what is free, and who is next.','مين موجود، وإيه المتاح، ومين اللي جاي.')}</p></div>
   <div class="heading-actions">${`<button type="button" class="primary" data-action="walkin">＋ ${tr('Seat a walk-in','استقبال ضيف')}</button>`}</div></div>

  <div class="stats">
   ${stat(tr('Tables free','طاولات متاحة'),`${free.length}<small>/ ${tables.length}</small>`,`${freeSeats} ${tr('seats ready','مقعد جاهز')}`)}
   ${stat(tr('Seated now','جالسون الآن'),String(openVisits.length),`${tables.length-free.length} ${tr('tables in service','طاولة في الخدمة')}`)}
   ${stat(tr('Booked today','حجوزات اليوم'),String(soon.length),tr('Arriving guests','ضيوف قادمون'))}
   ${stat(tr('Needs you','تحتاج انتباهك'),String(waiting.length+needsAttention.length),tr('Requests and open bills','طلبات وفواتير مفتوحة'))}
  </div>

  <div class="host-layout">
   <section class="panel">
    <div class="panel-head"><div><h2>${tr('Available tables','الطاولات المتاحة')}</h2><p>${tr('Tap a free table to seat guests.','اضغط على طاولة متاحة لاستقبال ضيوف.')}</p></div></div>
    ${floorSvg}
   </section>

   <aside class="host-side">
    <section class="panel padded">
     <h2>${tr('Free right now','متاح الآن')}</h2>
     ${free.length?`<div class="host-chips">${free.map(t=>`<button type="button" class="host-chip" data-action="seat" data-id="${e(t.id)}"><strong>${e(t.label)}</strong><small>${t.capacity} ${tr('seats','مقاعد')} · ${e(zoneName(t.zone))}</small></button>`).join('')}</div>`
      :`<p class="fine">${tr('Every table is in service. The board updates the moment one frees up.','كل الطاولات في الخدمة. اللوحة بتتحدث فور ما تتحرر واحدة.')}</p>`}
    </section>

    <section class="panel padded">
     <h2>${tr('Arriving today','قادمون اليوم')}</h2>
     ${soon.length?`<div class="host-list">${soon.map(r=>{const table=data.tables.find(t=>t.id===r.tableId),ready=Date.now()>=r.start-15*60000&&Date.now()<=r.start+30*60000;
       return `<div class="host-row"><div><strong>${e(r.name)}</strong><small>${clock(r.start)} · ${e(table?.label||'')} · ${r.party} ${tr('guests','ضيوف')}</small></div>
        ${r.status==='confirmed'&&ready?`<button type="button" class="secondary small" data-action="checkin" data-id="${e(r.id)}">${tr('Check in','تسجيل وصول')}</button>`
         :`<span class="badge ${r.status}">${r.status==='confirmed'?tr('Confirmed','مؤكد'):tr('Held','حجز مؤقت')}</span>`}</div>`}).join('')}</div>`
      :`<p class="fine">${tr('No bookings left for today.','لا توجد حجوزات متبقية اليوم.')}</p>`}
    </section>

    <section class="panel padded">
     <h2>${tr('Open bills','فواتير مفتوحة')}</h2>
     ${openVisits.filter(v=>v.bill?.due>0).length?`<div class="host-list">${openVisits.filter(v=>v.bill?.due>0).map(v=>`<div class="host-row"><div><strong>${e(data.tables.find(t=>t.id===v.tableId)?.label||v.type)}</strong><small>${e(v.name)}</small></div><b>EGP ${money(v.bill.due)}</b></div>`).join('')}</div>`
      :`<p class="fine">${tr('Every table is settled.','كل الطاولات مسددة.')}</p>`}
     <p class="fine">${tr('Guests settle from their own phone. Ask a manager for anything else.','الضيوف يدفعون من هواتفهم. لأي شيء آخر ارجع للمدير.')}</p>
    </section>

    <section class="panel padded">
     <h2>${tr('Service requests','طلبات الخدمة')}</h2>
     ${waiting.length?`<div class="host-list">${waiting.map(r=>`<div class="host-row"><div><strong>${e(data.tables.find(t=>t.id===r.tableId)?.label||tr('Order','طلب'))}</strong><small>${r.type==='bill'?tr('Asked for the bill','طلب الفاتورة'):tr('Asked for a server','طلب النادل')} · ${clock(r.created)}</small></div><button type="button" class="secondary small" data-action="resolve" data-id="${e(r.id)}">${tr('Done','تم')}</button></div>`).join('')}</div>`
      :`<p class="fine">${tr('You are all caught up.','كل شيء تحت السيطرة.')}</p>`}
    </section>
   </aside>
  </div>`;
}

// Table options for the walk-in dialog, smallest table that fits first.
export const walkinTables=(data,tableState,party=2)=>seatable(data.tables.filter(t=>t.active&&tableState(t).state==='available'),party);

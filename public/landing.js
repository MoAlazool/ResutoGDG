/* Resuto landing page — a product-led, live composition.
   Everything on this page is rendered from the same data and floor renderer the
   real product uses, so the marketing surface cannot drift from the app. */
import {sceneSvg,escapeHtml as e} from './floor-shared.js';
import {money,t,language,switcher} from './i18n.js';
import logos from './company-logos.js';

const payload=await Promise.all([
 fetch('/api/public').then(r=>r.json()),
 fetch('/api/integration-capabilities').then(r=>r.json()).catch(()=>({native:true,connectors:[],payments:[]})),
 fetch('/api/plans').then(r=>r.json()).catch(()=>({plans:[],billingEnabled:false}))
]).catch(()=>null);
if(!payload){
 // The API is unreachable, or the visitor navigated away mid-load. Say so
 // plainly and stop evaluating rather than throwing into the console.
 const shell=document.querySelector('#app');
 shell.innerHTML='<div class="lp-offline"><p>The restaurant data could not be loaded.</p><button type="button" id="lp-retry">Try again</button></div>';
 shell.querySelector('#lp-retry').onclick=()=>location.reload();
 await new Promise(()=>{});
}
const [data,caps,pricing]=payload;

const root=document.querySelector('#app');
const rtl=language==='ar';
const arrow=rtl?'←':'→';
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const narrow=()=>innerWidth<900;
// A portrait crop of the saved plan: six tables at a readable size on a phone,
// instead of the whole room shrunk to nothing.
const NARROW_VIEW='140 60 480 680';
const menu=data.menu.filter(m=>m.available);
// The shared floor renderer emits English furniture labels; translate the plan
// data (and the one templated seat label) so the Arabic page reads natively.
const localizeScene=svg=>rtl?svg.replace(/>(\d+) seats(<|\s)/g,(m,n,tail)=>`>${num(Number(n))} ${t('seats')}${tail}`):svg;
const localizePlan=f=>({...f,
 zones:(f.zones||[]).map(z=>({...z,label:t(z.label)})),
 objects:(f.objects||[]).map(o=>({...o,label:t(o.label)}))});
const plan=localizePlan(data.floor);
const tables=plan.tables;
const seats=tables.reduce((n,x)=>n+x.capacity,0);
const branchName=(rtl&&data.branches?.[0]?.nameAr)||data.settings.branch;
const nameOf=m=>rtl&&m.nameAr?m.nameAr:m.name;
const descOf=m=>rtl&&m.descriptionAr?m.descriptionAr:m.description;
const num=n=>new Intl.NumberFormat(rtl?'ar-EG':'en-US').format(n);
const clock=(h,m)=>new Date(2024,0,1,h,m).toLocaleTimeString(rtl?'ar-EG':'en-US',{hour:'numeric',minute:'2-digit'});
const dish=(m,cls='')=>`<span class="lp-photo ${cls}" role="img" aria-label="${e(nameOf(m))}" style="--px:${m.imageIndex%2?90:10}%;--py:${Math.floor((m.imageIndex||0)/2)*100/3}%"></span>`;
const tableAt=i=>tables[((i%tables.length)+tables.length)%tables.length];
const seatIndex=i=>tables.length?((i%tables.length)+tables.length)%tables.length:0;
// A viewBox cropped to the furniture keeps small maps readable instead of
// leaving the plan floating inside empty canvas.
function tightView(f,pad=60){
 const items=[...f.tables,...(f.objects||[]),...(f.zones||[])];
 if(!items.length)return `0 0 ${f.width} ${f.height}`;
 const xs=items.map(o=>(o.cx??o.x)-o.width/2),xe=items.map(o=>(o.cx??o.x)+o.width/2);
 const ys=items.map(o=>(o.cy??o.y)-o.height/2),ye=items.map(o=>(o.cy??o.y)+o.height/2);
 const x=Math.max(0,Math.min(...xs)-pad),y=Math.max(0,Math.min(...ys)-pad);
 const w=Math.min(f.width,Math.max(...xe)+pad)-x,h=Math.min(f.height,Math.max(...ye)+pad)-y;
 return `${x} ${y} ${w} ${h}`;
}

/* ---------------------------------------------------------------- chrome */
const wordmark=()=>rtl
 ?`<img class="lp-logo-ar" src="/assets/resuto-arabic-logo.webp" alt="ريسوتو" width="308" height="96">`
 :`<span class="lp-logo-mark" aria-hidden="true">r</span><span class="lp-logo-type">resuto<i>.</i></span>`;

const navLinks=[['#studio','Floor Studio'],['#service','Guest service'],['#operations','Operations'],['#connect','Connect'],['#pricing','Pricing']];

const nav=()=>`<header class="lp-nav" id="lp-nav">
 <div class="lp-nav-inner">
  <a class="lp-logo" href="/" aria-label="Resuto">${wordmark()}</a>
  <nav class="lp-nav-links" aria-label="${t('Sections')}">${navLinks.map(([href,label])=>`<a href="${href}"><span>${t(label)}</span></a>`).join('')}</nav>
  <div class="lp-nav-end">
   ${switcher()}
   <a class="lp-quiet" href="/manager">${t('Staff login')}</a>
   <a class="lp-btn lp-btn-solid" href="/restaurant"><span class="lp-cta-long">${t('Open the live demo')}</span><span class="lp-cta-short">${t('Live demo')}</span></a>
   <button class="lp-burger" data-lp="drawer" data-arg="open" aria-expanded="false" aria-controls="lp-drawer" aria-label="${t('Menu')}"><i></i><i></i></button>
  </div>
 </div>
 <span class="lp-nav-line" aria-hidden="true"><i id="lp-progress"></i></span>
</header>
<div class="lp-drawer" id="lp-drawer" hidden>
 <nav>${navLinks.map(([href,label])=>`<a href="${href}" data-lp="drawer" data-arg="close">${t(label)}</a>`).join('')}<a href="/pricing" data-lp="drawer" data-arg="close">${t('Compare plans')}</a><a href="/manager" data-lp="drawer" data-arg="close">${t('Staff login')}</a></nav>
 <a class="lp-btn lp-btn-solid" href="/restaurant" data-lp="drawer" data-arg="close">${t('Open the live demo')}</a>
</div>`;

/* ------------------------------------------------------------------ hero */
const heroCycle=['available','occupied','preparing','available','ready','reserved','available','occupied','payment','available','cleaning','available'];
const heroStates=tables.map((_,i)=>heroCycle[i%heroCycle.length]);
const feed=[
 {i:8,state:'payment',title:'Bill split four ways',meta:'EGP 1,200 · 2 shares settled'},
 {i:4,state:'ready',title:'Ready to serve',meta:'Cold kitchen · 04:21'},
 {i:2,state:'reserved',title:'Reserved for 8:00 PM',meta:'Party of 6 · Terrace'},
 {i:10,state:'cleaning',title:'Turned and cleaned',meta:'11 min turn time'},
 {i:5,state:'preparing',title:'Fired to the grill',meta:'2 mains · ticket #042'},
 {i:1,state:'occupied',title:'Seated from the waitlist',meta:'Party of 2 · no wait'},
 {i:7,state:'ordering',title:'Ordering by QR',meta:'Menu opened · no app'},
 {i:11,state:'available',title:'Open for walk-ins',meta:'Main Room · 4 seats'}
];

function heroFloor(states){
 const view=narrow()?NARROW_VIEW:`0 0 ${plan.width} ${plan.height}`;
 return `<svg class="lp-floor-svg" viewBox="${view}" role="img" aria-label="${t('Live floor plan of the restaurant')}">${localizeScene(sceneSvg({...plan,tables:tables.map((x,i)=>({...x,state:states[i]}))},{mode:'operations'}))}</svg>`;
}

const heroMetrics=[
 ['covers','Covers tonight',()=>84,''],
 ['turn','Avg turn time',()=>62,' '+t('min')],
 ['tickets','Kitchen tickets',()=>31,''],
 ['split','Shared bills',()=>17,'']
];

const hero=()=>`<section class="lp-hero">
 <div class="lp-hero-glow" aria-hidden="true"></div>
 <div class="lp-shell lp-hero-head">
  <span class="lp-live" data-reveal><i></i>${t('Live service')} · ${e(data.settings.name)} · ${e(branchName)}</span>
  <h1 data-reveal><span>${t('Run the room.')}</span><em>${t('Resuto runs everything else.')}</em></h1>
  <p data-reveal>${t('One operating system for the whole restaurant: AI setup, a living floor plan, guest ordering, kitchen flow, split payments and an AI manager watching the service with you.')}</p>
  <div class="lp-hero-cta" data-reveal>
   <a class="lp-btn lp-btn-solid lp-btn-lg" href="/restaurant">${t('Open the live demo')} ${arrow}</a>
   <a class="lp-btn lp-btn-ghost lp-btn-lg" href="#studio">${t('See the Floor Studio')}</a>
  </div>
 </div>
 <div class="lp-shell">
  <div class="lp-stage" id="hero-stage" data-reveal>
   <header class="lp-stage-bar">
    <span class="lp-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${t('Service view')}</strong>
    <span class="lp-stage-clock" id="hero-clock">${clock(19,42)}</span>
    <span class="lp-stage-live"><i></i>${t('Live')}</span>
   </header>
   <div class="lp-stage-body">
    <div class="lp-stage-floor" id="hero-floor">${heroFloor(heroStates)}</div>
    <aside class="lp-stage-side">
     <div class="lp-side-head"><span>${t('Service feed')}</span><small>${t('Auto-updating')}</small></div>
     <ul class="lp-feed" id="hero-feed"></ul>
     <div class="lp-legend" id="hero-legend"></div>
     <div class="lp-side-table" id="hero-table"></div>
    </aside>
   </div>
   <footer class="lp-stage-metrics">${heroMetrics.map(([id,label,value,suffix])=>`<div><small>${t(label)}</small><strong data-count="${value()}" data-suffix="${suffix}">0${suffix}</strong></div>`).join('')}<div class="lp-stage-note">${t('Demo data from this installation')}</div></footer>
  </div>
 </div>
</section>`;

/* ------------------------------------------------------- the system band */
const systemNodes=[
 ['#setup','Setup','AI profile, menu and floor'],
 ['#studio','Floor Studio','One saved geometry'],
 ['#reserve','Reservations','Guests pick a real table'],
 ['#service','Guest service','QR menu and AI ordering'],
 ['#kitchen','Kitchen','Station routing and timing'],
 ['#payments','Payments','Split, settle, rate'],
 ['#operations','Intelligence','AI manager on duty']
];

const systemBand=()=>`<section class="lp-system" aria-label="${t('How Resuto fits together')}">
 <div class="lp-shell">
  <div class="lp-system-head" data-reveal><h2>${t('Not seven tools. One current running through the service.')}</h2><p>${t('Every part writes to the same floor, the same catalog and the same bill. Nothing is re-entered and nothing is exported at midnight.')}</p></div>
  <div class="lp-system-rail" data-reveal>
   <svg class="lp-system-line" viewBox="0 0 1200 40" preserveAspectRatio="none" aria-hidden="true"><path class="lp-line-base" d="M0 20H1200"/><path class="lp-flow" d="M0 20H1200"/></svg>
   <ol>${systemNodes.map(([href,title,detail],i)=>`<li style="--i:${i}"><a href="${href}"><i aria-hidden="true"></i><strong>${t(title)}</strong><small>${t(detail)}</small></a></li>`).join('')}</ol>
  </div>
 </div>
</section>`;

/* ------------------------------------------- 01 · AI setup and AI floor  */
const presets=[
 {id:'bistro',prompt:'A 60-seat modern bistro in Zamalek with a terrace',type:'Modern bistro',items:38,cols:4,rows:2,cap:4,shape:'square',terrace:4,bar:true},
 {id:'cafe',prompt:'A specialty coffee bar, 24 seats, counter service',type:'Coffee bar',items:22,cols:4,rows:2,cap:2,shape:'round',terrace:2,bar:true},
 {id:'fine',prompt:'A fine dining room for 40 guests with private booths',type:'Fine dining',items:26,cols:3,rows:2,cap:6,shape:'rect',terrace:0,bar:false}
];

function buildFloor(p){
 const W=1200,H=760,built=[],objects=[],zones=[];
 const mainH=p.terrace?450:600,mainY=40+mainH/2;
 zones.push({id:'z-main',type:'zone',label:t('Main Room'),x:W/2,y:mainY,width:W-90,height:mainH,rotation:0,color:'#e9e6dc'});
 if(p.terrace)zones.push({id:'z-terrace',type:'zone',label:t('Terrace'),x:W/2,y:H-115,width:W-90,height:190,rotation:0,color:'#e0e9d7'});
 if(p.bar)objects.push({id:'o-bar',type:'counter',label:t('Bar'),x:W-108,y:mainY,width:64,height:mainH-150,rotation:0});
 objects.push({id:'o-door',type:'door',label:t('Entrance'),x:58,y:H-115,width:120,height:28,rotation:90});
 const w=p.shape==='rect'?150:100,h=p.shape==='rect'?90:100;
 const left=160,right=p.bar?W-200:W-140,top=mainY-mainH/2+100,bottom=mainY+mainH/2-100;
 let n=0;
 for(let r=0;r<p.rows;r++)for(let c=0;c<p.cols;c++){
  const cx=Math.round(left+(right-left)*(p.cols===1?.5:c/(p.cols-1)));
  const cy=Math.round(top+(bottom-top)*(p.rows===1?.5:r/(p.rows-1)));
  built.push({id:'g'+(++n),label:'T'+n,capacity:p.cap,zone:'Main Room',shape:p.shape,cx,cy,width:w,height:h,rotation:0,features:[],state:'available'});
 }
 for(let c=0;c<p.terrace;c++)built.push({id:'g'+(++n),label:'T'+n,capacity:2,zone:'Terrace',shape:'round',cx:Math.round(200+(W-460)*(p.terrace===1?.5:c/(p.terrace-1))),cy:H-118,width:88,height:88,rotation:0,features:[],state:'available'});
 return {schemaVersion:2,width:W,height:H,zones,objects,tables:built,background:null};
}

function setupFloorSvg(p){
 const f=buildFloor(p);
 return `<svg viewBox="${tightView(f,50)}" role="img" aria-label="${t('Generated floor plan')}">${localizeScene(sceneSvg(f,{mode:'reservation'}))}</svg>`;
}

const setupSteps=[['Profile','Name, cuisine, service hours, branch'],['Menu draft','Categories, prices, allergens, Arabic'],['Floor plan','Zones, tables, seats, QR identity']];

const setupSection=()=>`<section class="lp-chapter lp-setup" id="setup">
 <div class="lp-shell lp-split">
  <div class="lp-copy" data-reveal>
   <span class="lp-chapter-tag">01 · ${t('Opening')}</span>
   <h2>${t('Describe the restaurant. Watch it get built.')}</h2>
   <p>${t('Resuto turns one sentence into a working draft: a profile, a bilingual menu skeleton and a real floor plan with seats and QR identity. You review every field before anything goes live.')}</p>
   <div class="lp-picks" role="group" aria-label="${t('Example descriptions')}">
    ${presets.map((p,i)=>`<button type="button" class="lp-pick${i?'':' is-on'}" data-lp="preset" data-arg="${p.id}">${t(p.prompt)}</button>`).join('')}
   </div>
   <ul class="lp-ticks">${['No blank screens on day one','Every generated field stays editable','Nothing is published without approval'].map(x=>`<li>${t(x)}</li>`).join('')}</ul>
  </div>
  <div class="lp-console" id="setup-console" data-reveal>
   <div class="lp-console-bar"><span class="lp-spark" aria-hidden="true">✦</span>${t('Resuto setup')}<small id="setup-state">${t('Ready')}</small></div>
   <div class="lp-console-prompt"><i aria-hidden="true">›</i><span id="setup-typed"></span><b class="lp-caret" aria-hidden="true"></b></div>
   <div class="lp-console-out">
    <ol class="lp-build" id="setup-build">${setupSteps.map(([title,detail],i)=>`<li style="--i:${i}"><span class="lp-build-dot" aria-hidden="true"></span><strong>${t(title)}</strong><small>${t(detail)}</small><em></em></li>`).join('')}</ol>
    <div class="lp-build-floor" id="setup-floor">${setupFloorSvg(presets[0])}</div>
   </div>
   <div class="lp-console-foot"><span id="setup-summary"></span><a class="lp-inline" href="/manager">${t('Review the draft')} ${arrow}</a></div>
  </div>
 </div>
</section>`;

/* ------------------------------------------------- 02 · Floor Studio     */
const studio={mode:'design',sel:tables[1]?.id||tables[0]?.id,party:4,tick:0,pinned:0};
const studioTables=tables.map(x=>({...x}));
const studioModes=[['design','Design','Build the room'],['reserve','Reserve','Offer the right table'],['operate','Operate','Watch the service']];
const opsCycle=['occupied','preparing','ready','payment','cleaning','available'];

function studioState(x,i){
 if(studio.mode==='operate')return opsCycle[(i+studio.tick)%opsCycle.length];
 if(studio.mode==='reserve')return x.capacity<studio.party?'unavailable':x.id===studio.sel?'recommended':i%5===2?'reserved':'available';
 return 'available';
}

function studioSvg(){
 const editor=studio.mode==='design';
 const list=studioTables.map((x,i)=>({...x,state:studioState(x,i),disabled:studio.mode==='reserve'&&x.capacity<studio.party}));
 const view=narrow()?NARROW_VIEW:`0 0 ${plan.width} ${plan.height}`;
 return `<svg class="lp-floor-svg" viewBox="${view}" role="img" aria-label="${t('Restaurant floor plan')}">${localizeScene(sceneSvg({...plan,tables:list},{editor,grid:editor,selected:[studio.sel],mode:studio.mode==='operate'?'operations':studio.mode}))}</svg>`;
}

function studioPanel(){
 const x=studioTables.find(y=>y.id===studio.sel)||studioTables[0];
 if(!x)return '';
 const i=studioTables.indexOf(x);
 if(studio.mode==='design')return `<div class="lp-panel-head"><span>${t('Object')}</span><strong>${e(x.label)}</strong></div>
  <div class="lp-field"><label for="lp-seats">${t('Seats')}</label><div class="lp-stepper"><button type="button" data-lp="seats" data-arg="-1" aria-label="${t('Fewer seats')}">−</button><output id="lp-seats">${num(x.capacity)}</output><button type="button" data-lp="seats" data-arg="1" aria-label="${t('More seats')}">+</button></div></div>
  <div class="lp-field"><span class="lp-field-label">${t('Shape')}</span><div class="lp-seg lp-seg-sm">${[['round','Round'],['square','Square'],['rect','Long']].map(([s,l])=>`<button type="button" class="${x.shape===s?'is-on':''}" data-lp="shape" data-arg="${s}">${t(l)}</button>`).join('')}</div></div>
  <div class="lp-field"><label for="lp-rot">${t('Rotation')}</label><input id="lp-rot" class="lp-range" type="range" min="0" max="345" step="15" value="${x.rotation||0}" data-lp="rotate"><span class="lp-field-value">${num(x.rotation||0)}°</span></div>
  <p class="lp-panel-note">${t('Move a table and it keeps its QR code, its history and its reservations.')}</p>`;
 if(studio.mode==='reserve'){
  const ok=x.capacity>=studio.party;
  return `<div class="lp-panel-head"><span>${t('Availability')}</span><strong>${e(x.label)}</strong></div>
  <div class="lp-field"><span class="lp-field-label">${t('Party size')}</span><div class="lp-seg lp-seg-sm">${[2,4,6,8].map(n=>`<button type="button" class="${studio.party===n?'is-on':''}" data-lp="party" data-arg="${n}">${num(n)}</button>`).join('')}</div></div>
  <div class="lp-avail ${ok?'is-ok':'is-no'}"><strong>${ok?t('Fits this party'):t('Too small for this party')}</strong><small>${e(t(x.zone))} · ${num(x.capacity)} ${t('seats')}${x.features&&x.features.length?' · '+e(t(x.features[0])):''}</small></div>
  <p class="lp-panel-note">${t('Guests choose a table they can see, not a time slot they have to trust.')}</p>`;
 }
 const s=studioState(x,i);
 const label={occupied:'Seated',preparing:'Kitchen preparing',ready:'Ready to serve',payment:'Bill in progress',cleaning:'Being turned',available:'Open'}[s]||'Open';
 return `<div class="lp-panel-head"><span>${t('Live state')}</span><strong>${e(x.label)}</strong></div>
  <div class="lp-state-line lp-state-${s}"><i></i>${t(label)}</div>
  <ul class="lp-panel-list"><li><span>${t('Guests')}</span><b>${num(Math.min(x.capacity,2+i%3))}</b></li><li><span>${t('Open ticket')}</span><b>${money(18500+i*4300)}</b></li><li><span>${t('Since seated')}</span><b>${num(18+i*4)} ${t('min')}</b></li></ul>
  <p class="lp-panel-note">${t('The same map the floor team, the kitchen and the guest are all looking at.')}</p>`;
}

const studioTools=[['Select','M4 3l14 7-6 2-2 6z'],['Table','M4 6h16v4H4zM8 10v8M16 10v8'],['Zone','M3 5h18v14H3z'],['Counter','M3 9h18v6H3zM7 15v4M17 15v4'],['Door','M6 4h12v16M6 4v16h6'],['Plant','M12 20v-8M12 12c0-4 3-6 6-6 0 4-3 6-6 6zm0 0c0-4-3-6-6-6 0 4 3 6 6 6z'],['Label','M5 6h14M12 6v12']];

const studioSection=()=>`<section class="lp-studio" id="studio">
 <div class="lp-studio-track" id="studio-track">
  <div class="lp-studio-sticky">
   <div class="lp-shell">
    <div class="lp-studio-head">
     <div data-reveal><span class="lp-chapter-tag is-dark">02 · ${t('Floor Studio')}</span><h2>${t('The floor plan is the product.')}</h2></div>
     <p data-reveal>${t('Draw the room once. That geometry becomes the reservation map, the QR identity of every table and the live service board. There is no second layout to maintain.')}</p>
     <div class="lp-seg lp-seg-lg" role="tablist" aria-label="${t('Floor modes')}">${studioModes.map(([id,label,detail])=>`<button type="button" role="tab" class="${studio.mode===id?'is-on':''}" data-lp="mode" data-arg="${id}" aria-selected="${studio.mode===id}"><strong>${t(label)}</strong><small>${t(detail)}</small></button>`).join('')}</div>
    </div>
    <div class="lp-studio-stage" data-reveal>
     <div class="lp-tools" role="toolbar" aria-label="${t('Floor objects')}">${studioTools.map(([id,d],i)=>`<button type="button" class="${i?'':'is-on'}" data-lp="tool" data-arg="${id}" aria-label="${t(id)}" title="${t(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg></button>`).join('')}</div>
     <div class="lp-studio-canvas" id="studio-canvas">${studioSvg()}</div>
     <aside class="lp-studio-panel" id="studio-panel">${studioPanel()}</aside>
    </div>
    <div class="lp-studio-foot"><span id="studio-hint">${t('Select any table, then change its seats, shape and angle. The chairs redraw with it.')}</span><a class="lp-inline is-dark" href="/reserve">${t('Try the guest map')} ${arrow}</a></div>
   </div>
  </div>
 </div>
</section>`;

/* --------------------------------------------- 03 · visual reservations */
const slots=[['18:30',true],['19:00',false],['19:30',true],['20:00',true],['20:30',true]];
const book={slot:'19:30',party:4,table:tables.find(x=>x.capacity>=4)?.id||tables[0]?.id,done:false};
const partySizes=[...new Set(tables.map(x=>x.capacity))].sort((a,b)=>a-b).slice(0,4);
const bookable=()=>tables.filter(x=>x.capacity>=book.party);

function bookMap(){
 const picks=bookable().map(x=>x.id);
 const list=tables.map(x=>({...x,state:x.id===book.table?'recommended':picks.includes(x.id)?'available':'unavailable',disabled:!picks.includes(x.id)}));
 return `<svg class="lp-floor-svg" viewBox="${narrow()?NARROW_VIEW:tightView(plan,50)}" role="img" aria-label="${t('Tables available for this booking')}">${localizeScene(sceneSvg({...plan,tables:list},{mode:'reservation'}))}</svg>`;
}

function bookCard(){
 const x=tables.find(y=>y.id===book.table)||tables[0];
 if(!x)return '';
 if(book.done)return `<div class="lp-ticket" role="status">
   <div class="lp-ticket-top"><span>${t('Table held')}</span><strong>${e(x.label)}</strong></div>
   <dl><div><dt>${t('Guests')}</dt><dd>${num(book.party)}</dd></div><div><dt>${t('Time')}</dt><dd>${book.slot}</dd></div><div><dt>${t('Zone')}</dt><dd>${e(t(x.zone))}</dd></div><div><dt>${t('Held for')}</dt><dd>${num(data.settings.duration)} ${t('min')}</dd></div></dl>
   <div class="lp-ticket-rip" aria-hidden="true"></div>
   <div class="lp-ticket-foot"><span>${t('Test deposit')} <b>${money(data.settings.deposit)}</b></span><button type="button" class="lp-inline" data-lp="rebook">${t('Start over')}</button></div>
  </div>`;
 return `<div class="lp-book">
  <div class="lp-book-row"><span class="lp-field-label">${t('Service')}</span><div class="lp-chips">${slots.map(([s,open])=>`<button type="button" class="${book.slot===s?'is-on':''}" data-lp="slot" data-arg="${s}" ${open?'':'disabled aria-disabled="true"'}>${s}${open?'':`<i>${t('full')}</i>`}</button>`).join('')}</div></div>
  <div class="lp-book-row"><span class="lp-field-label">${t('Guests')}</span><div class="lp-chips">${partySizes.map(n=>`<button type="button" class="${book.party===n?'is-on':''}" data-lp="bparty" data-arg="${n}">${num(n)}</button>`).join('')}</div><small class="lp-book-count">${num(bookable().length)} ${t('tables open for this party')}</small></div>
  <div class="lp-book-table">
   <div><strong>${e(x.label)}</strong><small>${e(t(x.zone))} · ${num(x.capacity)} ${t('seats')}</small></div>
   <div class="lp-book-tags">${(x.features||[]).slice(0,2).map(f=>`<span>${e(t(f))}</span>`).join('')||`<span>${t('Center')}</span>`}</div>
  </div>
  <button type="button" class="lp-btn lp-btn-solid lp-btn-full" data-lp="hold">${t('Hold this table')} ${arrow}</button>
  <small class="lp-book-note">${t('Demo booking. No card is charged and no message is sent.')}</small>
 </div>`;
}

const reserveSection=()=>`<section class="lp-reserve" id="reserve">
 <div class="lp-reserve-photo" aria-hidden="true"><img src="/assets/olive-interior.webp" alt="" loading="lazy" decoding="async" width="1600" height="900"></div>
 <div class="lp-shell lp-reserve-grid">
  <div class="lp-copy is-light" data-reveal>
   <span class="lp-chapter-tag is-dark">03 · ${t('Reservations')}</span>
   <h2>${t('Guests book a table, not a time slot.')}</h2>
   <p>${t('The same saved room appears on the guest side. Tables that cannot seat the party fall away, the recommended one is highlighted, and the hold is written straight onto the floor your team is watching.')}</p>
   <ul class="lp-ticks is-light">${['Availability from live occupancy and turn time','Window, terrace and premium tables surfaced','Deposit optional and clearly labelled'].map(x=>`<li>${t(x)}</li>`).join('')}</ul>
   <a class="lp-btn lp-btn-line" href="/reserve">${t('Open the booking page')} ${arrow}</a>
  </div>
  <div class="lp-reserve-panel" data-reveal>
   <div class="lp-reserve-map" id="book-map">${bookMap()}</div>
   <div class="lp-reserve-card" id="book-card">${bookCard()}</div>
  </div>
 </div>
</section>`;

/* ------------------------------------------------- 04 · AI menu import   */
const sources=[
 {id:'pdf',kind:'PDF',name:'summer-menu.pdf',meta:'4 pages'},
 {id:'photo',kind:'JPG',name:'chef-board-02.jpg',meta:'Wall board'},
 {id:'pos',kind:'POS',name:'Foodics catalogue',meta:'128 products'}
];
const stages=['Reading the source','Extracting dishes','Matching your catalogue','Ready for review'];
const importState={source:'pdf',stage:0,rows:0};

const importRow=(m,i)=>`<div class="lp-row" style="--i:${i}">
 <span class="lp-row-name"><b>${e(nameOf(m))}</b><small>${e(rtl?m.name:m.nameAr||m.name)}</small></span>
 <span class="lp-row-cat">${e(t(m.category))}</span>
 <span class="lp-row-price">${money(m.price)}</span>
 <span class="lp-row-flag ${i===1?'is-warn':''}">${i===1?t('Check the source'):t('High confidence')}</span>
</div>`;

const importSection=()=>`<section class="lp-chapter lp-import" id="import">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">04 · ${t('Menu import')}</span><h2>${t('Your menu, wherever it lives now.')}</h2></div>
   <p>${t('A PDF, a photo of the board or a POS catalogue becomes a structured draft with prices, categories, allergens and Arabic names. Resuto shows its confidence and waits for you.')}</p>
  </div>
  <div class="lp-workspace" data-reveal>
   <div class="lp-sources">
    ${sources.map((s,i)=>`<button type="button" class="lp-source${i?'':' is-on'}" data-lp="source" data-arg="${s.id}"><b>${s.kind}</b><span>${e(s.name)}</span><small>${t(s.meta)}</small></button>`).join('')}
    <div class="lp-pipeline" id="import-pipeline">${stages.map((s,i)=>`<div class="lp-pipe-step" data-stage="${i}"><i></i>${t(s)}</div>`).join('')}</div>
   </div>
   <div class="lp-review">
    <header><span>${t('Draft item')}</span><span>${t('Category')}</span><span>${t('Price')}</span><span>${t('Confidence')}</span></header>
    <div class="lp-rows" id="import-rows"></div>
    <footer><div class="lp-review-meta"><strong id="import-count">0</strong> ${t('items ready for review')} · <b>0</b> ${t('published automatically')}</div><button type="button" class="lp-btn lp-btn-solid lp-btn-sm" data-lp="replay-import">${t('Run it again')}</button></footer>
   </div>
  </div>
 </div>
</section>`;

/* ------------------------------------- 05 · QR ordering and AI ordering  */
const qrTable=data.tables.find(x=>x.qr)||data.tables[0]||{label:'T1',qr:''};
const aiPick=[menu[0],menu[4]||menu[1]].filter(Boolean);
const aiTotal=aiPick.reduce((n,m)=>n+m.price,0);
const serviceSteps=[
 ['scan','Scan the table','No app, no account, no waiting for a menu.'],
 ['browse','Browse what is actually on','Sold-out dishes disappear the moment the kitchen says so.'],
 ['ask','Ask in your own words','Budget, diet, spice and allergens are read from the live catalogue.'],
 ['track','Follow the order','The guest sees the same progress the kitchen does.']
];
const service={step:0};

function phoneScreen(){
 const s=serviceSteps[service.step][0];
 if(s==='scan')return `<div class="lp-scr lp-scr-scan"><span class="lp-scr-eyebrow">${e(data.settings.name)}</span><strong>${e(qrTable.label)}</strong><div class="lp-qr"><img src="/qr/${e(qrTable.qr)}" alt="${t('Table QR code')}" loading="lazy" width="180" height="180"><span class="lp-qr-scan" aria-hidden="true"></span></div><p>${t('Scan to open the menu')}</p><small>${t('Opens in the browser. Nothing to install.')}</small></div>`;
 if(s==='browse')return `<div class="lp-scr lp-scr-menu"><div class="lp-scr-bar"><strong>${t('Menu')}</strong><span>${e(qrTable.label)}</span></div><div class="lp-scr-tabs">${['Starters','Mains','Desserts'].map((c,i)=>`<span class="${i?'':'is-on'}">${t(c)}</span>`).join('')}</div>${menu.slice(0,4).map(m=>`<article class="lp-scr-dish">${dish(m)}<div><b>${e(nameOf(m))}</b><small>${e(t(m.category))} · ${money(m.price)}</small></div><i aria-hidden="true">+</i></article>`).join('')}<div class="lp-scr-dock"><span>${num(2)} ${t('items')}</span><b>${money(menu.slice(0,2).reduce((n,m)=>n+m.price,0))}</b><em>${t('View order')}</em></div></div>`;
 if(s==='ask')return `<div class="lp-scr lp-scr-ai"><div class="lp-scr-bar"><strong>✦ ${t('Menu assistant')}</strong></div><p class="lp-ask">${t('Vegetarian, nothing spicy, under EGP 500 for two.')}</p><div class="lp-answer"><span>${t('From tonight’s menu')}</span>${aiPick.map(m=>`<article>${dish(m)}<div><b>${e(nameOf(m))}</b><small>${money(m.price)}</small></div></article>`).join('')}<footer><span>${t('Total')}</span><b>${money(aiTotal)}</b></footer></div><small class="lp-scr-note">${t('Listed allergens only. Ask the staff about cross-contact.')}</small><button type="button" class="lp-scr-cta">${t('Add both to the order')}</button></div>`;
 return `<div class="lp-scr lp-scr-track"><div class="lp-scr-bar"><strong>${t('Order')} #042</strong><span>${e(qrTable.label)}</span></div><ol class="lp-track">${[['Received','done'],['In the kitchen','done'],['Ready to serve','now'],['Served','']].map(([l,st])=>`<li class="${st}"><i></i>${t(l)}</li>`).join('')}</ol><div class="lp-track-card"><span>${t('Estimated')}</span><b>6 ${t('min')}</b></div><button type="button" class="lp-scr-cta">${t('View the bill')}</button></div>`;
}

const serviceSection=()=>`<section class="lp-service" id="service">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">05 · ${t('Guest service')}</span><h2>${t('The table becomes the waiter’s second pair of hands.')}</h2></div>
   <p>${t('A guest scans the table, orders in Arabic or English, asks for a recommendation and follows the kitchen — while the floor team keeps working the room.')}</p>
  </div>
  <div class="lp-service-stage" data-reveal>
   <ol class="lp-service-steps" id="service-steps">${serviceSteps.map(([id,title,detail],i)=>`<li class="${i?'':'is-on'}"><button type="button" data-lp="service" data-arg="${i}"><span>${num(i+1)}</span><strong>${t(title)}</strong><small>${t(detail)}</small></button></li>`).join('')}</ol>
   <div class="lp-phone-wrap">
    <div class="lp-phone"><span class="lp-phone-notch" aria-hidden="true"></span><div class="lp-phone-screen" id="phone-screen">${phoneScreen()}</div></div>
    <div class="lp-phone-glow" aria-hidden="true"></div>
   </div>
   <div class="lp-service-notes">
    <article><strong>${t('Ordering that stays honest')}</strong><p>${t('Recommendations only use the live catalogue: availability, price, dietary tags and allergens. Safety is never guessed.')}</p></article>
    <article><strong>${t('Every table has an identity')}</strong><p>${t('The QR belongs to the table, not to a printed page, so moving furniture never breaks a code.')}</p></article>
    <a class="lp-inline" href="/restaurant">${t('Open the guest experience')} ${arrow}</a>
   </div>
  </div>
 </div>
</section>`;

/* ------------------------------------------------------ 06 · the kitchen */
const kdsColumns=[['new','Received'],['fire','On the pass'],['ready','Ready']];
const kdsSeed=[
 {id:42,table:2,station:'Grill',items:['1 × Grilled chicken supreme','2 × Herb potatoes'],min:2,col:0},
 {id:43,table:5,station:'Cold kitchen',items:['1 × Burrata & heirloom tomato'],min:4,col:1},
 {id:44,table:8,station:'Hot kitchen',items:['2 × Roasted pumpkin soup'],min:6,col:1},
 {id:45,table:11,station:'Pastry',items:['2 × Pistachio basbousa'],min:9,col:2},
 {id:46,table:4,station:'Bar',items:['3 × Hibiscus cooler'],min:1,col:0}
];

const kitchenSection=()=>`<section class="lp-kitchen" id="kitchen">
 <div class="lp-shell">
  <div class="lp-head-row is-light" data-reveal>
   <div><span class="lp-chapter-tag is-dark">06 · ${t('Kitchen')}</span><h2>${t('Tickets that route themselves.')}</h2></div>
   <p>${t('Each line goes to the station that cooks it, with the table, the timer and the guest’s own progress attached. Nothing is shouted twice.')}</p>
  </div>
  <div class="lp-kds" data-reveal>
   <header class="lp-kds-bar"><strong>${t('Kitchen display')}</strong><span id="kds-clock">${clock(19,42)}</span><span class="lp-kds-load">${t('Open tickets')} <b id="kds-open">5</b></span></header>
   <div class="lp-kds-board" id="kds-board">${kdsColumns.map(([id,label])=>`<section data-col="${id}"><header>${t(label)}<i></i></header><div class="lp-kds-list" data-list="${id}"></div></section>`).join('')}</div>
   <footer class="lp-kds-foot">${['Grill','Hot kitchen','Cold kitchen','Pastry','Bar'].map((s,i)=>`<div><span>${t(s)}</span><i style="--w:${[82,64,48,30,55][i]}%"></i></div>`).join('')}<a class="lp-inline is-dark" href="/kitchen">${t('Open the kitchen screen')} ${arrow}</a></footer>
  </div>
 </div>
</section>`;

/* ------------------------------------------- 07 · split bill & payments  */
const billTotal=120000;
const party=[
 {name:'Ahmed',rail:'Card',share:42000,items:'Main + wine'},
 {name:'Mariam',rail:'Wallet',share:31500,items:'Starter + main'},
 {name:'Omar',rail:'InstaPay',share:28500,items:'Main'},
 {name:'Lina',rail:'Cash',share:18000,items:'Dessert + tea'}
];
const splitModes=[['equal','Split equally','Four equal shares'],['items','Split by item','Everyone pays what they ordered'],['custom','Custom amounts','Someone covers a little more'],['full','One person pays','A single guest settles it all']];
const pay={mode:'items',settled:0,rated:false};
const shareOf=i=>pay.mode==='equal'?billTotal/4:pay.mode==='full'?(i?0:billTotal):pay.mode==='custom'?[48000,30000,24000,18000][i]:party[i].share;
const paidTotal=()=>party.reduce((n,_,i)=>n+(i<pay.settled?shareOf(i):0),0);

function payStage(){
 const remaining=billTotal-paidTotal();
 const pct=Math.round(paidTotal()/billTotal*100);
 const active=pay.mode==='full'?1:4;
 return `<div class="lp-bill-top">
   <div><span>${t('Table bill')} · ${t('The Olive Room')}</span><strong>${money(billTotal)}</strong></div>
   <div class="lp-ring" style="--p:${pct}"><svg viewBox="0 0 72 72" aria-hidden="true"><circle class="lp-ring-bg" cx="36" cy="36" r="31"/><circle class="lp-ring-fg" cx="36" cy="36" r="31"/></svg><b>${num(pct)}%</b></div>
  </div>
  <ul class="lp-shares">${party.slice(0,active).map((p,i)=>{
   const done=i<pay.settled;
   return `<li class="${done?'is-paid':''}" style="--i:${i}"><span class="lp-avatar">${done?'✓':e(p.name.slice(0,1))}</span>
    <span class="lp-share-who"><b>${t(p.name)}</b><small>${pay.mode==='items'?t(p.items):t('Private payment link')}</small></span>
    <span class="lp-share-rail">${t(p.rail)}</span>
    <span class="lp-share-amt">${money(shareOf(i))}</span>
    <span class="lp-share-state">${done?t('Paid'):t('Waiting')}</span></li>`;
  }).join('')}</ul>
  <div class="lp-bill-foot">
   <span>${remaining>0?`<b>${money(remaining)}</b> ${t('still open')}`:`<b>${t('Settled')}</b> · ${t('Table released')}`}</span>
   ${remaining>0?`<button type="button" class="lp-btn lp-btn-solid lp-btn-sm" data-lp="settle">${t('Settle the next share')} ${arrow}</button>`:`<div class="lp-rate" role="group" aria-label="${t('Rate the meal')}">${[1,2,3,4,5].map(n=>`<button type="button" class="${pay.rated?'is-on':''}" data-lp="rate" data-arg="${n}" aria-label="${num(n)}">★</button>`).join('')}<button type="button" class="lp-inline" data-lp="replay-pay">${t('Replay')}</button></div>`}
  </div>`;
}

const railLabel={card:'Card',wallet:'Mobile wallet',instapay:'InstaPay',cash:'Cash at the table'};
const paymentsSection=()=>`<section class="lp-chapter lp-payments" id="payments">
 <div class="lp-shell lp-split is-wide">
  <div class="lp-copy" data-reveal>
   <span class="lp-chapter-tag">07 · ${t('Payments')}</span>
   <h2>${t('The bill stops being the awkward part.')}</h2>
   <p>${t('One table, four private links. Split equally, by item or by any amount — each guest pays on their own phone and everyone watches the balance fall in real time.')}</p>
   <div class="lp-modes" role="group" aria-label="${t('Split methods')}">${splitModes.map(([id,label,detail])=>`<button type="button" class="lp-mode${pay.mode===id?' is-on':''}" data-lp="split" data-arg="${id}"><strong>${t(label)}</strong><small>${t(detail)}</small></button>`).join('')}</div>
  </div>
  <div class="lp-bill" id="pay-stage" data-reveal>${payStage()}</div>
 </div>
 <div class="lp-shell">
  <div class="lp-rails" data-reveal>
   <span class="lp-rails-label">${t('Payment rails')}</span>
   ${(caps.payments||[]).map(m=>`<span class="lp-rail ${m.available?'is-on':''}"><i></i>${t(railLabel[m.id]||m.id)}<small>${m.available?t('Active here'):t('Ready when credentials are added')}</small></span>`).join('')}
  </div>
 </div>
</section>`;

/* --------------------------------- 08 · live operations and AI manager   */
const metrics=[
 ['Covers seated',()=>84,'+12%',[38,44,52,49,63,71,84]],
 ['Average turn',()=>62,'−7 min',[78,74,71,69,66,64,62]],
 ['Kitchen time',()=>14,'−2 min',[19,18,17,17,16,15,14]],
 ['Tonight’s revenue',()=>0,'+18%',[42,51,58,66,72,81,96]]
];
const spark=v=>{
 const max=Math.max(...v),min=Math.min(...v);
 const pts=v.map((y,i)=>`${i/(v.length-1)*100},${28-(y-min)/(max-min||1)*24}`).join(' ');
 return `<svg class="lp-spark-line" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polygon class="lp-spark-fill" points="0,30 ${pts} 100,30"/><polyline points="${pts}"/></svg>`;
};
const insights=[
 ['Terrace is turning 14 minutes slower than the main room.','Two servers are covering nine tables outside. Moving one from the bar restores the pace.','Rebalance the section'],
 ['Burrata will sell out in about 40 minutes at tonight’s pace.','Eleven portions left, four already on open tickets.','Mark it low in stock'],
 ['Three tables have been on the bill for over eight minutes.','T4, T7 and T9 opened a split and stopped. A gentle nudge usually closes it.','Send a payment reminder']
];

const opsSection=()=>`<section class="lp-ops" id="operations">
 <svg width="0" height="0" aria-hidden="true" focusable="false"><defs><linearGradient id="lp-spark-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E8875A"/><stop offset="1" stop-color="#E8875A" stop-opacity="0"/></linearGradient></defs></svg>
 <div class="lp-shell">
  <div class="lp-head-row is-light" data-reveal>
   <div><span class="lp-chapter-tag is-dark">08 · ${t('Intelligence')}</span><h2>${t('A manager who never leaves the pass.')}</h2></div>
   <p>${t('Resuto watches the same service you do — covers, turn time, kitchen load, open bills — and says something only when it is worth saying.')}</p>
  </div>
  <div class="lp-ops-grid">
   <div class="lp-metrics" data-reveal>${metrics.map(([label,value,delta,series],i)=>`<article><small>${t(label)}</small><strong ${i===3?`data-egp="42850"`:`data-count="${value()}"`}>0</strong><span class="lp-delta ${delta.startsWith('+')?'is-up':'is-down'}">${delta}</span>${spark(series)}</article>`).join('')}</div>
   <div class="lp-insights" data-reveal>
    <header><span class="lp-spark" aria-hidden="true">✦</span>${t('AI manager')}<small id="ops-state">${t('Watching service')}</small></header>
    <ol id="insight-list">${insights.map(([title,body,action],i)=>`<li style="--i:${i}"><strong>${t(title)}</strong><p>${t(body)}</p><span class="lp-action">${t(action)}</span></li>`).join('')}</ol>
    <footer>${t('Generated from this installation’s own operating data. A live model is used only when its key is configured.')}</footer>
   </div>
  </div>
 </div>
</section>`;

/* ------------------------------------------------ 09 · native or connect */
/* A patch board rather than a logo wall: what you already run on the left,
   Resuto in the middle, what it runs for you on the right. Pure HTML/CSS. */
const nativeNodes=[
 ['Reservations','Floor-based booking'],
 ['QR ordering','Guest devices'],
 ['Kitchen display','Station routing'],
 ['Payments','Split and settle'],
 ['Menu & stock','Bilingual catalogue'],
 ['Analytics','Service history']
];
const connectNodes=[
 {id:'foodics',name:'Foodics',logo:logos.foodics,role:'POS catalogue',detail:'Import a menu draft for manager review. Orders are not pushed back in this release.'},
 {id:'odoo',name:'Odoo',logo:logos.odoo,role:'Back office',detail:'Pull products into a reviewed draft. Currency is confirmed before import.'},
 {id:'stripe',name:'Stripe',logo:logos.stripe,role:'Card payments',detail:'Hosted card checkout appears once server credentials are configured.'},
 {id:'paymob',name:'Paymob',logo:logos.paymob,role:'Cards and wallets',detail:'Cards and mobile wallets for Egypt, enabled from the manager settings.'},
 {id:'whatsapp',name:'WhatsApp',logo:logos.whatsapp,role:'Sharing',detail:'Guests can share a payment link. Automated messaging is not connected.'},
 {id:'instapay',name:'InstaPay',logo:null,role:'Bank transfer',detail:'Manual transfer with manager confirmation on the bill.'}
];
// What Resuto Native takes off the floor, rather than a second copy of the
// module list — the two modes have to say different things.
const replacedNodes=[
 ['POS terminal','Orders, bills and the day close'],
 ['Booking notebook','Phone reservations and no-shows'],
 ['Reprinted menus','Every price change, printed again'],
 ['Manual payment links','Sent by hand, chased by hand'],
 ['Shouted tickets','Repeated across the pass'],
 ['End-of-day spreadsheets','Typed a second time']
];
const connect={mode:'connect',kind:'provider',node:0};
const railStatus=id=>{
 const pay=(caps.payments||[]).find(m=>m.id===(id==='stripe'||id==='paymob'?'card':id==='instapay'?'instapay':null));
 if(pay)return pay.available?['on','Active here']:['ready','Ready to configure'];
 if(id==='whatsapp')return ['on','Sharing works today'];
 return (caps.connectors||[]).includes(id)?['ready','Supported']:['ready','On request'];
};

function patchBoard(){
 const isNative=connect.mode==='native';
 const rows=isNative
  ?replacedNodes.map(([name,role],i)=>({key:'r'+i,name,role,logo:null,status:['off','Retired'],pick:null}))
  :connectNodes.map((x,i)=>({key:x.id,name:x.name,role:x.role,logo:x.logo,status:railStatus(x.id),pick:'p:'+i}));
 const modules=nativeNodes.map(([name,role])=>({name,role}));
 return `<div class="lp-board ${isNative?'is-native':'is-connect'}">
  <div class="lp-board-col">
   <h3 class="lp-board-head">${isNative?t('What Resuto replaces'):t('What you run today')}</h3>
   <ul class="lp-board-list">${rows.map((r,i)=>{
    const on=r.pick&&connect.kind==='provider'&&connect.node===i;
    const inner=`<span class="lp-plug-face">${r.logo?`<img src="${r.logo}" alt="${e(r.name)}" loading="lazy">`:`<b>${e(t(r.name))}</b>`}</span>
    <span class="lp-plug-role">${t(r.role)}</span>
    <span class="lp-plug-state is-${r.status[0]}">${t(r.status[1])}</span>`;
    return `<li style="--i:${i}">${r.pick
     ?`<button type="button" class="lp-plug${on?' is-on':''}" data-lp="node" data-arg="${r.pick}">${inner}</button>`
     :`<span class="lp-plug is-retired">${inner}</span>`}</li>`;
   }).join('')}</ul>
   <p class="lp-board-note">${isNative?t('One system takes all of it on. Nothing to reconcile at closing time.'):t('Connect what you keep. Resuto reads it, shows the real status, and never claims a link that is not configured.')}</p>
  </div>
  <div class="lp-board-core">
   <div class="lp-bus lp-bus-in" aria-hidden="true"><i></i><i></i><i></i></div>
   <div class="lp-core">
    <span class="lp-core-mark" aria-hidden="true">r</span>
    <strong>resuto</strong>
    <small>${isNative?t('Native'):t('Connect')}</small>
    <span class="lp-core-meta">${isNative?`${nativeNodes.length} ${t('modules')}`:`${connectNodes.length} ${t('sources')}`} · ${t('one floor, one bill')}</span>
   </div>
   <div class="lp-bus lp-bus-out" aria-hidden="true"><i></i><i></i><i></i></div>
  </div>
  <div class="lp-board-col">
   <h3 class="lp-board-head">${t('Runs inside Resuto')}</h3>
   <ul class="lp-board-list is-modules">${modules.map((m,i)=>`<li style="--i:${i}"><button type="button" class="lp-module${connect.kind==='module'&&connect.node===i?' is-on':''}" data-lp="node" data-arg="m:${i}"><b>${t(m.name)}</b><small>${t(m.role)}</small></button></li>`).join('')}</ul>
  </div>
 </div>`;
}

const moduleDetail={
 'Reservations':'Guests pick a real table on the saved floor. The hold lands on the same map the team is watching.',
 'QR ordering':'Every table carries its own code. The guest orders from their own phone, in Arabic or English.',
 'Kitchen display':'Each line routes to the station that cooks it, with the table and the timer attached.',
 'Payments':'Pay in full, split equally, by item or by any amount — each share on its own private link.',
 'Menu & stock':'One bilingual catalogue with allergens, modifiers and live availability.',
 'Analytics':'Covers, turn time, kitchen time and ratings from the service you actually ran.'
};
function connectDetail(){
 if(connect.kind==='module'){
  const [label,role]=nativeNodes[connect.node]||nativeNodes[0];
  return `<span class="lp-detail-tag">${t('Resuto Native')} · ${t(role)}</span><h3>${t(label)}</h3><p>${t(moduleDetail[label])}</p><p class="lp-detail-note">${t('Everything runs inside Resuto. One login, one dataset, no nightly export.')}</p>`;
 }
 const node=connectNodes[connect.node]||connectNodes[0];
 return `<span class="lp-detail-tag">${t('Resuto Connect')} · ${t(railStatus(node.id)[1])}</span><h3>${e(node.name)}</h3><p>${t(node.detail)}</p><p class="lp-detail-note">${t('The manager screen always shows the real connection status. Marketing never claims a link that is not configured.')}</p>`;
}

const connectSection=()=>`<section class="lp-chapter lp-connect" id="connect">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">09 · ${t('Ecosystem')}</span><h2>${t('Run it all in Resuto, or keep what already works.')}</h2></div>
   <p>${t('Resuto Native runs the whole service. Resuto Connect keeps your POS, payment provider and messaging in place and brings them onto the same floor.')}</p>
  </div>
  <div class="lp-connect-stage" data-reveal>
   <div class="lp-seg lp-seg-pill" role="tablist" aria-label="${t('Deployment mode')}">
    <button type="button" role="tab" class="${connect.mode==='native'?'is-on':''}" data-lp="cmode" data-arg="native" aria-selected="${connect.mode==='native'}">${t('Resuto Native')}</button>
    <button type="button" role="tab" class="${connect.mode==='connect'?'is-on':''}" data-lp="cmode" data-arg="connect" aria-selected="${connect.mode==='connect'}">${t('Resuto Connect')}</button>
   </div>
   <div class="lp-board-wrap" id="orbit">${patchBoard()}</div>
   <aside class="lp-detail" id="connect-detail">${connectDetail()}</aside>
  </div>
 </div>
</section>`;

/* ---------------------------------------------------------- 10 · pricing */
const planFeatures={
 starter:['QR menu and ordering','Floor plan and reservations','Pickup, ratings and basic analytics'],
 growth:['Everything in Starter','AI assistant and kitchen display','Split payments and integrations'],
 pro:['Everything in Growth','Up to three branches','AI operational insights'],
 business:['Negotiated branch limits','Dedicated onboarding and migration','SLA, API and white label']
};
const price={yearly:false};

function planCards(){
 return (pricing.plans||[]).map((p,i)=>`<article class="lp-plan${i===1?' is-featured':''}" style="--i:${i}">
  ${i===1?`<span class="lp-plan-badge">${t('Most chosen')}</span>`:''}
  <h3>${e(p.name)}</h3>
  <div class="lp-plan-price">${p.monthly?`<b>${num(p.monthly*(price.yearly?10:1))}</b><small>${t('EGP')} / ${price.yearly?t('year'):t('month')}</small>`:`<b class="lp-plan-talk">${t('Let’s talk')}</b>`}</div>
  <ul>${planFeatures[p.id].map(f=>`<li>${t(f)}</li>`).join('')}</ul>
  <a class="lp-btn ${i===1?'lp-btn-solid':'lp-btn-line-ink'} lp-btn-full" href="${p.monthly?'/pricing':'/pricing#sales'}">${p.monthly?t('See what is included'):t('Talk to us')}</a>
 </article>`).join('');
}

const pricingSection=()=>`<section class="lp-chapter lp-pricing" id="pricing">
 <div class="lp-shell">
  <div class="lp-pricing-head" data-reveal>
   <div><span class="lp-chapter-tag">10 · ${t('Pricing')}</span><h2>${t('Egyptian pricing, from one room to three branches.')}</h2></div>
   <div class="lp-seg lp-seg-pill">
    <button type="button" class="${price.yearly?'':'is-on'}" data-lp="billing" data-arg="monthly">${t('Monthly')}</button>
    <button type="button" class="${price.yearly?'is-on':''}" data-lp="billing" data-arg="yearly">${t('Yearly · 2 months free')}</button>
   </div>
  </div>
  <div class="lp-plans" id="plan-grid">${planCards()}</div>
  <p class="lp-pricing-note" data-reveal>${t('Launch pricing proposal. Subscription billing and self-service signup are not enabled yet — the working demo is open to everyone today.')}</p>
 </div>
</section>`;

/* ------------------------------------------------------- close and foot  */
const ctaSection=()=>`<section class="lp-cta">
 <div class="lp-cta-floor" aria-hidden="true"><svg viewBox="0 0 ${plan.width} ${plan.height}">${localizeScene(sceneSvg({...plan,tables:tables.map((x,i)=>({...x,state:heroStates[i]}))},{mode:'operations'}))}</svg></div>
 <div class="lp-shell lp-cta-inner" data-reveal>
  <h2>${t('Your dining room is already running. Resuto just keeps up with it.')}</h2>
  <p>${t('Open the demo restaurant, reserve a table, scan a QR, order, split the bill and watch the manager screen react. Nothing is charged and nothing is installed.')}</p>
  <div class="lp-hero-cta">
   <a class="lp-btn lp-btn-solid lp-btn-lg" href="/restaurant">${t('Open the live demo')} ${arrow}</a>
   <a class="lp-btn lp-btn-line" href="/pricing">${t('Compare plans')}</a>
  </div>
  <ul class="lp-cta-list">${['No account for guests','One saved floor everywhere','Arabic and English throughout'].map(x=>`<li>${t(x)}</li>`).join('')}</ul>
 </div>
</section>`;

const footer=()=>`<footer class="lp-foot">
 <div class="lp-shell lp-foot-grid">
  <div><a class="lp-logo" href="/">${wordmark()}</a><p>${t('The operating system for restaurants — reservations, ordering, kitchen and payments around one live floor.')}</p></div>
  <div class="lp-foot-navs">
   <nav aria-label="${t('Product')}"><h4>${t('Product')}</h4><a href="#studio">${t('Floor Studio')}</a><a href="#service">${t('Guest service')}</a><a href="#kitchen">${t('Kitchen')}</a><a href="#payments">${t('Payments')}</a></nav>
   <nav aria-label="${t('Ecosystem')}"><h4>${t('Ecosystem')}</h4><a href="#connect">${t('Resuto Native')}</a><a href="#connect">${t('Resuto Connect')}</a><a href="#operations">${t('AI manager')}</a><a href="#pricing">${t('Pricing')}</a></nav>
   <nav aria-label="${t('Try it')}"><h4>${t('Try it')}</h4><a href="/restaurant">${t('Restaurant demo')}</a><a href="/reserve">${t('Reserve a table')}</a><a href="/menu">${t('Menu')}</a><a href="/manager">${t('Staff login')}</a></nav>
  </div>
  <p class="lp-foot-note">${t('This installation runs one demo restaurant. Payment, AI and connector features are active only where credentials are configured, and the interface says so honestly.')}</p>
  <small>© ${new Date().getFullYear()} Resuto</small>
 </div>
</footer>`;

/* ===================================================================== */
/* mount                                                                 */
/* ===================================================================== */
document.title=rtl?'ريسوتو · نظام تشغيل المطاعم':'Resuto · The restaurant operating system';
root.className='lp';
root.innerHTML=nav()+`<main class="lp-main">${hero()}${systemBand()}${setupSection()}${studioSection()}${reserveSection()}${importSection()}${serviceSection()}${kitchenSection()}${paymentsSection()}${opsSection()}${connectSection()}${pricingSection()}${ctaSection()}</main>`+footer();

const $=s=>root.querySelector(s);
const $$=s=>[...root.querySelectorAll(s)];
const motion=()=>!reduced.matches;

/* ---------------------------------------------------------- reveal + spy */
const revealIO=new IntersectionObserver(entries=>{
 for(const x of entries)if(x.isIntersecting){x.target.classList.add('is-in');revealIO.unobserve(x.target);}
},{rootMargin:'0px 0px -10%',threshold:.12});
$$('[data-reveal]').forEach(el=>{
 const kin=[...el.parentElement.children].filter(c=>c.hasAttribute('data-reveal'));
 el.style.setProperty('--r',kin.indexOf(el));
 revealIO.observe(el);
});

/* ------------------------------------------------------- visibility loops */
const timers=new Map();
function scene(el,onEnter,onLeave){
 if(!el)return;
 const io=new IntersectionObserver(entries=>{
  for(const x of entries)x.isIntersecting?onEnter():onLeave&&onLeave();
 },{threshold:.2});
 io.observe(el);
}
function loop(el,ms,fn,immediate){
 let id=null;
 scene(el,()=>{if(id||!motion())return;if(immediate)fn();id=setInterval(()=>{if(!document.hidden)fn()},ms)},()=>{clearInterval(id);id=null});
 timers.set(el,()=>clearInterval(id));
}

/* -------------------------------------------------------------- counters */
const egp=new Intl.NumberFormat(rtl?'ar-EG':'en-EG',{style:'currency',currency:'EGP',maximumFractionDigits:0});
function countUp(el){
 const asEgp=el.dataset.egp,target=Number(asEgp||el.dataset.count||0);
 const suffix=el.dataset.suffix||'';
 const show=v=>el.textContent=(asEgp?egp.format(v):num(v))+suffix;
 if(!target||!motion())return show(target);
 const start=performance.now(),dur=1100;
 const step=now=>{
  const p=Math.min(1,(now-start)/dur);
  show(Math.round(target*(1-Math.pow(1-p,3))));
  if(p<1)requestAnimationFrame(step);
 };
 requestAnimationFrame(step);
}
const countIO=new IntersectionObserver(entries=>{
 for(const x of entries)if(x.isIntersecting){countUp(x.target);countIO.unobserve(x.target);}
},{threshold:.5});
$$('[data-count],[data-egp]').forEach(el=>countIO.observe(el));

/* ------------------------------------------------------------ navigation */
const navEl=$('#lp-nav'),bar=$('#lp-progress'),drawer=$('#lp-drawer');
const spy=navLinks.map(([href])=>({href,el:document.querySelector(href)}));
let ticking=false;
function onScroll(){
 const doc=document.documentElement;
 const p=doc.scrollTop/Math.max(1,doc.scrollHeight-innerHeight);
 bar.style.transform=`scaleX(${p})`;
 navEl.classList.toggle('is-stuck',doc.scrollTop>24);
 let active='';
 for(const s of spy)if(s.el&&s.el.getBoundingClientRect().top<innerHeight*.45)active=s.href;
 $$('.lp-nav-links a').forEach(a=>a.classList.toggle('is-here',a.getAttribute('href')===active));
 studioScroll();
 ticking=false;
}
addEventListener('scroll',()=>{if(!ticking){ticking=true;requestAnimationFrame(onScroll)}},{passive:true});

function setDrawer(open){
 drawer.hidden=!open;
 document.body.classList.toggle('lp-locked',open);
 $('.lp-burger').setAttribute('aria-expanded',String(open));
}
addEventListener('keydown',ev=>{if(ev.key==='Escape'&&!drawer.hidden)setDrawer(false)});

/* ----------------------------------------------------------------- hero  */
const heroIds=tables.map(x=>x.id);
const heroFloorEl=$('#hero-floor'),feedEl=$('#hero-feed'),tableEl=$('#hero-table');
function paintTable(i,state,pulse){
 const g=heroFloorEl.querySelector(`[data-object-id="${CSS.escape(heroIds[i])}"]`);
 if(!g)return;
 g.setAttribute('class',`floor-object svg-table state-${state}`);
 if(pulse&&motion()){g.classList.add('is-pulse');setTimeout(()=>g.classList.remove('is-pulse'),1500);}
}
const stateWord={available:'Open',occupied:'Seated',ordering:'Ordering',preparing:'Preparing',ready:'Ready',payment:'Paying',reserved:'Reserved',cleaning:'Turning'};
function heroDetail(i){
 const x=tables[i];if(!x)return;
 const s=heroStates[i];
 tableEl.innerHTML=`<div class="lp-side-table-head"><strong>${e(x.label)}</strong><span class="lp-state-line lp-state-${s}"><i></i>${t(stateWord[s]||'Open')}</span></div>
  <p>${e(t(x.zone))} · ${num(x.capacity)} ${t('seats')}${x.features&&x.features.length?' · '+e(t(x.features[0])):''}</p>
  <a class="lp-inline" href="/reserve">${t('Reserve this table')} ${arrow}</a>`;
}
let feedAt=0,heroMinute=42;
function heroTick(){
 const ev=feed[feedAt%feed.length],at=seatIndex(ev.i);feedAt++;
 heroStates[at]=ev.state;
 paintTable(at,ev.state,true);
 const li=document.createElement('li');
 li.className='is-new';
 li.innerHTML=`<i class="lp-dot lp-state-${ev.state}"></i><span><b>${e(tableAt(ev.i).label)}</b> ${t(ev.title)}<small>${t(ev.meta)}</small></span><time>${clock(19,heroMinute)}</time>`;
 feedEl.prepend(li);
 while(feedEl.children.length>4)feedEl.lastElementChild.remove();
 requestAnimationFrame(()=>li.classList.remove('is-new'));
 heroMinute=(heroMinute+1)%60;
 $('#hero-clock').textContent=clock(heroMinute<42?20:19,heroMinute);
 heroDetail(at);
 renderLegend();
}
const legendEl=$('#hero-legend');
const legendOrder=[['available','Open'],['occupied','Seated'],['preparing','Preparing'],['ready','Ready'],['payment','Paying'],['cleaning','Turning']];
function renderLegend(){
 legendEl.innerHTML=legendOrder.map(([state,label])=>{
  const n=heroStates.filter(s=>s===state||(state==='occupied'&&s==='ordering')||(state==='available'&&s==='reserved')).length;
  return n?`<span><i class="lp-dot lp-state-${state}"></i>${t(label)}<b>${num(n)}</b></span>`:'';
 }).join('');
}
tables.forEach((x,i)=>paintTable(i,heroStates[i]));
feed.slice(0,4).reverse().forEach(ev=>{
 const li=document.createElement('li');
 li.innerHTML=`<i class="lp-dot lp-state-${ev.state}"></i><span><b>${e(tableAt(ev.i).label)}</b> ${t(ev.title)}<small>${t(ev.meta)}</small></span><time>${clock(19,38+feed.indexOf(ev))}</time>`;
 feedEl.prepend(li);
});
renderLegend();
heroDetail(seatIndex(8));
loop($('#hero-stage'),3400,heroTick);

/* ------------------------------------------------------- 01 setup console */
const typedEl=$('#setup-typed'),buildEl=$('#setup-build'),setupFloorEl=$('#setup-floor');
let setupRun=0;
function drawFloor(el){
 el.querySelectorAll('.svg-table').forEach((g,i)=>g.style.setProperty('--i',i));
 if(motion()){el.classList.remove('is-drawn');void el.offsetWidth;el.classList.add('is-drawn');}
 else el.classList.add('is-drawn');
}
async function runSetup(id){
 const p=presets.find(x=>x.id===id)||presets[0];
 const run=++setupRun;
 const wait=ms=>new Promise(r=>setTimeout(r,motion()?ms:0));
 $$('.lp-pick').forEach(b=>b.classList.toggle('is-on',b.dataset.arg===p.id));
 buildEl.querySelectorAll('li').forEach(li=>{li.className='';li.querySelector('em').textContent=''});
 $('#setup-summary').textContent='';
 $('#setup-state').textContent=t('Thinking');
 typedEl.textContent='';
 const text=t(p.prompt);
 if(motion()){
  for(const ch of text){if(run!==setupRun)return;typedEl.textContent+=ch;await wait(18);}
 }else typedEl.textContent=text;
 await wait(320);if(run!==setupRun)return;
 const built=buildFloor(p);
 const results=[t(p.type)+' · '+e(branchName),num(p.items)+' '+t('draft items'),num(built.tables.length)+' '+t('tables')+' · '+num(built.tables.reduce((n,x)=>n+x.capacity,0))+' '+t('seats')];
 const items=[...buildEl.querySelectorAll('li')];
 for(let i=0;i<items.length;i++){
  if(run!==setupRun)return;
  items[i].className='is-working';
  await wait(560);
  if(run!==setupRun)return;
  items[i].className='is-done';
  items[i].querySelector('em').textContent=results[i];
  if(i===2){setupFloorEl.innerHTML=setupFloorSvg(p);drawFloor(setupFloorEl);}
 }
 $('#setup-state').textContent=t('Draft ready');
 $('#setup-summary').textContent=t('Draft saved locally. Nothing is published yet.');
}
scene($('#setup-console'),()=>{if(!setupRun)runSetup('bistro')});

/* --------------------------------------------------------- 02 floor studio */
const canvasEl=$('#studio-canvas'),panelEl=$('#studio-panel'),trackEl=$('#studio-track');
function renderStudio(full){
 if(full)canvasEl.innerHTML=studioSvg();
 else studioTables.forEach((x,i)=>{
  const g=canvasEl.querySelector(`[data-object-id="${CSS.escape(x.id)}"]`);
  if(g)g.setAttribute('class',`floor-object svg-table state-${studioState(x,i)}`);
 });
 panelEl.innerHTML=studioPanel();
}
function setMode(mode){
 if(studio.mode===mode)return;
 studio.mode=mode;
 $$('[data-lp="mode"]').forEach(b=>{const on=b.dataset.arg===mode;b.classList.toggle('is-on',on);b.setAttribute('aria-selected',String(on))});
 $('#studio-hint').textContent=t(mode==='design'?'Select any table, then change its seats, shape and angle. The chairs redraw with it.':mode==='reserve'?'Pick a party size. Tables that cannot seat it step back automatically.':'This is the live board: seated, cooking, ready, paying, being turned.');
 renderStudio(true);
}
function studioScroll(){
 if(!trackEl||narrow()||!motion()||Date.now()<studio.pinned)return;
 const r=trackEl.getBoundingClientRect(),span=trackEl.offsetHeight-innerHeight;
 if(r.top>0||span<=0)return;
 const p=Math.min(1,-r.top/span);
 setMode(studioModes[p<.34?0:p<.68?1:2][0]);
}
loop($('.lp-studio-stage'),2800,()=>{if(studio.mode==='operate'){studio.tick++;renderStudio(false)}});

/* ------------------------------------------------------- 03 reservations  */
const bookMapEl=$('#book-map'),bookCardEl=$('#book-card');
function renderBook(){bookMapEl.innerHTML=bookMap();bookCardEl.innerHTML=bookCard();}

/* --------------------------------------------------------- 04 menu import */
const rowsEl=$('#import-rows'),pipeEl=$('#import-pipeline');
let importRun=0;
async function runImport(id){
 const run=++importRun;
 const wait=ms=>new Promise(r=>setTimeout(r,motion()?ms:0));
 if(id)importState.source=id;
 $$('.lp-source').forEach(b=>b.classList.toggle('is-on',b.dataset.arg===importState.source));
 rowsEl.innerHTML=menu.map((_,i)=>`<div class="lp-row is-skeleton" style="--i:${i}"><span></span><span></span><span></span><span></span></div>`).join('');
 $('#import-count').textContent='0';
 const stageEls=[...pipeEl.children];
 stageEls.forEach(s=>s.className='lp-pipe-step');
 for(let i=0;i<stageEls.length;i++){
  if(run!==importRun)return;
  stageEls[i].className='lp-pipe-step is-active';
  await wait(260);
  if(run!==importRun)return;
  stageEls[i].className='lp-pipe-step is-done';
 }
 rowsEl.innerHTML='';
 for(let i=0;i<menu.length;i++){
  if(run!==importRun)return;
  rowsEl.insertAdjacentHTML('beforeend',importRow(menu[i],i));
  $('#import-count').textContent=num(i+1);
  await wait(55);
 }
}
scene($('.lp-workspace'),()=>{if(!importRun)runImport()});

/* --------------------------------------------------------- 05 guest phone */
const screenEl=$('#phone-screen');
function setService(i,manual){
 service.step=(i+serviceSteps.length)%serviceSteps.length;
 $$('#service-steps li').forEach((li,n)=>li.classList.toggle('is-on',n===service.step));
 screenEl.classList.add('is-swap');
 screenEl.innerHTML=phoneScreen();
 requestAnimationFrame(()=>screenEl.classList.remove('is-swap'));
 if(manual)service.pinned=Date.now()+12000;
}
loop($('.lp-service-stage'),5200,()=>{if(!(Date.now()<(service.pinned||0)))setService(service.step+1)});
scene($('.lp-service-stage'),()=>root.classList.add('lp-media-on'));

/* -------------------------------------------------------------07 payments */
const payEl=$('#pay-stage');
function renderPay(){payEl.innerHTML=payStage()}
let payHold=0;
loop($('.lp-payments'),2400,()=>{
 const max=pay.mode==='full'?1:4;
 if(pay.settled<max){pay.settled++;payHold=0;return renderPay()}
 // Hold the settled table for a beat, then run it again so a visitor who
 // arrives late still sees the bill close itself.
 if(++payHold>=3){payHold=0;pay.settled=0;pay.rated=false;renderPay()}
});

/* ------------------------------------------------------ 08 ai manager     */
const insightEl=$('#insight-list');
scene($('.lp-insights'),()=>{
 if(insightEl.dataset.done)return;
 insightEl.dataset.done='1';
 const states=['Reading kitchen load','Comparing to last Friday','3 signals worth raising'];
 [...insightEl.children].forEach((li,i)=>setTimeout(()=>li.classList.add('is-in'),motion()?260*i+200:0));
 if(motion())states.forEach((s,i)=>setTimeout(()=>{$('#ops-state').textContent=t(s)},700*(i+1)));
});

/* ----------------------------------------------------------- 09 connect   */
const orbitEl=$('#orbit'),detailEl=$('#connect-detail');
function renderConnect(){orbitEl.innerHTML=patchBoard();detailEl.innerHTML=connectDetail();}

/* ------------------------------------------------------------ 10 pricing  */
function renderPlans(){
 $('#plan-grid').innerHTML=planCards();
 $$('[data-lp="billing"]').forEach(b=>b.classList.toggle('is-on',(b.dataset.arg==='yearly')===price.yearly));
}

/* ===================================================================== */
/* one delegated interaction handler                                     */
/* ===================================================================== */
root.addEventListener('click',ev=>{
 const el=ev.target.closest('[data-lp]');
 if(el){
  const arg=el.dataset.arg;
  switch(el.dataset.lp){
   case 'drawer':return setDrawer(arg==='open');
   case 'preset':return void runSetup(arg);
   case 'mode':studio.pinned=Date.now()+10000;return setMode(arg);
   case 'tool':return $$('[data-lp="tool"]').forEach(b=>b.classList.toggle('is-on',b===el));
   case 'seats':{
    const x=studioTables.find(y=>y.id===studio.sel);
    x.capacity=Math.min(12,Math.max(1,x.capacity+Number(arg)));
    if(x.shape!=='rect'){const s=Math.min(150,80+x.capacity*7);x.width=s;x.height=s;}
    return renderStudio(true);
   }
   case 'shape':{
    const x=studioTables.find(y=>y.id===studio.sel);
    x.shape=arg;
    if(arg==='rect'){x.width=160;x.height=90}else{const s=Math.min(150,80+x.capacity*7);x.width=s;x.height=s}
    return renderStudio(true);
   }
   case 'party':studio.party=Number(arg);return renderStudio(true);
   case 'slot':book.slot=arg;book.done=false;return renderBook();
   case 'bparty':{
    book.party=Number(arg);book.done=false;
    if(!bookable().some(x=>x.id===book.table))book.table=bookable()[0]?.id||book.table;
    return renderBook();
   }
   case 'hold':book.done=true;return renderBook();
   case 'rebook':book.done=false;return renderBook();
   case 'source':return void runImport(arg);
   case 'replay-import':return void runImport();
   case 'service':return setService(Number(arg),true);
   case 'split':pay.mode=arg;pay.settled=0;pay.rated=false;$$('.lp-mode').forEach(b=>b.classList.toggle('is-on',b.dataset.arg===arg));return renderPay();
   case 'settle':pay.settled=Math.min(pay.mode==='full'?1:4,pay.settled+1);return renderPay();
   case 'rate':pay.rated=true;return renderPay();
   case 'replay-pay':pay.settled=0;pay.rated=false;return renderPay();
   case 'cmode':connect.mode=arg;connect.kind=arg==='native'?'module':'provider';connect.node=0;$$('[data-lp="cmode"]').forEach(b=>{const on=b.dataset.arg===arg;b.classList.toggle('is-on',on);b.setAttribute('aria-selected',String(on))});return renderConnect();
   case 'node':{const [kind,index]=arg.split(':');connect.kind=kind==='m'?'module':'provider';connect.node=Number(index);return renderConnect();}
   case 'billing':price.yearly=arg==='yearly';return renderPlans();
  }
  return;
 }
 const tableEl2=ev.target.closest('[data-object-id]');
 if(!tableEl2)return;
 const id=tableEl2.dataset.objectId;
 if(tableEl2.closest('#hero-floor')){const i=heroIds.indexOf(id);if(i>=0)heroDetail(i);return}
 if(tableEl2.closest('#studio-canvas')){studio.sel=id;studio.pinned=Date.now()+10000;return renderStudio(true)}
 if(tableEl2.closest('#book-map')){if(bookable().some(x=>x.id===id)){book.table=id;book.done=false;renderBook()}}
});
root.addEventListener('input',ev=>{
 if(ev.target.dataset.lp!=='rotate')return;
 const x=studioTables.find(y=>y.id===studio.sel);
 x.rotation=Number(ev.target.value);
 canvasEl.innerHTML=studioSvg();
 const v=panelEl.querySelector('.lp-field-value');
 if(v)v.textContent=num(x.rotation)+'°';
});
root.addEventListener('keydown',ev=>{
 const g=ev.target.closest?.('[data-object-id]');
 if(g&&(ev.key==='Enter'||ev.key===' ')){ev.preventDefault();g.dispatchEvent(new MouseEvent('click',{bubbles:true}))}
});

/* ------------------------------------------------------------- 06 kitchen */
const board=$('#kds-board');
let ticketSeq=47;
const ticketEl=t2=>`<article class="lp-ticket-card" data-id="${t2.id}" data-min="${t2.min}"><header><b>#${num(t2.id)}</b><span>${t('Table')} ${num(t2.table)}</span><time>${String(t2.min).padStart(2,'0')}:00</time></header><span class="lp-station">${t(t2.station)}</span><ul>${t2.items.map(x=>`<li>${t(x)}</li>`).join('')}</ul></article>`;
kdsSeed.forEach(x=>board.querySelector(`[data-list="${kdsColumns[x.col][0]}"]`).insertAdjacentHTML('beforeend',ticketEl(x)));
function kdsAdvance(){
 const cols=kdsColumns.map(([id])=>board.querySelector(`[data-list="${id}"]`));
 const done=cols[2].firstElementChild;
 if(done){done.classList.add('is-out');setTimeout(()=>done.remove(),420)}
 for(let i=2;i>0;i--){
  const card=cols[i-1].firstElementChild;
  if(card){card.classList.add('is-move');cols[i].append(card);setTimeout(()=>card.classList.remove('is-move'),60)}
 }
 const seedRow=kdsSeed[ticketSeq%kdsSeed.length];
 cols[0].insertAdjacentHTML('beforeend',ticketEl({...seedRow,id:++ticketSeq,min:0}));
 $('#kds-open').textContent=num(board.querySelectorAll('.lp-ticket-card').length);
}
function kdsClock(){
 board.querySelectorAll('.lp-ticket-card').forEach(card=>{
  const m=Number(card.dataset.min),s=(Number(card.dataset.sec||0)+7)%60;
  card.dataset.sec=s;
  if(!s)card.dataset.min=m+1;
  card.querySelector('time').textContent=`${String(card.dataset.min).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  card.classList.toggle('is-late',Number(card.dataset.min)>=8);
 });
}
loop($('.lp-kds'),3600,kdsAdvance);
loop($('.lp-kds-board'),1000,kdsClock);

/* ------------------------------------------------------------- resize     */
let wide=!narrow(),rt;
addEventListener('resize',()=>{
 clearTimeout(rt);
 rt=setTimeout(()=>{
  if(wide===!narrow())return;
  wide=!narrow();
  heroFloorEl.innerHTML=heroFloor(heroStates);
  canvasEl.innerHTML=studioSvg();
 },220);
});
reduced.addEventListener?.('change',()=>location.reload());
onScroll();

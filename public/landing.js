/* Resuto landing page — a product-led, live composition.
   Everything on this page is rendered from the same data and floor renderer the
   real product uses, so the marketing surface cannot drift from the app. */
import {sceneSvg,escapeHtml as e} from './floor-shared.js';
import {money,t,language,switcher} from './i18n.js';
import logos from './company-logos.js';
import marks from './brand-marks.js';
import {importSection,mountImport} from './landing-import.js';
import {kitchenSection,mountKitchen} from './landing-kitchen.js';
import {managerSection,mountManager} from './landing-manager.js';
import {billSection,mountBill} from './landing-bill.js';
import {reserveSection,mountReserve} from './landing-reserve.js';
import {pricingSection,mountPricing} from './landing-pricing.js';
import {createTour} from './landing-stage.js';

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
   <a class="lp-btn lp-btn-solid" href="/restaurant"><span class="lp-cta-long">${t('Open the live demo')}</span><span class="lp-cta-short">${t('Live demo')}</span></a>
   <button class="lp-burger" data-lp="drawer" data-arg="open" aria-expanded="false" aria-controls="lp-drawer" aria-label="${t('Menu')}"><i></i><i></i></button>
  </div>
 </div>
 <span class="lp-nav-line" aria-hidden="true"><i id="lp-progress"></i></span>
</header>
<div class="lp-drawer" id="lp-drawer" hidden>
 <nav>${navLinks.map(([href,label])=>`<a href="${href}" data-lp="drawer" data-arg="close">${t(label)}</a>`).join('')}<a href="/pricing" data-lp="drawer" data-arg="close">${t('Compare plans')}</a></nav>
 <a class="lp-btn lp-btn-solid" href="/restaurant" data-lp="drawer" data-arg="close">${t('Open the live demo')}</a>
</div>`;

/* ------------------------------------------------------------------ hero */
const heroCycle=['available','occupied','preparing','available','ready','reserved','available','occupied','payment','available','cleaning','available'];
const heroStates=tables.map((_,i)=>heroCycle[i%heroCycle.length]);
const feed=[
 {i:7,state:'ordering',title:'Ordering by QR',meta:'Menu opened in the browser'},
 {i:5,state:'preparing',title:'Order sent to the kitchen',meta:'2 mains · order #042'},
 {i:4,state:'ready',title:'Ready to serve',meta:'Order #041'},
 {i:8,state:'payment',title:'Bill split four ways',meta:'2 of 4 shares paid'},
 {i:2,state:'reserved',title:'Reserved for 8:00 PM',meta:'Party of 6 · Terrace'},
 {i:10,state:'cleaning',title:'Needs cleaning',meta:'Bill paid · guests left'},
 {i:1,state:'occupied',title:'Guests seated',meta:'Party of 2 · walk-in'},
 {i:11,state:'available',title:'Open again',meta:'Main Room · 4 seats'}
];

function heroFloor(states){
 const view=narrow()?NARROW_VIEW:`0 0 ${plan.width} ${plan.height}`;
 return `<svg class="lp-floor-svg" viewBox="${view}" role="img" aria-label="${t('Live floor plan of the restaurant')}">${localizeScene(sceneSvg({...plan,tables:tables.map((x,i)=>({...x,state:states[i]}))},{mode:'operations'}))}</svg>`;
}

// Every footer figure is counted from the table states on the floor above it.
const heroMetrics=[
 ['Tables in service',s=>s.filter(x=>!['available','reserved','cleaning'].includes(x)).length],
 ['In the kitchen',s=>s.filter(x=>x==='preparing').length],
 ['Ready to serve',s=>s.filter(x=>x==='ready').length],
 ['Bills open',s=>s.filter(x=>x==='payment').length]
];

const hero=()=>`<section class="lp-hero">
 <div class="lp-hero-glow" aria-hidden="true"></div>
 <div class="lp-shell lp-hero-head">
  <h1><span>${t('Run the room.')}</span><em>${t('Resuto runs everything else.')}</em></h1>
  <p>${t('One system for the whole service: a floor plan your guests book from, QR ordering, the kitchen board, split bills and a manager view. In Arabic and English.')}</p>
  <div class="lp-hero-cta">
   <a class="lp-btn lp-btn-solid lp-btn-lg" href="/restaurant">${t('Open the live demo')} ${arrow}</a>
   <a class="lp-btn lp-btn-ghost lp-btn-lg" href="#studio">${t('See the Floor Studio')}</a>
  </div>
 </div>
 <div class="lp-shell">
  <div class="lp-stage" id="hero-stage">
   <header class="lp-stage-bar">
    <span class="lp-dots" aria-hidden="true"><i></i><i></i><i></i></span>
    <strong>${t('Service view')}</strong>
    <span class="lp-stage-clock" id="hero-clock">${clock(19,42)}</span>
    <span class="lp-stage-live"><i></i>${t('Live')}</span>
   </header>
   <div class="lp-stage-body">
    <div class="lp-stage-floor"><div id="hero-floor">${heroFloor(heroStates)}</div><span class="lp-try">${t('Click any table')}</span></div>
    <aside class="lp-stage-side">
     <div class="lp-side-head"><span>${t('Service feed')}</span><small>${t('Auto-updating')}</small></div>
     <ul class="lp-feed" id="hero-feed"></ul>
     <div class="lp-legend" id="hero-legend"></div>
     <div class="lp-side-table" id="hero-table"></div>
    </aside>
   </div>
   <footer class="lp-stage-metrics" id="hero-metrics">${heroMetrics.map(([label,count])=>`<div><small>${t(label)}</small><strong>${num(count(heroStates))}</strong></div>`).join('')}<div class="lp-stage-note">${t('Sample service data')}</div></footer>
  </div>
 </div>
</section>`;

/* ------------------------------------------------------- the system band */
const systemNodes=[
 ['#studio','Floor Studio','One saved room'],
 ['#reserve','Reservations','Guests pick a real table'],
 ['#import','Menu import','PDF, photo or CSV'],
 ['#service','Guest ordering','QR menu, no app'],
 ['#kitchen','Kitchen','One board, station labels'],
 ['#payments','Payments','Split, pay, rate'],
 ['#operations','Manager view','Revenue, stock, load']
];

const systemBand=()=>`<section class="lp-system" aria-label="${t('How Resuto fits together')}">
 <div class="lp-shell">
  <div class="lp-system-head" data-reveal><h2>${t('Not seven tools. One order, followed all the way through.')}</h2><p>${t('Every part works from the same floor, the same menu and the same bill, so nothing is typed in twice.')}</p></div>
  <div class="lp-system-rail" data-reveal>
   <svg class="lp-system-line" viewBox="0 0 1200 40" preserveAspectRatio="none" aria-hidden="true"><path class="lp-line-base" d="M0 20H1200"/><path class="lp-flow" d="M0 20H1200"/></svg>
   <ol>${systemNodes.map(([href,title,detail],i)=>`<li style="--i:${i}"><a href="${href}"><i aria-hidden="true"></i><strong>${t(title)}</strong><small>${t(detail)}</small></a></li>`).join('')}</ol>
  </div>
 </div>
</section>`;

/* ------------------------------------------------- 02 · Floor Studio     */
const studio={sel:null,tool:'Select'};
// The studio starts from an empty room: everything below is placed, one object at a time.
const studioTables=[],studioDraft={zones:[],objects:[]};
const draftTable=(n,shape,capacity,cx,cy,zone='Main Room',features=['Non-smoking','Center'])=>({id:'b-t'+n,label:'T'+n,capacity,zone,shape,cx,cy,width:shape==='rect'?160:100,height:shape==='rect'?90:100,rotation:0,features,reservable:true,premium:false,state:'available'});
// The story: draw the room, place the tables, reshape one, give it more seats,
// then save and every table gets its QR code.
const studioRoom=[{id:'b-main',type:'zone',label:t('Main Room'),x:600,y:290,width:1080,height:470,rotation:0,color:'#e9e6dc'},{id:'b-wall',type:'wall',label:'North wall',x:600,y:46,width:1120,height:16,rotation:0},{id:'b-window',type:'window',label:'Window side',x:800,y:58,width:550,height:12,rotation:0},{id:'b-door',type:'door',label:t('Entrance'),x:110,y:742,width:110,height:35,rotation:0}];
const studioSeats=[draftTable(1,'round',2,230,200),draftTable(2,'square',4,500,200),draftTable(3,'square',4,800,200),draftTable(4,'square',4,230,430),draftTable(5,'round',4,500,430)];
const studioExtras=[{id:'b-bar',type:'counter',label:t('Bar'),x:1090,y:300,width:70,height:250,rotation:0},{id:'b-terrace',type:'zone',label:t('Terrace'),x:600,y:655,width:1080,height:200,rotation:0,color:'#e0e9d7'},draftTable(6,'round',4,500,655,'Terrace',['Smoking','Terrace']),draftTable(7,'square',4,800,655,'Terrace',['Smoking','Terrace'])];
function studioAdd(o){
 if(o.capacity!==undefined)studioTables.push({...o,features:[...o.features]});
 else (o.type==='zone'?studioDraft.zones:studioDraft.objects).push({...o});
}
function studioClear(){studioTables.length=0;studioDraft.zones.length=0;studioDraft.objects.length=0;studio.sel=null}
[...studioRoom,...studioSeats,...studioExtras].forEach(studioAdd);
function studioSvg(){
 const list=studioTables.map(x=>({...x,state:'available'}));
 // Always the whole room, so every placement and every QR code is in view on a phone too.
 const view=`0 0 ${plan.width} ${plan.height}`;
 return `<svg class="lp-floor-svg" viewBox="${view}" role="img" aria-label="${t('Restaurant floor plan')}">${localizeScene(sceneSvg({...plan,zones:studioDraft.zones,objects:studioDraft.objects,tables:list},{editor:true,grid:true,selected:[studio.sel],mode:'design'}))}</svg>`;
}

function studioPanel(){
 const x=studioTables.find(y=>y.id===studio.sel);
 if(!x)return `<div class="lp-panel-head"><span>${t('Object')}</span><strong>—</strong></div><p class="lp-panel-note">${t('Pick a tool, then click the room to place it. Select a table to set its seats, shape and features.')}</p>`;
 return `<div class="lp-panel-head"><span>${t('Object')}</span><strong>${e(x.label)}</strong></div>
  <div class="lp-field"><label for="lp-seats">${t('Seats')}</label><div class="lp-stepper"><button type="button" data-lp="seats" data-arg="-1" aria-label="${t('Fewer seats')}">−</button><output id="lp-seats">${num(x.capacity)}</output><button type="button" data-lp="seats" data-arg="1" aria-label="${t('More seats')}">+</button></div></div>
  <div class="lp-field"><span class="lp-field-label">${t('Shape')}</span><div class="lp-seg lp-seg-sm">${[['round','Round'],['square','Square'],['rect','Long']].map(([s,l])=>`<button type="button" class="${x.shape===s?'is-on':''}" data-lp="shape" data-arg="${s}">${t(l)}</button>`).join('')}</div></div>
  <div class="lp-field"><label for="lp-rot">${t('Rotation')}</label><input id="lp-rot" class="lp-range" type="range" min="0" max="345" step="15" value="${x.rotation||0}" data-lp="rotate"><span class="lp-field-value">${num(x.rotation||0)}°</span></div>
  <div class="lp-field"><span class="lp-field-label">${t('Features')}</span><div class="lp-feats">${['Window side','Quiet area','Booth','Accessible'].map(f=>`<button type="button" class="${x.features.includes(f)?'is-on':''}" data-lp="feature" data-arg="${f}" aria-pressed="${x.features.includes(f)}">${t(f)}</button>`).join('')}<button type="button" class="${x.premium?'is-on':''}" data-lp="feature" data-arg="premium" aria-pressed="${!!x.premium}">${t('Premium')}</button></div></div>
  <p class="lp-panel-note">${t('Each table gets its own QR code when the room is saved.')}</p>`;
}

const studioTools=[['Select','M4 3l14 7-6 2-2 6z'],['Table','M4 6h16v4H4zM8 10v8M16 10v8'],['Zone','M3 5h18v14H3z'],['Wall','M3 12h18M3 9v6M21 9v6'],['Window','M3 12h18M8 9v6M16 9v6'],['Door','M6 4h12v16M6 4v16h6'],['Counter','M3 9h18v6H3zM7 15v4M17 15v4'],['Plant','M12 20v-8M12 12c0-4 3-6 6-6 0 4-3 6-6 6zm0 0c0-4-3-6-6-6 0 4 3 6 6 6z'],['Label','M5 6h14M12 6v12']];

const studioSection=()=>`<section class="lp-studio" id="studio">
 <div class="lp-studio-track" id="studio-track">
  <div class="lp-studio-sticky">
   <div class="lp-shell">
    <div class="lp-studio-head">
     <div data-reveal><span class="lp-chapter-tag is-dark">${t('Floor Studio')}</span><h2>${t('Draw the room once. Use it everywhere.')}</h2></div>
     <p data-reveal>${t('The plan you draw becomes the map guests book from, the QR identity of every table and the board your team runs service on. There is no second layout to maintain.')}</p>
     <ul class="lp-studio-uses" data-reveal>${[['Reservation map','Guests pick a real table'],['Table QR codes','One for every table'],['Service board','The same room, live']].map(([a,b])=>`<li><b>${t(a)}</b><small>${t(b)}</small></li>`).join('')}</ul>
    </div>
    <div class="lp-studio-stage" data-reveal>
     <div class="lp-tools" role="toolbar" aria-label="${t('Floor objects')}">${studioTools.map(([id,d],i)=>`<button type="button" class="${i?'':'is-on'}" data-lp="tool" data-arg="${id}" aria-label="${t(id)}" title="${t(id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg><span>${t(id)}</span></button>`).join('')}</div>
     <div class="lp-studio-work"><div class="lp-studio-top"><div class="lp-studio-stats" id="studio-stats"></div><button type="button" class="lp-studio-save" data-lp="save-room">${t('Save room')}</button></div><div class="lp-studio-canvas" id="studio-canvas">${studioSvg()}</div></div>
     <aside class="lp-studio-panel" id="studio-panel">${studioPanel()}</aside>
    </div>
    <div class="lp-studio-foot"><div data-guide></div><a class="lp-inline is-dark" href="/reserve">${t('Try the guest map')} ${arrow}</a></div>
   </div>
  </div>
 </div>
</section>`;

/* Reservations live in landing-reserve.js. */

/* The menu import demo lives in landing-import.js. */

/* ------------------------------------- 05 · QR ordering and AI ordering  */
const qrTable=data.tables.find(x=>x.qr)||data.tables[0]||{label:'T1',qr:''};
const serviceSteps=[
 ['scan','Scan the table','No app and no account. The menu opens in the browser.'],
 ['browse','Add from the live menu','Sold-out dishes are marked the moment the kitchen says so.'],
 ['cart','Confirm the order','Prices and stock are checked again when it is sent.'],
 ['track','Follow the order','The guest sees the status the kitchen sets.']
];
const pickable=menu.slice(0,3);
const service={step:0,cart:new Set(),status:0};
const cartLines=()=>pickable.filter(m=>service.cart.has(m.id));
const cartTotal=()=>cartLines().reduce((n,m)=>n+m.price,0);
const trackSteps=['Order received','Preparing','Ready','Served'];

function phoneScreen(){
 const s=serviceSteps[service.step][0];
 if(s==='scan')return `<div class="lp-scr lp-scr-scan"><span class="lp-scr-eyebrow">${e(data.settings.name)}</span><strong>${e(qrTable.label)}</strong><div class="lp-qr"><img src="/qr/${e(qrTable.qr)}" alt="${t('Table QR code')}" loading="lazy" width="180" height="180"><span class="lp-qr-scan" aria-hidden="true"></span></div><p>${t('Scan to open the menu')}</p><small>${t('Opens in the browser. Nothing to install.')}</small></div>`;
 if(s==='browse')return `<div class="lp-scr lp-scr-menu"><div class="lp-scr-bar"><strong>${t('Menu')}</strong><span>${e(qrTable.label)}</span></div><div class="lp-scr-tabs">${['Starters','Mains','Desserts'].map((c,i)=>`<span class="${i?'':'is-on'}">${t(c)}</span>`).join('')}</div><div class="lp-scr-list">${pickable.map(m=>`<article class="lp-scr-dish${service.cart.has(m.id)?' is-added':''}">${dish(m)}<div><b>${e(nameOf(m))}</b><small><bdi>${money(m.price)}</bdi></small></div><button type="button" data-lp="add" data-arg="${e(m.id)}" aria-pressed="${service.cart.has(m.id)}" aria-label="${t('Add')} ${e(nameOf(m))}"><span aria-hidden="true">${service.cart.has(m.id)?'✓':'+'}</span></button></article>`).join('')}</div><button type="button" class="lp-scr-dock" data-lp="cart"${service.cart.size?'':' disabled'}><span>${num(service.cart.size)} ${t('in your order')}</span><b>${money(cartTotal())}</b></button></div>`;
 if(s==='cart')return `<div class="lp-scr lp-scr-cart"><div class="lp-scr-bar"><strong>${t('Your order')}</strong><span>${e(qrTable.label)}</span></div><div class="lp-scr-list">${cartLines().map(m=>`<article class="lp-scr-dish">${dish(m)}<div><b>${e(nameOf(m))}</b><small>${num(1)} × <bdi>${money(m.price)}</bdi></small></div></article>`).join('')||`<p class="lp-scr-empty">${t('Nothing added yet.')}</p>`}<div class="lp-scr-total"><span>${t('Total')}</span><b><bdi>${money(cartTotal())}</bdi></b></div></div><button type="button" class="lp-scr-cta" data-lp="confirm"${service.cart.size?'':' disabled'}>${t('Confirm order')}</button></div>`;
 return `<div class="lp-scr lp-scr-track"><div class="lp-scr-bar"><strong>${t('Order status')}</strong><span><bdi dir="ltr">#${num(42)}</bdi> · ${e(qrTable.label)}</span></div><ol class="lp-track">${trackSteps.map((l,i)=>`<li class="${i<service.status?'done':i===service.status?'now':''}"><i></i>${t(l)}</li>`).join('')}</ol><ul class="lp-track-lines">${cartLines().map(m=>`<li>${num(1)} × ${e(nameOf(m))}</li>`).join('')}</ul></div>`;
}

const serviceSection=()=>`<section class="lp-service" id="service">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">${t('Guest service')}</span><h2>${t('The table becomes the waiter’s second pair of hands.')}</h2></div>
   <p>${t('A guest scans the table, orders in Arabic or English and follows the kitchen, while the floor team keeps working the room.')}</p>
  </div>
  <div class="lp-service-stage" data-reveal>
   <ol class="lp-service-steps" id="service-steps">${serviceSteps.map(([id,title,detail],i)=>`<li class="${i?'':'is-on'}"><button type="button" data-lp="service" data-arg="${i}"><span>${num(i+1)}</span><strong>${t(title)}</strong><small>${t(detail)}</small></button></li>`).join('')}</ol>
   <div class="lp-phone-wrap">
    <div class="lp-phone"><span class="lp-phone-notch" aria-hidden="true"></span><div class="lp-phone-screen" id="phone-screen">${phoneScreen()}</div></div>
    <div class="lp-phone-glow" aria-hidden="true"></div>
   </div>
   <div class="lp-service-notes">
    <div data-guide></div>
    <article><strong>${t('A menu assistant that stays honest')}</strong><p>${t('Guests can ask for a suggestion. It only proposes dishes from the live menu, lists stated allergens, and the guest still confirms the order.')}</p></article>
    <article><strong>${t('Every table has an identity')}</strong><p>${t('The QR belongs to the table, not to a printed page, so moving furniture never breaks a code.')}</p></article>
    <a class="lp-inline" href="/restaurant">${t('Open the guest experience')} ${arrow}</a>
   </div>
  </div>
 </div>
</section>`;

/* The kitchen demo lives in landing-kitchen.js. */

/* Bill splitting lives in landing-bill.js. */

/* The manager view demo lives in landing-manager.js. */

/* ------------------------------------------------------- integrations */
// Logos only. Names are kept for screen readers.
const integrations=[['Stripe',marks.stripe],['Paymob',logos.paymob,'','is-word'],['Tap Payments',null,'tap'],['Foodics',logos.foodics,'','is-word'],['Odoo',marks.odoo],['WhatsApp',marks.whatsapp],['Meta',marks.meta],['Google Gemini',marks.googlegemini]];
const connectSection=()=>`<section class="lp-chapter lp-connect" id="connect">
 <div class="lp-shell itx">
  <div class="itx-head" data-reveal>
   <h2>${t('Runs on its own.')} ${t('Connects where it is ready.')}</h2>
   <p>${t('Resuto works without any of these. Connect the ones you already use.')}</p>
  </div>
  <ul class="itx-row" data-reveal>${integrations.map(([name,logo,mark,kind=''],i)=>`<li class="${kind}" style="--i:${i}" title="${e(name)}">${logo?`<img src="${logo}" alt="${e(name)}" loading="lazy">`:`<b role="img" aria-label="${e(name)}">${mark}</b>`}</li>`).join('')}</ul>
 </div>
</section>`;

/* Pricing and the plan comparison live in landing-pricing.js. */

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
  <small>© ${new Date().getFullYear()} Resuto</small>
 </div>
</footer>`;

/* ===================================================================== */
/* mount                                                                 */
/* ===================================================================== */
document.title=rtl?'ريسوتو: حجوزات المطاعم وطلبات QR وشاشة المطبخ وتقسيم الفاتورة':'Resuto: restaurant reservations, QR ordering, kitchen display and split bills';
root.className='lp';
root.innerHTML=nav()+`<main class="lp-main">${hero()}${systemBand()}${studioSection()}${reserveSection({t,num,e,arrow,tables,restaurant:data.settings.name,branch:branchName})}${importSection({t,money,rtl,e})}${serviceSection()}${kitchenSection({t,arrow})}${billSection({t,money,e,arrow})}${managerSection({t,arrow})}${connectSection()}${pricingSection({t})}${ctaSection()}</main>`+footer();

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
const stateWord={available:'Open',occupied:'Seated',ordering:'Ordering',preparing:'Preparing',ready:'Ready',payment:'Paying',reserved:'Reserved',cleaning:'Cleaning'};
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
 [...$('#hero-metrics').querySelectorAll('strong')].forEach((el,i)=>{
  const v=num(heroMetrics[i][1](heroStates));
  if(el.textContent===v)return;
  el.textContent=v;
  if(motion())el.animate([{transform:'translateY(6px)',opacity:.2},{transform:'none',opacity:1}],{duration:360,easing:'cubic-bezier(.25,1,.5,1)'});
 });
}
const legendEl=$('#hero-legend');
const legendOrder=[['available','Open'],['occupied','Seated'],['preparing','Preparing'],['ready','Ready'],['payment','Paying'],['cleaning','Cleaning']];
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
loop($('#hero-stage'),2300,heroTick);

/* --------------------------------------------------------- 02 floor studio */
const canvasEl=$('#studio-canvas'),panelEl=$('#studio-panel'),trackEl=$('#studio-track');
function renderStudio(full){
 if(full)canvasEl.innerHTML=studioSvg();
 panelEl.innerHTML=studioPanel();
 $('#studio-stats').innerHTML=[[studioDraft.zones.length,'zones'],[studioTables.length,'tables'],[studioTables.reduce((n,x)=>n+x.capacity,0),'seats'],[studioDraft.objects.length,'objects']].map(([n,l])=>`<span><b>${num(n)}</b> ${t(l)}</span>`).join('');
}
// Where a point on the plan sits on screen, relative to the tour's host.
function studioPoint(x,y){
 const svg=canvasEl.querySelector('svg'),vb=svg.viewBox.baseVal,r=svg.getBoundingClientRect(),h=$('#studio .lp-shell').getBoundingClientRect();
 const k=Math.min(r.width/vb.width,r.height/vb.height),ox=r.left+(r.width-vb.width*k)/2,oy=r.top+(r.height-vb.height*k)/2;
 return {x:Math.min(r.right-12,Math.max(r.left+12,ox+(x-vb.x)*k))-h.left,y:Math.min(r.bottom-12,Math.max(r.top+12,oy+(y-vb.y)*k))-h.top};
}
function studioPlace(o){
 studioAdd(o);
 if(o.capacity!==undefined)studio.sel=o.id;
 renderStudio(true);
 canvasEl.querySelector(`[data-object-id="${CSS.escape(o.id)}"]`)?.classList.add('is-placed');
}
// A visitor can place things too: pick a tool, click the room.
let placed=0;
canvasEl.addEventListener('click',ev=>{
 if(!ev.isTrusted||ev.target.closest('.svg-table'))return;
 const svg=canvasEl.querySelector('svg'),p=new DOMPoint(ev.clientX,ev.clientY).matrixTransform(svg.getScreenCTM().inverse()),x=Math.round(p.x),y=Math.round(p.y),id='v-'+(++placed);
 const made={Table:()=>({...draftTable(studioTables.length+1,'square',4,x,y),id}),Plant:()=>({id,type:'plant',label:'Plant',x,y,width:46,height:46,rotation:0}),Door:()=>({id,type:'door',label:t('Entrance'),x,y,width:110,height:35,rotation:0}),Counter:()=>({id,type:'counter',label:t('Bar'),x,y,width:70,height:200,rotation:0})}[studio.tool];
 if(made)studioPlace(made());
});
renderStudio(false);

const tourOpts={t,reduced:reduced.matches};
// Saving the room gives every table its own QR code.
function studioCodes(on){
 canvasEl.querySelectorAll('.lp-qr-chip').forEach(x=>x.remove());
 canvasEl.classList.toggle('is-saved',on);
 if(!on)return;
 const host=$('#studio .lp-shell').getBoundingClientRect(),box=canvasEl.getBoundingClientRect();
 studioTables.forEach((x,i)=>{
  const p=studioPoint(x.cx,x.cy),chip=document.createElement('span');
  chip.className='lp-qr-chip';chip.style.cssText=`left:${p.x+host.left-box.left}px;top:${p.y+host.top-box.top}px;--i:${i}`;
  chip.innerHTML=`<i aria-hidden="true"></i><b>${e(x.label)}</b>`;
  canvasEl.append(chip);
 });
}
createTour($('#studio .lp-shell'),{...tourOpts,pointer:'cursor',hold:3600,
 manualHint:'Pick Table, Plant, Door or Counter, then click the room. Click a table to change its shape and seats.',
 onTakeover:()=>studioCodes(false),
 script:async({c,tap,say,cursor})=>{
  canvasEl.classList.add('is-swap');
  await c.wait(320);
  studioCodes(false);studioClear();renderStudio(true);
  canvasEl.classList.remove('is-swap');
  say('Draw the room');
  await tap(c,'[data-lp="tool"][data-arg="Zone"]',{ms:440,wait:120});
  await cursor.move(c,studioPoint(600,290),480);await cursor.press(c);
  studioRoom.forEach(studioPlace);
  await c.wait(800);
  say('Place the tables');
  await tap(c,'[data-lp="tool"][data-arg="Table"]',{ms:440,wait:120});
  await cursor.move(c,studioPoint(230,200),460);await cursor.press(c);
  for(const o of studioSeats){studioPlace(o);await c.wait(170)}
  await c.wait(500);
  say('Change a table’s shape');
  await tap(c,'[data-lp="tool"][data-arg="Select"]',{ms:400,wait:100});
  await cursor.move(c,studioPoint(800,200),440);await cursor.press(c);
  studio.sel='b-t3';renderStudio(true);
  await c.wait(350);
  await tap(c,'[data-lp="shape"][data-arg="rect"]',{ms:520,wait:900});
  say('Give it more seats');
  await tap(c,'[data-lp="seats"][data-arg="1"]',{ms:420,wait:260});
  await tap(c,'[data-lp="seats"][data-arg="1"]',{ms:120,wait:900});
  say('Save: every table gets its own QR code');
  studioExtras.forEach(studioAdd);studio.sel=null;renderStudio(true);
  await tap(c,'[data-lp="save-room"]',{ms:520,wait:200});
  await cursor.hide(c,200);
 }
});

/* ------------------------------------------------------- 03 reservations  */
mountReserve(root,{t,num,e,tables,reduced:reduced.matches});

/* --------------------------------------------------------- 04 menu import */
mountImport(root,{t,money,num,reduced:reduced.matches});

/* --------------------------------------------------------- 05 guest phone */
const screenEl=$('#phone-screen');
const slide=el=>{if(motion())el.animate([{opacity:0,transform:`translateX(${rtl?-22:22}px)`},{opacity:1,transform:'none'}],{duration:420,easing:'cubic-bezier(.32,.72,0,1)'})};
let trackTimer=0;
function setService(i){
 service.step=(i+serviceSteps.length)%serviceSteps.length;
 $$('#service-steps li').forEach((li,n)=>li.classList.toggle('is-on',n===service.step));
 // On a phone the steps are a sideways strip: keep the current one in view without moving the page.
 const strip=$('#service-steps'),cur=strip.children[service.step];
 if(strip.scrollWidth>strip.clientWidth)strip.scrollTo({left:cur.offsetLeft-strip.offsetLeft-16,behavior:motion()?'smooth':'auto'});
 screenEl.innerHTML=phoneScreen();
 slide(screenEl.firstElementChild);
 // On the status screen the kitchen's progress arrives on its own.
 clearInterval(trackTimer);
 if(service.step===3&&motion()){
  service.status=0;
  trackTimer=setInterval(()=>{if(document.hidden)return;if(++service.status>=3)clearInterval(trackTimer);syncTrack()},1500);
 }else if(service.step===3)service.status=1;
}
// Status moves on in place, so the line fills rather than the screen redrawing.
function syncTrack(){
 screenEl.querySelectorAll('.lp-track li').forEach((li,i)=>li.className=i<service.status?'done':i===service.status?'now':'');
}
// Adding a dish changes that row and the order bar; nothing else is redrawn.
function syncMenu(){
 screenEl.querySelectorAll('[data-lp="add"]').forEach(b=>{
  const on=service.cart.has(b.dataset.arg);
  b.closest('.lp-scr-dish').classList.toggle('is-added',on);
  b.setAttribute('aria-pressed',String(on));
  b.firstElementChild.textContent=on?'✓':'+';
 });
 const dock=screenEl.querySelector('.lp-scr-dock');
 if(!dock)return;
 dock.disabled=!service.cart.size;
 dock.firstElementChild.textContent=`${num(service.cart.size)} ${t('in your order')}`;
 dock.lastElementChild.textContent=money(cartTotal());
 if(motion())dock.animate([{transform:'scale(1)'},{transform:'scale(1.035)'},{transform:'scale(1)'}],{duration:320,easing:'cubic-bezier(.25,1,.5,1)'});
}
createTour($('.lp-service-stage'),{...tourOpts,pointer:'touch',hold:1800,
 manualHint:'Click a step, add a dish, then confirm the order.',
 script:async({c,tap,say,cursor})=>{
  // Only taps a guest would make are shown, and only inside the phone.
  await cursor.hide(c,1);
  say('Scan the QR on the table');
  setService(0);
  await c.wait(2200);
  say('The menu opens: add what you want');
  setService(1);
  await c.wait(1100);
  cursor.set(screenEl,.5,.82);await cursor.show(c,260);
  await tap(c,`[data-lp="add"][data-arg="${CSS.escape(pickable[0].id)}"]`,{ms:640,wait:750});
  if(pickable[2])await tap(c,`[data-lp="add"][data-arg="${CSS.escape(pickable[2].id)}"]`,{ms:560,wait:950});
  say('Review the order');
  await tap(c,'[data-lp="cart"]',{ms:620,wait:1700});
  say('Confirm: it goes straight to the kitchen');
  await tap(c,'[data-lp="confirm"]',{ms:600,wait:500});
  await cursor.hide(c,200);
  say('Then follow the status the kitchen sets');
  await c.wait(5200);
 },
 rewind:async()=>{service.cart.clear();service.status=0},
 onTakeover:()=>clearInterval(trackTimer)
});
scene($('.lp-service-stage'),()=>root.classList.add('lp-media-on'));

/* ===================================================================== */
/* one delegated interaction handler                                     */
/* ===================================================================== */
root.addEventListener('click',ev=>{
 const el=ev.target.closest('[data-lp]');
 if(el){
  const arg=el.dataset.arg;
  switch(el.dataset.lp){
   case 'drawer':return setDrawer(arg==='open');
   case 'save-room':studio.sel=null;renderStudio(true);return studioCodes(true);
   case 'tool':studio.tool=arg;return $$('[data-lp="tool"]').forEach(b=>b.classList.toggle('is-on',b===el));
   case 'feature':{
    const x=studioTables.find(y=>y.id===studio.sel);
    if(!x)return;
    if(arg==='premium')x.premium=!x.premium;
    else x.features=x.features.includes(arg)?x.features.filter(f=>f!==arg):[...x.features,arg];
    return renderStudio(true);
   }
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
   case 'service':return setService(Number(arg));
   case 'add':service.cart.has(arg)?service.cart.delete(arg):service.cart.add(arg);return syncMenu();
   case 'cart':return service.cart.size?setService(2):undefined;
   case 'confirm':return service.cart.size?setService(3):undefined;
  }
  return;
 }
 const tableEl2=ev.target.closest('[data-object-id]');
 if(!tableEl2)return;
 const id=tableEl2.dataset.objectId;
 if(tableEl2.closest('#hero-floor')){const i=heroIds.indexOf(id);if(i>=0)heroDetail(i);return}
 if(tableEl2.closest('#studio-canvas')){studio.sel=id;return renderStudio(true)}
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

/* ------------------------------------------------- kitchen, manager, pricing */
mountKitchen(root,{t,num,e,reduced:reduced.matches});
mountManager(root,{t,num,money,reduced:reduced.matches});
mountBill(root,{t,money,num,reduced:reduced.matches});
mountPricing(root,{t,num,e,plans:pricing.plans||[],reduced:reduced.matches});

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

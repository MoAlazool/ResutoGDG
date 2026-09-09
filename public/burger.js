// Smash & Co — a second guest storefront on the same Resuto backend.
//
// It talks to the tenant-scoped API through the Smash & Co restaurant slug.
// Orders, stock, settings and kitchen tickets therefore never touch the Olive
// Room demo tenant. Product photography stays in local static assets.
import {t,language,money,nameOf,switcher} from './i18n.js';
import {tr} from './owner-import.js';
import {escapeHtml as e} from './floor-shared.js';
import {dishArt} from './burger-art.js';
document.title='Smash & Co · Order online';

const RESTAURANT_SLUG='smash-and-co',BRANCH='main';
const $=s=>document.querySelector(s),key=()=>crypto.randomUUID();
let data=null,menu=[],cart=JSON.parse(sessionStorage.getItem('smash-cart')||'[]'),category='All',fulfillment='pickup',placed=null,busy=false;
const save=()=>sessionStorage.setItem('smash-cart',JSON.stringify(cart));
const PHOTOS={b0:'classic-smash',b1:'double-smash',b2:'crispy-chicken',b3:'veggie-smash',b4:'loaded-fries',b5:'classic-fries',b6:'onion-rings',b7:'chocolate-shake',b8:'cola'};

async function api(route,body,token){
 const r=await fetch('/api/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Restaurant-Slug':RESTAURANT_SLUG,...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
 const d=await r.json();if(!r.ok)throw Error(t(d.error)||d.error);return d;
}
const toast=m=>{const el=$('#toast');el.textContent=t(m);el.className='show';setTimeout(()=>el.className='',4500)};
const qtyOf=id=>cart.filter(l=>l.id===id).reduce((n,l)=>n+l.qty,0);
const plain=id=>cart.find(l=>l.id===id&&!l.options.length);
const count=()=>cart.reduce((n,l)=>n+l.qty,0);
const total=()=>cart.reduce((n,l)=>n+l.qty*l.price,0);
const fee=()=>0;
const item=id=>menu.find(m=>m.id===id);
const desc=m=>language==='ar'?m.descriptionAr||m.description:m.description;
const photo=(m,{hero=false,eager=false}={})=>PHOTOS[m.id||'b1']
 ?`<img src="/assets/smash/${PHOTOS[m.id||'b1']}.webp" alt="${hero?'':e(nameOf(m))}" width="900" height="900" ${hero?'aria-hidden="true"':''} ${eager?'fetchpriority="high"':'loading="lazy"'}>`
 :m.imageUrl?`<img src="${e(m.imageUrl)}" alt="${e(nameOf(m))}" loading="lazy">`:dishArt(m);

// ---- pieces -----------------------------------------------------------------
const control=m=>{
 if(!m.available||!m.stock)return `<span class="bg-sold">${t('Sold out')}</span>`;
 const n=qtyOf(m.id);
 if(m.modifiers?.length)return `<button type="button" class="bg-add" data-bg="open" data-id="${m.id}">${n?`${n} ·`:''} ${tr('Add','أضف')}</button>`;
 if(!n)return `<button type="button" class="bg-add" data-bg="add" data-id="${m.id}"><span aria-hidden="true">+</span> ${tr('Add','أضف')}</button>`;
 return `<div class="bg-step" role="group" aria-label="${e(nameOf(m))}">
  <button type="button" data-bg="minus" data-id="${m.id}" aria-label="${tr('Remove one','إنقاص واحد')}">−</button>
  <output aria-live="polite">${n}</output>
  <button type="button" data-bg="plus" data-id="${m.id}" aria-label="${tr('Add one','إضافة واحد')}" ${n>=m.stock?'disabled':''}>+</button></div>`;
};

const card=(m,index=0)=>`<article class="bg-card ${qtyOf(m.id)?'in-cart':''}" data-card="${m.id}">
 <button type="button" class="bg-art" data-bg="open" data-id="${m.id}" aria-label="${e(nameOf(m))}">${photo(m,{eager:index<4})}</button>
 <div class="bg-body">
  <div class="bg-tagrow">${m.vegetarian?`<span class="bg-tag veg">${tr('Veggie','نباتي')}</span>`:''}${m.stock&&m.stock<12?`<span class="bg-tag low">${tr('Going fast','ينفد سريعاً')}</span>`:''}</div>
  <h3>${e(nameOf(m))}</h3><p>${e(desc(m))}</p>
  <div class="bg-foot"><span class="bg-price">${money(m.price)}</span><span data-ctl="${m.id}">${control(m)}</span></div>
 </div></article>`;

const categories=()=>['All',...new Set(menu.map(m=>m.category))];

function page(){
 const shown=menu.filter(m=>category==='All'||m.category===category);
 const groups=category==='All'?categories().slice(1):[category];
 $('#app').innerHTML=`<div class="bg-app">
  <header class="bg-head"><a class="bg-logo" href="/burger"><i>S</i><span>SMASH <small>&amp; CO</small></span></a>
   <nav class="bg-head-links"><button type="button" data-bg="jump">${tr('Menu','القائمة')}</button><span class="bg-open-dot">${tr('Open now','مفتوح الآن')}</span><a href="/">${tr('Powered by Resuto','مدعوم من ريسوتو')}</a>${switcher()}</nav></header>

  <section class="bg-hero"><div class="bg-hero-inner">
   <div>
    <h1>${tr('Smashed fresh.','طازج ومهروس.')}<br><em>${tr('Served fast.','يُقدّم بسرعة.')}</em></h1>
    <p>${tr('Lacy-edged patties, crisp fries and thick shakes. Made to order and ready when you are.','قطع لحم بحواف مقرمشة، بطاطس ساخنة، وميلك شيك كثيف. يُحضّر عند الطلب ويجهز في وقتك.')}</p>
    <div class="bg-mode" role="group" aria-label="${tr('Fulfillment method','طريقة الاستلام')}">
     <button type="button" data-bg="mode" data-mode="pickup" class="${fulfillment==='pickup'?'is-on':''}">${tr('Pickup','استلام')}<small>≈ 12 ${tr('min','د')}</small></button>
     <button type="button" data-bg="mode" data-mode="delivery" class="${fulfillment==='delivery'?'is-on':''}">${tr('Delivery','توصيل')}<small>Downtown</small></button>
    </div>
    <div class="bg-hero-actions">
     <button type="button" class="bg-btn" data-bg="jump">${tr('Start your order','ابدأ طلبك')} <span aria-hidden="true">→</span></button>
     <span class="bg-service-note"><i></i>${tr('Open now · 11:00 AM – 12:00 AM','مفتوح الآن · ١١ ص – ١٢ ص')}</span>
    </div>
   </div>
   <div class="bg-hero-art">${photo({id:'b1',name:'Double Smash'},{hero:true,eager:true})}<span>${tr('Made for the messy bite.','مصنوع للقضمة الشهية.')}</span></div>
  </div></section>

  <main class="bg-main" id="order">
   <nav class="bg-rail">${categories().map(c=>`<button type="button" data-bg="cat" data-cat="${e(c)}" class="${category===c?'is-on':''}">${c==='All'?tr('Everything','الكل'):t(c)}</button>`).join('')}<button type="button" class="bg-rail-bag" data-bg="bag">${tr('Bag','السلة')} · ${count()} · ${money(total())}</button></nav>
   ${category==='All'?`<section class="bg-combo"><div><h2>${tr('The Smash combo.','كومبو سماش.')}</h2><p>${tr('Any burger + classic fries + cola','أي برجر + بطاطس كلاسيك + كولا')}</p><strong>${tr('Build yours from EGP 225','كوّن وجبتك ابتداءً من ٢٢٥ ج.م')}</strong></div><div class="bg-combo-pics" aria-hidden="true">${photo({id:'b5',name:'Fries'})}${photo({id:'b0',name:'Burger'})}${photo({id:'b8',name:'Cola'})}</div><button type="button" class="bg-btn dark" data-bg="cat" data-cat="Burgers">${tr('Choose a burger','اختر برجر')} →</button></section>`:''}
   ${groups.map(g=>{const rows=shown.filter(m=>m.category===g);return rows.length?`<section class="bg-menu-group"><div class="bg-section-head"><div><small>${g==='Burgers'?tr('Our burgers','برجرنا'):t(g)}</small><h2 class="bg-section-title">${g==='Burgers'?tr('Burgers that hit different.','برجر بطعم مختلف.'):g==='Sides'?tr('More to love.','المزيد لتحبه.'):g==='Shakes'?tr('Shakes done right.','ميلك شيك كما يجب.'):tr('Keep it cold.','خليه بارد.')}</h2></div><p>${g==='Burgers'?tr('100% beef. Smashed to perfection.','لحم بقري ١٠٠٪، مهروس بإتقان.'):g==='Sides'?tr('Crisp, golden, made for dipping.','مقرمش وذهبي ومثالي للصوص.'):tr('The perfect finish to your smash.','الختام المثالي لوجبتك.')}</p></div><div class="bg-grid">${rows.map(card).join('')}</div></section>`:''}).join('')}
   <p class="bg-foot-note">${tr('Smash &amp; Co is a fictional example restaurant powered by Resuto. Product images are AI-generated food photography.','سماش آند كو مطعم تجريبي مدعوم من ريسوتو. صور المنتجات مولّدة بالذكاء الاصطناعي.')}</p>
  </main>

  <div class="bg-dock ${count()?'has-items':''}" id="dock"><div class="bg-dock-inner">
   <span class="bg-dock-count">${count()}</span>
   <span>${tr('Your bag','سلّتك')}</span>
   <span class="bg-dock-total">${money(total())}</span>
   <button type="button" class="bg-btn sm" data-bg="bag">${tr('Checkout','إتمام الطلب')}</button>
  </div></div>
 </div>`;
}

// Repaint only what changed, so the page never jumps back to the top.
function sync(id){
 const slot=document.querySelector(`[data-ctl="${CSS.escape(id)}"]`),m=item(id);
 if(slot&&m)slot.innerHTML=control(m);
 document.querySelector(`[data-card="${CSS.escape(id)}"]`)?.classList.toggle('in-cart',!!qtyOf(id));
 const dock=$('#dock');if(!dock)return;
 dock.classList.toggle('has-items',!!count());
 dock.querySelector('.bg-dock-count').textContent=count();
 dock.querySelector('.bg-dock-total').textContent=money(total());
 const railBag=$('.bg-rail-bag');if(railBag)railBag.textContent=`${tr('Bag','السلة')} · ${count()} · ${money(total())}`;
}

function add(id,step=1,options=[],price=null){
 const m=item(id);if(!m)return;
 if(step>0&&qtyOf(id)>=m.stock)return toast('No more portions available.');
 const line=options.length?cart.find(l=>l.id===id&&JSON.stringify(l.options)===JSON.stringify(options)):plain(id);
 if(line){line.qty+=step;if(line.qty<1)cart.splice(cart.indexOf(line),1);}
 else if(step>0)cart.push({id,qty:1,price:price??m.price,options});
 save();sync(id);
}

// ---- sheets -----------------------------------------------------------------
function sheet(title,body){
 $('dialog')?.remove();
 document.body.insertAdjacentHTML('beforeend',`<dialog class="bg-sheet"><div class="bg-sheet-head"><h2>${title}</h2><button type="button" class="bg-btn ghost sm" data-bg="close">${tr('Close','إغلاق')}</button></div><div class="bg-sheet-body">${body}</div></dialog>`);
 const d=$('dialog');d.showModal();d.addEventListener('close',()=>d.remove(),{once:true});
}
const close=()=>{const d=$('dialog');if(d){d.close();d.remove();}};

function product(id){
 const m=item(id);if(!m)return;
 sheet(e(nameOf(m)),`<div class="bg-line-art bg-product-photo" style="width:100%;height:260px">${photo(m)}</div>
  <p class="bg-note">${e(desc(m))}</p>
  <p class="bg-note">${tr('Listed allergens','مسببات الحساسية المذكورة')}: ${e(m.allergens.map(a=>t(a[0].toUpperCase()+a.slice(1))).join('، '))||'—'}. ${tr('Ask staff about cross-contact.','اسأل الفريق عن التلامس المتبادل.')}</p>
  <form data-bg-form="add" data-id="${m.id}">
   ${m.modifiers?.length?`<h3 style="font-size:15px">${tr('Make it yours','خصّصها')}</h3>${m.modifiers.map(x=>`<label class="bg-opt"><input type="checkbox" name="opt" value="${e(x.id)}" ${x.available?'':'disabled'}>${e(nameOf(x))}<b>${x.price?'+ '+money(x.price):tr('Free','مجاناً')}</b></label>`).join('')}`:''}
   <button class="bg-btn" style="width:100%;margin-top:8px" ${!m.available||!m.stock?'disabled':''}>${tr('Add to bag','أضف للسلة')} · <b id="bg-sheet-total">${money(m.price)}</b></button>
  </form>`);
 const type=$('.bg-sheet [name="type"]');if(type){type.value=fulfillment;type.dispatchEvent(new Event('change',{bubbles:true}));}
}

function bag(){
 if(!cart.length)return toast('Your cart is empty.');
 const branch=data.branches.find(b=>b.id===BRANCH);
 sheet(tr('Your bag','سلّتك'),`
  ${cart.map((l,i)=>{const m=item(l.id),opts=(l.options||[]).map(o=>m.modifiers.find(x=>x.id===o)).filter(Boolean);
   return `<div class="bg-line"><div class="bg-line-art">${photo(m)}</div>
    <div class="bg-line-body"><strong>${e(nameOf(m))}</strong>${opts.length?`<small>${opts.map(o=>e(nameOf(o))).join(' · ')}</small>`:''}
     <div class="bg-step" style="margin-top:8px"><button type="button" data-bg="line-minus" data-i="${i}" aria-label="${tr('Remove one','إنقاص واحد')}">−</button><output>${l.qty}</output><button type="button" data-bg="line-plus" data-i="${i}" aria-label="${tr('Add one','إضافة واحد')}">+</button></div></div>
    <span class="bg-line-total">${money(l.price*l.qty)}</span></div>`}).join('')}
  <form data-bg-form="checkout">
   <label>${tr('Name','الاسم')}<input name="name" required maxlength="100" autocomplete="name"></label>
   <label>${tr('Phone','الهاتف')}<input name="contact" type="tel" required maxlength="100"></label>
   <label>${tr('How do you want it?','كيف تريدها؟')}<select name="type">
    ${branch?.pickup?`<option value="pickup" ${fulfillment==='pickup'?'selected':''}>${tr('Pickup','استلام')}</option>`:''}
    ${branch?.delivery&&data.settings.deliveryEnabled?`<option value="delivery" ${fulfillment==='delivery'?'selected':''}>${tr('Delivery','توصيل')}</option>`:''}
   </select></label>
   <div id="bg-delivery" hidden>
    <label>${tr('Area','المنطقة')}<select name="area">${(branch?.deliveryAreas||[]).map(a=>`<option>${e(a)}</option>`).join('')}</select></label>
    <label>${tr('Address','العنوان')}<input name="address" maxlength="500"></label>
   </div>
   <label>${tr('Notes for the kitchen','ملاحظات للمطبخ')}<textarea name="notes" maxlength="500" rows="2"></textarea></label>
   <div class="bg-totals">
    <div class="bg-total-row"><span>${tr('Subtotal','المجموع الفرعي')}</span><span>${money(total())}</span></div>
    <div class="bg-total-row" id="bg-fee" hidden><span>${tr('Delivery','التوصيل')}</span><span>${money(data.settings.deliveryFee)}</span></div>
    <div class="bg-total-row grand"><span>${tr('Total','الإجمالي')}</span><span id="bg-grand">${money(total())}</span></div>
   </div>
   <button class="bg-btn" style="width:100%">${tr('Place order','تأكيد الطلب')}</button>
   <p class="bg-note">${tr('Test mode. No real money is charged.','وضع تجريبي. لا يتم خصم أموال حقيقية.')}</p>
  </form>`);
}

const STAGES=['received','preparing','ready'];
// Poll the guest's own visit so the ticket tracks the real kitchen board.
let watching=null;
function watchOrder(){
 clearInterval(watching);
 watching=setInterval(async()=>{
  if(!placed||document.hidden)return;
  try{const visit=await api('visit',null,placed.token);
   const order=visit.orders.find(o=>o.id===placed.orderId);
   if(!order||order.status===placed.status)return;
   placed.status=order.status;confirmation();
   if(['served','picked_up','delivered','cancelled'].includes(order.status))clearInterval(watching);
  }catch{}
 },4000);
}
function confirmation(){
 $('#app').innerHTML=`<div class="bg-app"><header class="bg-head"><a class="bg-logo" href="/burger"><i>S</i>Smash &amp; Co</a><nav>${switcher()}</nav></header>
  <div class="bg-done"><div class="bg-ticket">
   <h2>${tr('Order in the pass','طلبك في الطريق')}</h2>
   <div class="bg-ticket-num">#${String(placed.number).padStart(3,'0')}</div>
   <p>${tr('Show this number at the counter. We will call it when the bag is up.','اعرض هذا الرقم على الكاونتر. سنناديه فور جهوز الطلب.')}</p>
   <div class="bg-steps">${STAGES.map((st,i)=>`<span class="${STAGES.indexOf(placed.status)>=i||!STAGES.includes(placed.status)?'on':''}"></span>`).join('')}</div>
   <p style="font-size:12.5px;font-weight:700">${({received:tr('Received','تم الاستلام'),preparing:tr('In the kitchen','في المطبخ'),ready:tr('Ready for pickup','جاهز للاستلام'),picked_up:tr('Picked up','تم الاستلام'),out_for_delivery:tr('On the way','في الطريق'),delivered:tr('Delivered','تم التوصيل'),served:tr('Served','تم التقديم'),cancelled:tr('Cancelled','ملغي')})[placed.status]||placed.status}</p>
   <p style="font-weight:800;font-size:17px;color:#14100d">${money(placed.total)}</p>
  </div>
  <button type="button" class="bg-btn ghost" style="margin-top:22px" data-bg="again">${tr('Order something else','اطلب شيئاً آخر')}</button></div></div>`;
}

// ---- events -----------------------------------------------------------------
document.addEventListener('click',async ev=>{
 const el=ev.target.closest('[data-bg]');if(!el||el.disabled)return;
 const a=el.dataset.bg;
 try{
  if(a==='close')return close();
  if(a==='mode'){fulfillment=el.dataset.mode;page();return}
  if(a==='cat'){category=el.dataset.cat;page();return}
  if(a==='jump')return document.getElementById('order')?.scrollIntoView({behavior:'smooth',block:'start'});
  if(a==='add'||a==='plus')return add(el.dataset.id,1);
  if(a==='minus')return add(el.dataset.id,-1);
  if(a==='open')return product(el.dataset.id);
  if(a==='bag')return bag();
  if(a==='again'){placed=null;page();return}
  if(a==='line-minus'||a==='line-plus'){
   const i=Number(el.dataset.i),line=cart[i];if(!line)return;
   if(a==='line-plus'&&qtyOf(line.id)>=item(line.id).stock)return toast('No more portions available.');
   line.qty+=a==='line-plus'?1:-1;if(line.qty<1)cart.splice(i,1);
   save();sync(line.id);close();return bag();
  }
 }catch(err){toast(err.message)}
});

document.addEventListener('change',ev=>{
 if(ev.target.name==='opt'){
  const form=ev.target.closest('[data-bg-form="add"]'),m=item(form.dataset.id);
  const picked=[...form.querySelectorAll('[name="opt"]:checked')].map(x=>x.value);
  $('#bg-sheet-total').textContent=money(m.price+m.modifiers.filter(x=>picked.includes(x.id)).reduce((n,x)=>n+x.price,0));
 }
 if(ev.target.name==='type'){
  const delivery=ev.target.value==='delivery';
  $('#bg-delivery').hidden=!delivery;$('[name="address"]').required=delivery;
  $('#bg-fee').hidden=!delivery;
  $('#bg-grand').textContent=money(total()+(delivery?data.settings.deliveryFee:0));
 }
});

document.addEventListener('submit',async ev=>{
 const form=ev.target.closest('[data-bg-form]');if(!form)return;
 ev.preventDefault();if(busy)return;
 const kind=form.dataset.bgForm,b=Object.fromEntries(new FormData(form));
 try{
  if(kind==='add'){
   const m=item(form.dataset.id),picked=[...form.querySelectorAll('[name="opt"]:checked')].map(x=>x.value);
   add(m.id,1,picked,m.price+m.modifiers.filter(x=>picked.includes(x.id)).reduce((n,x)=>n+x.price,0));
   close();toast('Added to your order. Confirm when you are ready.');return;
  }
  if(kind==='checkout'){
   busy=true;
   const payload={branchId:BRANCH,type:b.type,name:b.name,contact:b.contact,payment:'demo',
    notes:b.notes||'',...(b.type==='delivery'?{area:b.area,address:b.address}:{}),
    lines:cart.map(l=>({id:l.id,qty:l.qty,options:l.options,price:l.price}))};
   const result=await api('online-order',{...payload,key:key()});
   // The order number and total come from the visit the server just created,
   // never from anything counted on this page.
   const visit=await api('visit',null,result.token);
   const order=visit.orders.find(o=>o.id===result.orderId)||visit.orders[0];
   placed={token:result.token,orderId:order?.id,number:order?.number||0,total:visit.bill.total,status:order?.status||'received'};
   cart=[];save();close();confirmation();watchOrder();
  }
 }catch(err){toast(err.message)}finally{busy=false}
});

// ---- boot -------------------------------------------------------------------
$('#app').innerHTML=`<div class="bg-app" style="display:grid;place-content:center;min-height:100vh"><p style="color:#a8998a">${t('Loading…')}</p></div>`;
try{
 data=await api('public');
 menu=data.menu.filter(m=>m.branchIds?.includes(BRANCH)&&m.available);
 // Drop cart lines that no longer exist, so a stale bag cannot block checkout.
 cart=cart.filter(l=>menu.some(m=>m.id===l.id));save();
 if(!menu.length)throw Error(tr('This kitchen is not serving right now.','هذا المطبخ لا يقدم الطلبات حالياً.'));
 page();
}catch(err){
 $('#app').innerHTML=`<div class="bg-app" style="display:grid;place-content:center;min-height:100vh;text-align:center;padding:24px">
  <h1 style="font-size:26px">${tr('We could not load the menu','تعذّر تحميل القائمة')}</h1>
  <p style="color:#a8998a">${e(err.message)}</p><a class="bg-btn" style="margin-top:18px" href="/burger">${tr('Try again','حاول مرة أخرى')}</a></div>`;
}

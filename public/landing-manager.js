/* Landing page · manager view.
   An analytics board, readable at a glance: the four figures the manager
   overview reports (today's revenue, orders, active tables, guest
   satisfaction), revenue through the evening, rating averages, station load
   and the two kinds of alert the AI manager raises (low stock, kitchen load).
   One sample state drives every number; a payment lands every few seconds so
   the board is visibly live. Nothing is read from real data. */
import {createStage} from './landing-stage.js';

const HOURS=[['1 PM',62000],['2 PM',118000],['3 PM',74000],['4 PM',41000],['5 PM',56000],['6 PM',143000],['7 PM',236000],['8 PM',291500],['9 PM',214000]];
const START={orders:37,tables:6,ratings:[4.7,4.6,4.3,4.5],count:21,
 load:[['Grill',5],['Hot kitchen',3],['Cold kitchen',2],['Bar',2],['Pastry',1]],
 stock:[['Burrata & heirloom tomato',5],['Chocolate fondant',4]]};
const PAYMENTS=[43000,28500,61000,14500,35500,52000];
const TRENDS={revenue:[12,22,28,31,36,49,70,96,100],orders:[3,7,10,12,15,20,27,34,37],tables:[2,5,4,2,3,6,9,8,6],rating:[4.4,4.5,4.5,4.6,4.5,4.6,4.6,4.7,4.6]};
const RATED=['Food','Service','Speed','Value'];

const spark=v=>{
 const max=Math.max(...v),min=Math.min(...v);
 const pts=v.map((y,i)=>`${(i/(v.length-1)*100).toFixed(1)},${(28-(y-min)/(max-min||1)*24).toFixed(1)}`).join(' ');
 return `<svg class="mgr-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,30 ${pts} 100,30"/><polyline points="${pts}"/></svg>`;
};

export function managerSection({t,arrow}){
 return `<section class="lp-ops" id="operations">
 <div class="lp-shell">
  <div class="lp-head-row is-light" data-reveal>
   <div><span class="lp-chapter-tag is-dark">${t('Manager view')}</span><h2>${t('The numbers move when the room does.')}</h2></div>
   <p>${t('Revenue, orders, ratings and kitchen load in one place, updating as tables order and pay. The AI manager points at what needs attention.')}</p>
  </div>
  <div class="mgr" id="mgr" data-reveal>
   <div class="mgr-tiles" id="mgr-tiles"></div>
   <div class="mgr-grid">
    <article class="mgr-panel mgr-chart">
     <header><h3>${t('Revenue today')}</h3><small>${t('By hour')}</small></header>
     <div class="mgr-bars" id="mgr-bars"></div>
    </article>
    <div class="mgr-stack">
     <article class="mgr-panel"><header><h3>${t('Guest ratings')}</h3><small id="mgr-rated"></small></header><ul class="mgr-meter" id="mgr-ratings"></ul></article>
     <article class="mgr-panel"><header><h3>${t('Station load')}</h3><small>${t('Portions queued')}</small></header><ul class="mgr-meter" id="mgr-load"></ul></article>
    </div>
    <article class="mgr-panel mgr-ai">
     <header><h3><span aria-hidden="true">✦</span> ${t('AI manager')}</h3><small>${t('Watching service')}</small></header>
     <ol class="mgr-cards" id="mgr-cards"></ol>
    </article>
   </div>
   <footer class="mgr-foot"><span>${t('Sample data, drawn as charts for this page. The AI manager raises low-stock and kitchen-load alerts; without a model key it uses built-in rules.')}</span><a class="lp-inline is-dark" href="/manager">${t('Open the manager screen')} ${arrow}</a></footer>
  </div>
 </div>
</section>`;
}

export function mountManager(root,{t,num,money,reduced}){
 const $=s=>root.querySelector(s),box=$('#mgr');
 const fmt=new Intl.NumberFormat(document.documentElement.lang==='ar'?'ar-EG':'en-US',{minimumFractionDigits:1,maximumFractionDigits:1});
 let s,hours,tick=0;
 const reset=()=>{s=JSON.parse(JSON.stringify(START));hours=HOURS.map(h=>[...h]);tick=0};
 const revenue=()=>hours.reduce((n,h)=>n+h[1],0);
 const rating=()=>s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length;

 function tiles(bump=[]){
  const data=[['revenue','Today’s revenue',money(revenue())],['orders','Orders today',num(s.orders)],['tables','Active tables',num(s.tables)],['rating','Guest satisfaction',fmt.format(rating())+' ★']];
  $('#mgr-tiles').innerHTML=data.map(([id,label,value])=>`<article class="${bump.includes(id)?'is-bump':''}"><small>${t(label)}</small><strong><bdi>${value}</bdi></strong>${spark(TRENDS[id])}</article>`).join('');
 }
 function bars(live){
  const max=Math.max(...hours.map(h=>h[1]))*1.08;
  $('#mgr-bars').innerHTML=hours.map(([label,v],i)=>`<div class="${i===hours.length-1?'is-now':''}${live&&i===hours.length-1?' is-bump':''}"><i style="height:${(v/max*100).toFixed(1)}%"></i><small>${t(label)}</small></div>`).join('');
 }
 function meters(){
  $('#mgr-rated').textContent=`${num(s.count)} ${t('ratings')}`;
  $('#mgr-ratings').innerHTML=RATED.map((name,i)=>`<li><span>${t(name)}</span><i><u style="transform:scaleX(${s.ratings[i]/5})"></u></i><b>${fmt.format(s.ratings[i])}</b></li>`).join('');
  const max=Math.max(6,...s.load.map(l=>l[1]));
  $('#mgr-load').innerHTML=s.load.map(([name,n])=>`<li><span>${t(name)}</span><i><u style="transform:scaleX(${n/max})"></u></i><b>${num(n)}</b></li>`).join('');
 }
 // The same two rules the app builds its cards from.
 function cards(){
  const [name,n]=[...s.load].sort((a,b)=>b[1]-a[1])[0];
  const list=[...s.stock.map(([item,left])=>['Low stock',t(item),`${num(left)} ${t('portions left')}`]),['Kitchen load',t(name),`${num(n)} ${t('portions queued')}`]];
  $('#mgr-cards').innerHTML=list.map(([kind,title,detail],i)=>`<li style="--i:${i}"><small>${t(kind)}</small><strong>${title}</strong><p>${detail}</p></li>`).join('');
 }
 function render(){tiles();bars();meters();cards()}
 // A table pays: revenue, the order count and the current hour all move together.
 function payment(){
  hours[hours.length-1][1]+=PAYMENTS[tick%PAYMENTS.length];
  s.orders++;
  const grill=s.load[0];grill[1]=4+(tick%3);
  tick++;
  tiles(['revenue','orders']);bars(true);meters();
 }
 reset();render();
 if(reduced)return;
 const stage=createStage(box);
 stage.whenVisible(()=>{
  box.classList.add('is-live');
  stage.loop(async c=>{
   for(let i=0;i<PAYMENTS.length;i++){await c.wait(2600);payment()}
  },{hold:2600,rewind:async c=>{
   box.classList.add('is-swap');
   await c.wait(360);
   reset();render();
   box.classList.remove('is-swap');
  }});
 });
}

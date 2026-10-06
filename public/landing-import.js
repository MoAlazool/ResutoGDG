/* Landing page · menu import demo.
   Source menu → extraction → structured draft → human review, played from one
   sample dataset (landing-import-data.js). Nothing here talks to the server:
   no file is uploaded, no camera is opened and nothing is published. */
import data from './landing-import-data.js';
import {createStage,createCursor,quadMatrix,EASE} from './landing-stage.js';

const PREVIEW=5;
const dishes=data.dishes;
const flagged=dishes.find(d=>d.was);
const SOURCES=[
 {id:'pdf',label:'PDF menu',file:'olive-room-menu.pdf',kind:'PDF'},
 {id:'photo',label:'Menu photo'},
 {id:'csv',label:'CSV file',file:'olive-room-menu.csv',kind:'CSV'}
];
const STEPS=['Source','Read','Review','Ready'];
const CSV_COLUMNS=[['name','name'],['nameAr','nameAr'],['category','category'],['price','price_egp']];
const egp=p=>String(p/100);
const csvCell=(d,f)=>f==='price'?(d.was?`${egp(d.was)} / ${egp(d.price)}`:egp(d.price)):d[f];

export function importSection({t,money,rtl,e}){
 const row=(d,i)=>`<li class="imp-row${i>=PREVIEW?' is-extra':''}" data-dish="${d.id}">
  <div class="imp-row-main">
   <span class="imp-name">${rtl
    ?`<b lang="ar" data-f="nameAr">${e(d.nameAr)}</b><small lang="en" dir="ltr" data-f="name">${e(d.name)}</small>`
    :`<b data-f="name">${e(d.name)}</b><small lang="ar" dir="rtl" data-f="nameAr">${e(d.nameAr)}</small>`}</span>
   <span class="imp-cat" data-f="category">${t(d.category)}</span>
   <span class="imp-price" data-f="price"><bdi>${money(d.price)}</bdi></span>
   <span class="imp-status" data-f="status">${t('Review')}</span>
  </div>
  ${d===flagged?`<div class="imp-check" id="imp-check"><div class="imp-check-in">
   <div class="imp-check-src" aria-hidden="true"></div>
   <div class="imp-check-body">
    <strong>${t('Two prices in the source')}</strong>
    <p>${t('Which one is current?')}</p>
    <div class="imp-check-actions">${[d.was,d.price].map(p=>`<button type="button" data-imp="price" data-arg="${p}"><bdi>${money(p)}</bdi></button>`).join('')}</div>
   </div>
  </div></div>`:''}
 </li>`;
 return `<section class="lp-chapter lp-import" id="import">
 <div class="lp-shell">
  <div class="lp-head-row" data-reveal>
   <div><span class="lp-chapter-tag">${t('Menu import')}</span><h2>${t('Your menu, wherever it lives now.')}</h2></div>
   <p>${t('Upload a PDF, a photo or a CSV. Resuto reads the dishes and prices into a bilingual draft, and you review every field before anything is published.')}</p>
  </div>
  <div class="imp" id="imp" data-source="pdf" data-step="0" data-reveal>
   <div class="imp-stage">
    <div class="imp-desk" aria-hidden="true">
     <div class="imp-drop"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14"/></svg><b>${t('Drop your menu here')}</b><small>${t('PDF, photo or CSV')}</small></div>
     <div class="imp-file"><i></i><span><b class="imp-file-name"></b><small>${t('1 page')}</small></span></div>
     <div class="imp-cam">
      <img class="imp-cam-photo" src="/assets/menu-sample-photo.webp" alt="" width="${data.photo.w}" height="${data.photo.h}" loading="lazy" decoding="async">
      <svg class="imp-crop" viewBox="0 0 100 100" preserveAspectRatio="none"><path class="imp-crop-dim" fill-rule="evenodd"/><polygon class="imp-crop-line"/></svg>
      <div class="imp-crop-handles"><i></i><i></i><i></i><i></i></div>
      <div class="imp-cam-ui"><span class="imp-cam-mode">${t('Photo')}</span><i class="imp-cam-focus"></i><b class="imp-cam-shutter"></b></div>
      <div class="imp-cam-flash"></div>
     </div>
     <div class="imp-sheet"><div class="imp-sheet-body"></div><div class="imp-marks"></div></div>
    </div>
    <div class="imp-draft">
     <header><span class="imp-draft-title">${t('Menu draft')}</span><span class="imp-draft-state" id="imp-state">${t('Waiting for a menu')}</span></header>
     <ol class="imp-rows">${dishes.map(row).join('')}</ol>
     <footer>
      <p class="imp-count" id="imp-count"></p>
      <button type="button" class="imp-more" data-imp="more" aria-expanded="false" hidden></button>
      <p class="imp-note">${t('Allergens are not stated in this source, so they are left empty for you to add.')}</p>
     </footer>
    </div>
    <svg class="imp-threads" aria-hidden="true"></svg>
   </div>
   <div class="imp-rail">
    <div class="imp-tabs" role="group" aria-label="${t('Menu source')}">${SOURCES.map((s,i)=>`<button type="button" data-imp="source" data-arg="${s.id}" aria-pressed="${!i}">${t(s.label)}</button>`).join('')}</div>
    <ol class="imp-steps" aria-hidden="true">${STEPS.map(s=>`<li>${t(s)}</li>`).join('')}</ol>
    <span class="imp-sample">${t('Sample data')}</span>
    <div class="imp-ctls">
     <button type="button" class="imp-ctl" data-imp="toggle"></button>
     <button type="button" class="imp-ctl" data-imp="replay">${t('Restart')}</button>
    </div>
   </div>
  </div>
 </div>
</section>`;
}

export function mountImport(root,{t,money,num,reduced}){
 const $=s=>root.querySelector(s),$$=s=>[...root.querySelectorAll(s)];
 const box=$('#imp'),stageEl=$('.imp-stage'),desk=$('.imp-desk'),drop=$('.imp-drop'),file=$('.imp-file');
 const cam=$('.imp-cam'),photo=$('.imp-cam-photo'),flash=$('.imp-cam-flash'),shutter=$('.imp-cam-shutter');
 const cropLine=$('.imp-crop-line'),cropDim=$('.imp-crop-dim'),handles=$$('.imp-crop-handles i');
 const sheet=$('.imp-sheet'),sheetBody=$('.imp-sheet-body'),marks=$('.imp-marks'),threads=$('.imp-threads');
 const draft=$('.imp-draft'),check=$('#imp-check'),toggleBtn=$('[data-imp="toggle"]'),moreBtn=$('[data-imp="more"]');
 const rowOf=d=>$(`.imp-row[data-dish="${d.id}"]`);
 const fieldOf=(d,f)=>rowOf(d).querySelector(`[data-f="${f}"]`);
 const stacked=()=>matchMedia('(max-width:860px)').matches;
 const cursor=createCursor(stageEl);
 const stage=createStage(box,{reduced,onChange:controls});
 let source='pdf',read=0,choice=null;

 function controls(){
  toggleBtn.textContent=stage.paused||stage.finished?t('Play'):t('Pause');
 }
 const setStep=n=>{box.dataset.step=n;$$('.imp-steps li').forEach((li,i)=>li.className=i<n?'is-done':i===n?'is-on':'')};
 const say=text=>$('#imp-state').textContent=text;
 function count(){
  const approved=choice?1:0;
  $('#imp-count').textContent=read?`${num(approved)} ${t('approved')} · ${num(read-approved)} ${t('to review')} · ${num(0)} ${t('published')}`:'';
  moreBtn.hidden=read<dishes.length;
  const open=box.classList.contains('is-all');
  moreBtn.textContent=open?t('Show fewer'):`${t('Show all items')} (${num(dishes.length)})`;
  moreBtn.setAttribute('aria-expanded',String(open));
 }

 /* ------------------------------------------------------------ source */
 const sheetImage=()=>source==='photo'?'/assets/menu-sample-scan.webp':'/assets/menu-sample-page.webp';
 function fillSheet(){
  sheetBody.innerHTML=source==='csv'
   ?`<table class="imp-csv"><thead><tr><th></th>${CSV_COLUMNS.map(([,head])=>`<th>${head}</th>`).join('')}</tr></thead><tbody>${dishes.map((d,i)=>`<tr><th>${i+2}</th>${CSV_COLUMNS.map(([f])=>`<td data-r="${d.id}" data-c="${f}"${f==='nameAr'?' lang="ar" dir="rtl"':''}>${csvCell(d,f)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
   :`<img src="${sheetImage()}" alt="" width="${data.page.w}" height="${data.page.h}" decoding="async">`;
 }
 // Where a field sits on the source, as fractions of the sheet.
 function region(d,f){
  if(source!=='csv'){
   const [x,y,w,h]=f==='category'?data.categories[d.category]:d.regions[f];
   return [x-.012,y-.005,w+.024,h+.01];
  }
  const s=sheet.getBoundingClientRect(),c=sheet.querySelector(`[data-r="${d.id}"][data-c="${f}"]`).getBoundingClientRect();
  return [(c.left-s.left)/s.width,(c.top-s.top)/s.height,c.width/s.width,c.height/s.height];
 }
 function mark(d,f,cls=''){
  const [x,y,w,h]=region(d,f),el=document.createElement('i');
  el.className=`imp-mark ${cls}`;
  el.style.cssText=`left:${x*100}%;top:${y*100}%;width:${w*100}%;height:${h*100}%`;
  marks.append(el);
  return el;
 }
 // On a phone the page is larger than its window, so it follows the line being read.
 function panFor(d,f){
  if(!stacked()||source==='csv')return 0;
  const [,y,,h]=region(d,f),room=desk.clientHeight;
  const centre=sheet.offsetTop+(y+h/2)*sheet.offsetHeight;
  // Leave the page alone while the line is comfortably in view.
  if(centre+panY>room*.2&&centre+panY<room*.74)return panY;
  return Math.round(Math.min(0,Math.max(room-sheet.offsetHeight-sheet.offsetTop-14,room*.34-centre)));
 }
 const rest=y=>`matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,${y},0,1)`;
 let panY=0;
 async function pan(c,d,f){
  const y=panFor(d,f);
  if(y===panY)return;
  panY=y;
  await c.to(sheet,{transform:rest(y)},460,{ease:EASE.move});
 }

 /* ------------------------------------------------------------- draft */
 const show=(d,f)=>fieldOf(d,f).classList.add('is-in');
 function fillRow(d){
  rowOf(d).classList.add('is-read');
  ['name','nameAr','category','price','status'].forEach(f=>show(d,f));
 }
 function flag(){
  rowOf(flagged).classList.add('is-flagged');
  fieldOf(flagged,'status').textContent=t('Check price');
 }
 function openCheck(){
  const src=check.querySelector('.imp-check-src');
  if(source==='csv'){
   src.style.cssText='';
   src.innerHTML=`<span class="imp-check-cell"><small>price_egp</small>${csvCell(flagged,'price')}</span>`;
  }else{
   // The same pixels the reader saw, enlarged.
   const [x,y,w,h]=flagged.regions.price,pad=.035,width=(src.clientWidth||132)/(w+pad*2);
   src.innerHTML='';
   src.style.cssText=`background-image:url(${sheetImage()});background-size:${width}px auto;background-position:${-(x-pad)*width}px ${-((y+h/2)*width*data.page.h/data.page.w-22)}px`;
  }
  check.classList.add('is-open');
 }
 function choose(price){
  choice=price;
  const row=rowOf(flagged);
  row.classList.remove('is-flagged');
  row.classList.add('is-approved');
  fieldOf(flagged,'price').innerHTML=`<bdi>${money(price)}</bdi>`;
  fieldOf(flagged,'status').textContent=t('Approved');
  check.classList.remove('is-open');
  marks.querySelector('.is-warn')?.classList.remove('is-warn','is-focus');
  count();
  if(read===dishes.length)ready();
 }
 function ready(){
  setStep(3);
  say(t('Draft ready. Nothing has been published.'));
 }

 /* ----------------------------------------------------------- threads */
 // Threads end at the edge of the row, so they never run across its text;
 // `lane` keeps the name and price lines apart.
 async function thread(c,from,row,lane,ms){
  const s=stageEl.getBoundingClientRect(),a=from.getBoundingClientRect(),b=row.getBoundingClientRect();
  let d,x2,y2;
  if(stacked()){
   const x1=a.left+a.width/2-s.left,y1=a.bottom-s.top;
   const top=draft.getBoundingClientRect();
   x2=top.left+top.width*(lane<.5?.22:.78)-s.left;y2=top.top-s.top;
   const k=(y2-y1)*.5;
   d=`M${x1} ${y1}C${x1} ${y1+k} ${x2} ${y2-k} ${x2} ${y2}`;
  }else{
   const ltr=b.left>a.left,x1=(ltr?a.right:a.left)-s.left,y1=a.top+a.height/2-s.top;
   x2=(ltr?b.left:b.right)-s.left;y2=b.top+b.height*lane-s.top;
   const k=(x2-x1)*.5;
   d=`M${x1} ${y1}C${x1+k} ${y1} ${x2-k} ${y2} ${x2} ${y2}`;
  }
  const g=document.createElementNS('http://www.w3.org/2000/svg','g');
  g.innerHTML=`<path class="imp-thread" pathLength="1" d="${d}"/><circle class="imp-thread-end" cx="${x2}" cy="${y2}" r="4"/>`;
  threads.append(g);
  await c.to(g.firstChild,{strokeDashoffset:0},ms,{ease:EASE.move});
  g.lastChild.classList.add('is-in');
  c.fork(c.to(g,{opacity:0},600,{delay:260}).then(()=>g.remove()));
 }

 /* ------------------------------------------------------------- reset */
 function reset(){
  box.dataset.source=source;
  box.classList.remove('is-all','is-static');
  $$('.imp-tabs button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.arg===source)));
  [drop,file,cam,photo,flash,sheet,cursor.el].forEach(el=>el.removeAttribute('style'));
  box.classList.remove('is-swap');
  drop.classList.remove('is-over');
  file.classList.remove('is-held');
  cam.classList.remove('is-shot','is-cropping');
  marks.innerHTML='';threads.innerHTML='';
  const src=SOURCES.find(s=>s.id===source);
  file.dataset.kind=src.kind||'';
  $('.imp-file-name').textContent=src.file||'';
  fillSheet();
  $$('.imp-row').forEach(r=>r.classList.remove('is-read','is-flagged','is-approved'));
  $$('.imp-row [data-f]').forEach(f=>f.classList.remove('is-in','is-new'));
  $$('.imp-status').forEach(s=>s.textContent=t('Review'));
  fieldOf(flagged,'price').innerHTML=`<bdi>${money(flagged.price)}</bdi>`;
  check.classList.remove('is-open');
  read=0;choice=null;panY=0;
  setStep(0);say(t('Waiting for a menu'));count();
 }

 /* ----------------------------------------------------------- scenes */
 const centre=el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}};
 async function dropFile(c){
  cursor.set(desk,.8,.92);
  await c.wait(200);
  await cursor.show(c);
  await cursor.move(c,file,480,.3,.55);
  await cursor.press(c);
  file.classList.add('is-held');
  const a=centre(file),b=centre(drop),dx=b.x-a.x,dy=b.y-a.y;
  await Promise.all([
   cursor.move(c,{x:cursor.point(file,.3,.55).x+dx,y:cursor.point(file,.3,.55).y+dy},700),
   c.to(file,{transform:`translate(${dx}px,${dy}px) rotate(-3deg)`},700,{ease:EASE.move}),
   c.wait(380).then(()=>drop.classList.add('is-over'))
  ]);
  await c.wait(180);
  file.classList.remove('is-held');
  await Promise.all([
   c.to(file,{opacity:0,transform:`translate(${dx}px,${dy}px) scale(.82)`},220),
   c.to(drop,{opacity:0,transform:'scale(1.06)'},300)
  ]);
  const w=sheet.offsetWidth,h=sheet.offsetHeight;
  panY=0;
  sheet.style.transform=`translate(${w*.04}px,${panY+h*.04+26}px) scale(.92)`;
  await Promise.all([
   c.to(sheet,{opacity:1,transform:rest(panY)},580,{ease:EASE.move}),
   cursor.hide(c,300)
  ]);
 }
 function drawCrop(points){
  const p=points.map(([x,y])=>`${x*100},${y*100}`);
  cropLine.setAttribute('points',p.join(' '));
  cropDim.setAttribute('d',`M0 0H100V100H0ZM${p.join('L')}Z`);
  handles.forEach((el,i)=>{el.style.left=points[i][0]*100+'%';el.style.top=points[i][1]*100+'%'});
 }
 async function capture(c){
  const frame=[[.04,.03],[.96,.03],[.96,.97],[.04,.97]],quad=data.photo.quad;
  drawCrop(frame);
  photo.style.transform='scale(1.14) translate(2.5%,-2%)';
  await c.wait(200);
  await Promise.all([c.to(cam,{opacity:1},320),c.to(photo,{transform:'scale(1) translate(0,0)'},820,{ease:EASE.move})]);
  cursor.set(cam,.85,.8);
  await cursor.show(c,160);
  await cursor.move(c,shutter,420);
  await cursor.press(c);
  await c.to(flash,{opacity:.92},70);
  cam.classList.add('is-shot');
  await Promise.all([c.to(flash,{opacity:0},340),cursor.hide(c,240)]);
  cam.classList.add('is-cropping');
  await c.wait(160);
  await c.tween(600,p=>drawCrop(frame.map(([x,y],i)=>[x+(quad[i][0]-x)*p,y+(quad[i][1]-y)*p])));
  await c.wait(240);
  // Lift the page out of the photograph and straighten it.
  panY=0;
  const s={x:desk.getBoundingClientRect().left+sheet.offsetLeft,y:desk.getBoundingClientRect().top+sheet.offsetTop},p=photo.getBoundingClientRect();
  sheet.style.transform=quadMatrix(sheet.offsetWidth,sheet.offsetHeight,quad.map(([x,y])=>[p.left+x*p.width-s.x,p.top+y*p.height-s.y]));
  await c.to(sheet,{opacity:1},160);
  await Promise.all([
   c.to(sheet,{transform:rest(panY)},740,{ease:EASE.move}),
   c.to(cam,{opacity:0},380,{delay:140})
  ]);
 }
 async function extract(c){
  setStep(1);say(t('Reading the menu…'));
  let category='';
  for(let i=0;i<PREVIEW;i++){
   const d=dishes[i],pace=[1,.66,.5,.42,.4][i],row=rowOf(d),warn=d===flagged?'is-warn':'';
   await pan(c,d,'name');
   if(source!=='csv'&&d.category!==category){category=d.category;mark(d,'category','is-cat');await c.wait(260*pace)}
   const name=mark(d,'name');
   await c.wait(200*pace);
   await thread(c,name,row.firstElementChild,.36,Math.max(240,420*pace));
   row.classList.add('is-read');
   show(d,'name');row.querySelector('.imp-name b').classList.add('is-new');
   mark(d,'nameAr');
   await c.wait(160*pace);
   show(d,'nameAr');
   if(source==='csv')mark(d,'category','is-cat');
   const price=mark(d,'price',warn);
   await c.wait(200*pace);
   await thread(c,price,row.firstElementChild,.66,Math.max(240,400*pace));
   show(d,'category');show(d,'price');fieldOf(d,'price').classList.add('is-new');
   if(warn)flag();
   await c.wait(140*pace);
   show(d,'status');
   read=i+1;count();
   await c.wait(120*pace);
  }
  for(const d of dishes.slice(PREVIEW)){
   mark(d,'name');mark(d,'price');fillRow(d);
   read++;count();
   await c.wait(90);
  }
 }
 async function review(c){
  // The visitor may already have answered while the menu was being read.
  if(choice)return ready();
  setStep(2);say(t('One field needs you'));
  await c.wait(250);
  await pan(c,flagged,'price');
  marks.querySelector('.is-warn')?.classList.add('is-focus');
  openCheck();
  await c.wait(850);
  if(choice)return;
  const yes=check.querySelector(`[data-arg="${flagged.price}"]`);
  cursor.set(check,.5,1.5);
  await cursor.show(c);
  await cursor.move(c,yes,560,.5,.6);
  await c.wait(160);
  yes.classList.add('is-down');
  await cursor.press(c);
  yes.classList.remove('is-down');
  if(!choice)choose(flagged.price);
  await c.wait(420);
  await cursor.hide(c);
 }
 // Autoplay: one source after another, with a soft change-over between them.
 function start(){
  reset();
  stage.loop(async c=>{
   await (source==='photo'?capture(c):dropFile(c));
   await c.wait(300);
   await extract(c);
   await review(c);
  },{hold:2400,rewind:async c=>{
   box.classList.add('is-swap');
   await c.wait(380);
   source=SOURCES[(SOURCES.findIndex(s=>s.id===source)+1)%SOURCES.length].id;
   reset();
   box.classList.remove('is-swap');
   await c.wait(120);
  }});
 }
 // Reduced motion: no playback. The draft is ready for review, with the open question still open.
 function still(){
  stage.stop();
  reset();
  box.classList.add('is-static');
  [drop,file,cam].forEach(el=>el.style.display='none');
  sheet.style.opacity=1;
  dishes.forEach(d=>{
   if(source!=='csv'&&d===dishes.find(x=>x.category===d.category))mark(d,'category','is-cat');
   mark(d,'name');mark(d,'price',d===flagged?'is-warn is-focus':'');
   fillRow(d);
  });
  read=dishes.length;
  flag();openCheck();
  setStep(2);say(t('Draft ready for review'));count();
 }
 const begin=()=>reduced?still():start();

 box.addEventListener('click',ev=>{
  const el=ev.target.closest('[data-imp]');
  if(!el)return;
  switch(el.dataset.imp){
   case 'source':source=el.dataset.arg;return begin();
   case 'replay':return begin();
   case 'toggle':return stage.finished?begin():stage.toggle();
   // Answering it yourself ends the autoplay; Play starts it again.
   case 'price':if(ev.isTrusted&&!reduced){stage.stop();cursor.el.style.opacity=0}return choose(Number(el.dataset.arg));
   case 'more':box.classList.toggle('is-all');return count();
  }
 });
 reset();controls();
 if(reduced)still();else stage.whenVisible(start);
}

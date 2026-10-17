/* A small director for the landing page's scripted product demos.
   A demo is an async script of waits and Web Animations. The stage owns the
   clock, so one script can be paused, cancelled, replayed, and held while it
   is offscreen or the tab is hidden. */

// Spatial moves get the long, soft curve; state changes get the short one.
export const EASE={move:'cubic-bezier(.32,.72,0,1)',state:'cubic-bezier(.25,1,.5,1)'};
const CANCELLED=Symbol('cancelled');

export function createStage(root,{reduced=false,onChange=()=>{}}={}){
 let run=0,userPaused=false,visible=false,started=false,finished=false,autoStart=null;
 const live=new Set();
 const held=()=>userPaused||!visible||document.hidden;
 const notify=()=>onChange({paused:userPaused,finished,started});
 // Everything in the stage freezes together: scripted moves and CSS transitions alike.
 function sync(){
  for(const a of new Set([...live,...root.getAnimations({subtree:true})])){
   if(held())a.pause();
   else if(a.playState==='paused')a.play();
  }
 }
 function context(id){
  const alive=()=>{if(id!==run)throw CANCELLED};
  // Time only passes while the stage is playing.
  const wait=ms=>new Promise((resolve,reject)=>{
   let left=ms,last=performance.now();
   const tick=now=>{
    if(id!==run)return reject(CANCELLED);
    if(!held())left-=now-last;
    last=now;
    left<=0?resolve():requestAnimationFrame(tick);
   };
   requestAnimationFrame(tick);
  });
  // Animate from wherever the element is to `props`, then keep them as inline style.
  async function to(el,props,ms=300,{ease=EASE.state,delay=0}={}){
   alive();
   const a=el.animate([props],{duration:ms,delay,easing:ease,fill:'forwards'});
   live.add(a);
   if(held())a.pause();
   try{await a.finished}catch{live.delete(a);throw CANCELLED}
   live.delete(a);
   Object.assign(el.style,props);
   a.cancel();
   alive();
  }
  // A value tween for things CSS cannot interpolate, such as SVG points.
  async function tween(ms,draw,ease=x=>1-Math.pow(1-x,3)){
   let spent=0,last=performance.now();
   draw(0);
   while(spent<ms){
    await new Promise(r=>requestAnimationFrame(r));
    alive();
    const now=performance.now();
    if(!held())spent+=now-last;
    last=now;
    draw(ease(Math.min(1,spent/ms)));
   }
  }
  return {wait,to,tween,alive,fork:p=>p.catch(err=>{if(err!==CANCELLED)throw err})};
 }
 const stage={
  reduced,
  get paused(){return userPaused},
  get finished(){return finished},
  /* Start `script` from the top, dropping whatever was playing. */
  play(script){
   const id=++run;
   for(const a of live)a.cancel();
   live.clear();
   userPaused=false;started=true;finished=false;
   notify();
   script(context(id)).then(()=>{if(id===run){finished=true;notify()}},err=>{if(err!==CANCELLED)throw err});
  },
  stop(){run++;for(const a of live)a.cancel();live.clear();finished=true;notify()},
  /* Play `script` again and again: hold on its last frame, `rewind` softly, start over. */
  loop(script,{hold=2000,rewind}={}){
   stage.play(async c=>{
    for(;;){
     await script(c);
     await c.wait(hold);
     if(rewind)await rewind(c);
    }
   });
  },
  pause(){userPaused=true;sync();notify()},
  resume(){userPaused=false;sync();notify()},
  toggle(){userPaused?stage.resume():stage.pause()},
  /* Run `start` the first time the stage is properly on screen. */
  whenVisible(start){autoStart=start;if(visible&&!started){autoStart=null;start()}}
 };
 new IntersectionObserver(entries=>{
  visible=entries[entries.length-1].isIntersecting;
  if(visible&&autoStart&&!started){const start=autoStart;autoStart=null;start()}
  sync();
 },{threshold:.35}).observe(root);
 document.addEventListener('visibilitychange',sync);
 return stage;
}

/* A pointer that lives inside the demo. It never touches the visitor's own cursor. */
export function createCursor(host){
 const el=document.createElement('div');
 el.className='lp-demo-cursor';
 el.setAttribute('aria-hidden','true');
 el.innerHTML='<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 3l14 8.2-6.3 1.6L9.6 19z" fill="#0C2620" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
 host.append(el);
 let at={x:0,y:0};
 const point=(target,fx=.5,fy=.5)=>{
  if(!(target instanceof Element))return target;
  const h=host.getBoundingClientRect(),r=target.getBoundingClientRect();
  return {x:r.left-h.left+r.width*fx,y:r.top-h.top+r.height*fy};
 };
 const place=p=>`translate(${p.x}px,${p.y}px)`;
 return {
  el,point,
  set(target,fx,fy){at=point(target,fx,fy);el.style.transform=place(at)},
  show:(c,ms=200)=>c.to(el,{opacity:1},ms),
  hide:(c,ms=250)=>c.to(el,{opacity:0},ms),
  async move(c,target,ms=620,fx,fy){at=point(target,fx,fy);await c.to(el,{transform:place(at)},ms,{ease:EASE.move})},
  async press(c){el.classList.add('is-down');await c.wait(130);el.classList.remove('is-down')}
 };
}

/* CSS matrix3d that maps a w×h box (origin at its top-left) onto four points,
   given in the order top-left, top-right, bottom-right, bottom-left. */
export function quadMatrix(w,h,q){
 const src=[[0,0],[w,0],[w,h],[0,h]],m=[];
 src.forEach(([x,y],i)=>{
  const [u,v]=q[i];
  m.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);
 });
 for(let i=0;i<8;i++){
  let p=i;
  for(let r=i+1;r<8;r++)if(Math.abs(m[r][i])>Math.abs(m[p][i]))p=r;
  [m[i],m[p]]=[m[p],m[i]];
  for(let r=0;r<8;r++){
   if(r===i)continue;
   const f=m[r][i]/m[i][i];
   for(let k=i;k<9;k++)m[r][k]-=f*m[i][k];
  }
 }
 const [a,b,c,d,e,f,g,k]=m.map((row,i)=>row[8]/row[i]);
 return `matrix3d(${[a,d,0,g,b,e,0,k,0,0,1,0,c,f,0,1].join(',')})`;
}

/* A guided loop: the section's real controls are worked on a loop while a
   caption says what is happening, and the visitor can take over at any time.
   `pointer` decides how a press is shown: 'cursor' (a demo pointer, for
   actions like dragging or editing), 'touch' (a fingertip, inside a phone),
   or 'none' (the control just lights up as it is pressed). */
export function createTour(el,{t,reduced=false,pointer='none',manualHint,script,rewind,hold=1800,onTakeover}){
 const bar=el.querySelector('[data-guide]');
 bar.classList.add('lp-guide');
 bar.innerHTML=`<button type="button" class="lp-guide-toggle" data-guide-act="toggle"></button><span class="lp-guide-text"></span><span class="lp-guide-hint">${t(manualHint)}</span><button type="button" class="lp-guide-resume" data-guide-act="resume">${t('Resume demo')}</button>`;
 const text=bar.querySelector('.lp-guide-text'),toggle=bar.querySelector('.lp-guide-toggle');
 const cursor=pointer==='none'?null:createCursor(el);
 if(pointer==='touch')cursor.el.classList.add('is-touch');
 let manual=reduced;
 const stage=createStage(el,{reduced,onChange:paint});
 function paint(){
  bar.dataset.state=reduced?'still':manual?'manual':stage.paused?'paused':'auto';
  toggle.setAttribute('aria-label',stage.paused?t('Play demo'):t('Pause demo'));
  if(manual)text.textContent=t('Your turn');
 }
 const say=label=>{
  if(manual)return;
  text.textContent=t(label);
  text.animate([{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'none'}],{duration:260,easing:EASE.state});
 };
 const find=target=>typeof target==='string'?el.querySelector(target):target;
 // Show the press on a control, then click it exactly as a visitor would.
 async function tap(c,target,{ms=560,wait=220}={}){
  const node=find(target);
  if(!node)return;
  if(cursor)await cursor.move(c,node,ms);
  node.classList.add('lp-tapped');
  if(cursor)await cursor.press(c);else await c.wait(170);
  node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  setTimeout(()=>el.querySelectorAll('.lp-tapped').forEach(n=>n.classList.remove('lp-tapped')),460);
  await c.wait(wait);
 }
 function start(){
  manual=false;
  if(cursor)cursor.el.style.opacity='';
  stage.loop(async c=>{
   if(cursor){cursor.set(el,.5,.6);await cursor.show(c,180)}
   await script({c,tap,say,cursor,el});
  },{hold,rewind:rewind&&(c=>rewind({c,tap,say,cursor,el}))});
  paint();
 }
 function takeover(){
  if(manual)return;
  manual=true;
  stage.stop();
  if(cursor)cursor.el.style.opacity=0;
  el.querySelectorAll('.lp-tapped').forEach(n=>n.classList.remove('lp-tapped'));
  onTakeover?.();
  paint();
 }
 bar.addEventListener('click',ev=>{
  const act=ev.target.closest('[data-guide-act]')?.dataset.guideAct;
  if(act==='toggle')stage.toggle();
  if(act==='resume')start();
 });
 el.addEventListener('pointerdown',ev=>{if(ev.isTrusted&&!bar.contains(ev.target)&&ev.target.closest('button,a,input,[data-object-id],[role=button]'))takeover()},true);
 el.addEventListener('keydown',ev=>{if(ev.isTrusted&&!bar.contains(ev.target)&&(ev.key==='Enter'||ev.key===' '))takeover()},true);
 paint();
 if(!reduced)stage.whenVisible(start);
 return {stage,cursor,takeover,start,get manual(){return manual}};
}

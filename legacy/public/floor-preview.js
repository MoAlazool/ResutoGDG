import {t,language} from './i18n.js';
import {sceneSvg} from './floor-shared.js';
// The same true top-down scene is used across reservation, operations and marketing.
export function mountFloorPreview(root,floor,{onSelect=()=>{},mode='reservation'}={}){
 let zoom=1,x=0,y=0,drag=null;const points=new Map();let pinch=null;
 root.innerHTML=`<div class="floor-perspective floor-mode-${mode}" role="region" aria-label="Restaurant floor preview"><div class="floor-projection"><svg viewBox="0 0 ${floor.width} ${floor.height}">${sceneSvg(floor,{mode})}</svg></div></div><div class="preview-controls"><button data-preview="out" aria-label="Zoom out">−</button><button data-preview="fit" aria-label="Fit">↺</button><button data-preview="in" aria-label="Zoom in">+</button></div>`;
 root.querySelectorAll('svg text').forEach(el=>{el.textContent=t(el.textContent).replace(/ seats$/,language==='ar'?' مقاعد':' seats');});
 const surface=root.querySelector('.floor-perspective'),plane=root.querySelector('.floor-projection');surface.setAttribute('aria-label',t('Restaurant floor preview'));root.querySelectorAll('[aria-label]').forEach(el=>el.setAttribute('aria-label',t(el.getAttribute('aria-label'))));
 function draw(){plane.style.transform=`translate(${x}px,${y}px) scale(${zoom})`;}
 root.querySelectorAll('[data-preview]').forEach(b=>b.onclick=()=>{if(b.dataset.preview==='fit'){zoom=1;x=y=0;}else zoom=Math.max(.7,Math.min(3,zoom+(b.dataset.preview==='in'?.2:-.2)));draw();});
 surface.onpointerdown=ev=>{points.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});surface.setPointerCapture(ev.pointerId);drag={id:ev.pointerId,x:ev.clientX,y:ev.clientY,ox:x,oy:y,moved:false,target:ev.target.closest('[data-id]')?.dataset.id};if(points.size===2){const [a,b]=[...points.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom};}};
 surface.onpointermove=ev=>{if(!points.has(ev.pointerId))return;points.set(ev.pointerId,{x:ev.clientX,y:ev.clientY});if(points.size===2&&pinch){const [a,b]=[...points.values()];zoom=Math.max(.7,Math.min(3,pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance));if(drag)drag.moved=true;}else if(drag&&drag.id===ev.pointerId){const dx=ev.clientX-drag.x,dy=ev.clientY-drag.y;if(Math.hypot(dx,dy)>5)drag.moved=true;x=drag.ox+dx;y=drag.oy+dy;}draw();};
 const end=ev=>{if(drag&&!drag.moved&&drag.target&&ev.type!=='pointercancel')onSelect(drag.target);points.delete(ev.pointerId);drag=null;pinch=null;};surface.onpointerup=end;surface.onpointercancel=end;
 surface.onkeydown=ev=>{if(['Enter',' '].includes(ev.key)&&ev.target.dataset.id){ev.preventDefault();onSelect(ev.target.dataset.id);}};
 draw();return {destroy(){root.replaceChildren();}};
}

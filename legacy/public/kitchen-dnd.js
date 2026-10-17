// Drag orders between kitchen columns.
//
// Built on Pointer Events rather than HTML5 drag-and-drop: kitchen displays are
// touch screens, and native `draggable` never fires a drag on touch. Pointer
// events give mouse, pen and finger the same path.
//
// Dropping only ever moves an order FORWARD along the status chain the server
// already enforces. Dragging two columns ahead simply walks each step in turn,
// so every hop is still validated and version-checked server side; nothing here
// invents a transition the API would refuse.
const THRESHOLD=8;

export function mountKitchenDnd(board,{pathTo,advance,notify,onDragChange}){
 if(!board||board.dataset.dndReady)return;
 board.dataset.dndReady='1';
 const columns=[...board.querySelectorAll('[data-column]')];
 let drag=null;

 const paint=(cls,on)=>columns.forEach(c=>c.classList.toggle(cls,on(c)));
 const reset=()=>columns.forEach(c=>c.classList.remove('drop-ok','drop-no','is-over'));
 const columnUnder=ev=>document.elementFromPoint(ev.clientX,ev.clientY)?.closest('[data-column]')||null;

 board.addEventListener('pointerdown',ev=>{
  const card=ev.target.closest('.order-card[data-order]');
  // Buttons keep working: a tap on a control is never a drag.
  if(!card||ev.button!==0||ev.target.closest('button'))return;
  drag={card,id:card.dataset.order,x:ev.clientX,y:ev.clientY,pointerId:ev.pointerId,moved:false};
 });

 const move=ev=>{
  if(!drag||ev.pointerId!==drag.pointerId)return;
  const dx=ev.clientX-drag.x,dy=ev.clientY-drag.y;
  if(!drag.moved){
   if(Math.hypot(dx,dy)<THRESHOLD)return;
   drag.moved=true;onDragChange(true);
   try{drag.card.setPointerCapture(drag.pointerId)}catch{}
   drag.card.classList.add('is-dragging');
   paint('drop-ok',c=>!!pathTo(drag.id,c.dataset.column));
   paint('drop-no',c=>!pathTo(drag.id,c.dataset.column));
  }
  ev.preventDefault();
  drag.card.style.transform=`translate(${dx}px,${dy}px)`;
  const over=columnUnder(ev);
  columns.forEach(c=>c.classList.toggle('is-over',c===over&&c.classList.contains('drop-ok')));
 };

 const end=async ev=>{
  if(!drag||ev.pointerId!==drag.pointerId)return;
  const d=drag;drag=null;
  if(!d.moved)return;
  d.card.classList.remove('is-dragging');d.card.style.transform='';
  const over=columnUnder(ev),path=over&&pathTo(d.id,over.dataset.column);
  reset();
  if(!path){
   // Refuse plainly rather than firing a request the server will reject.
   if(over&&over.dataset.column!==d.card.dataset.status)notify(over.dataset.column);
   onDragChange(false);return;
  }
  try{await advance(d.id,path)}finally{onDragChange(false)}
 };

 const cancel=()=>{if(!drag)return;const d=drag;drag=null;if(d.moved){d.card.classList.remove('is-dragging');d.card.style.transform='';reset();onDragChange(false)}};
 board.addEventListener('pointermove',move);
 board.addEventListener('pointerup',end);
 board.addEventListener('pointercancel',cancel);
 board.addEventListener('lostpointercapture',cancel);
}

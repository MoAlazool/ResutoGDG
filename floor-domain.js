import {tableFeatures} from './public/floor-model.js';
import {randomBytes} from 'node:crypto';
import {geometryError} from './public/floor-shared.js';

const uid=()=>randomBytes(16).toString('hex');
const reject=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const text=(s,max)=>typeof s==='string'&&s.trim().length>0&&s.length<=max;
const publicTableKeys=['id','label','capacity','zone','shape','cx','cy','width','height','rotation','features','reservable','branchId','minimumSpend','premium','locked'];
const managerTableKeys=[...publicTableKeys,'internalNotes'];
export function migrateFloor(s){
 if(s.floor?.schemaVersion===2){let changed=false;for(const t of s.tables){if(['square','round'].includes(t.shape)&&t.width!==t.height){t.height=t.width;changed=true}if(t.internalNotes===undefined){t.internalNotes='';changed=true}}if(changed)s.floor.revision++;return changed;}
 if(s.floor?.schemaVersion===1){for(const t of s.tables){if(['square','round'].includes(t.shape)&&t.width!==t.height)t.height=t.width;t.internalNotes??='';}s.floor.schemaVersion=2;s.floor.revision++;return true;}
 for(const t of s.tables){t.cx=t.x*12;t.cy=t.y*8;t.width=110;t.height=110;t.rotation=0;}
 s.floor={schemaVersion:2,revision:0,width:1200,height:800,background:{image:s.settings.background||null,opacity:.45,locked:true,x:0,y:0,width:1200,height:800},zones:[{id:'zone-main',type:'zone',label:'Main room',x:600,y:285,width:1080,height:450,rotation:0,color:'#e9efe5'},{id:'zone-terrace',type:'zone',label:'Terrace',x:600,y:630,width:1080,height:220,rotation:0,color:'#f2eadc'}],objects:[
 {id:'wall-top',type:'wall',label:'North wall',x:600,y:55,width:1100,height:10,rotation:0},
 {id:'wall-left',type:'wall',label:'West wall',x:50,y:395,width:10,height:690,rotation:0},
 {id:'wall-right',type:'wall',label:'East wall',x:1150,y:395,width:10,height:690,rotation:0},
 {id:'wall-bottom',type:'wall',label:'South wall',x:600,y:740,width:1100,height:10,rotation:0},
 {id:'window-north',type:'window',label:'Windows',x:600,y:55,width:440,height:12,rotation:0},
 {id:'door-entry',type:'door',label:'Entrance',x:275,y:740,width:90,height:30,rotation:0},
 {id:'counter-bar',type:'counter',label:'Service & bar',x:1110,y:360,width:50,height:240,rotation:0}
 ]};return true;
}
export function floorView(s,{publicView=false}={}){const keys=publicView?publicTableKeys:managerTableKeys;return {...structuredClone(s.floor),tables:s.tables.filter(t=>t.active).map(t=>Object.fromEntries(keys.map(k=>[k,t[k]])))};}
export function publicFloorView(s){return floorView(s,{publicView:true});}
function protectedTable(s,t){return s.visits.some(v=>v.tableId===t.id&&v.status==='open')||s.reservations.some(r=>r.tableId===t.id&&r.end>Date.now()&&(['confirmed','seated'].includes(r.status)||(r.status==='held'&&r.expires>Date.now())));}
export function saveFloor(s,b){
 if(b.baseRevision!==s.floor.revision)reject('Another manager saved this floor. Your draft is preserved; reload the saved floor or export your draft.',409);
 const f=b.layout;
 if(!f||f.width!==1200||f.height!==800||!Array.isArray(f.tables)||!Array.isArray(f.objects)||!Array.isArray(f.zones)||f.tables.length>150||f.objects.length>300||f.zones.length>50)reject('Invalid floor document.');
 const ids=new Set();
 const validateId=o=>{if(!o||!text(o.id,100)||!/^[\w-]+$/.test(o.id)||ids.has(o.id))reject('Objects must have unique valid identifiers.');ids.add(o.id);};
 const zones=f.zones.map(o=>{validateId(o);if(o.type!=='zone'||!/^#[0-9a-f]{6}$/i.test(o.color))reject('Invalid zone.');return cleanObject(o,f)});
 const objects=f.objects.map(o=>{validateId(o);if(!['wall','door','window','counter','text','chair','plant','divider','entrance','kitchen','bar'].includes(o.type))reject('Unsupported floor object.');return cleanObject(o,f)});
 const tables=f.tables.map(t=>{validateId(t);const current=s.tables.find(x=>x.id===t.id);if(!current&&!t.id.startsWith('new-'))reject('Unknown table identity.');if(current&&!current.active)reject('Archived tables cannot be restored through a stale draft.',409);if(!text(t.label,30)||!text(t.zone,40)||!Number.isInteger(t.capacity)||t.capacity<1||t.capacity>20||!['round','square','rectangle'].includes(t.shape))reject('Invalid table details.');if(t.width<40||t.height<40||t.width>500||t.height>500)reject('Table sizes must be between 40 and 500 layout units.');if(['round','square'].includes(t.shape)&&t.width!==t.height)reject('Round and square tables need equal width and height.');t.features??=current?.features||[];t.reservable??=current?.reservable??true;t.branchId??=current?.branchId||'main';if(t.branchId!==(current?.branchId||'main'))reject('Tables must remain on their existing branch floor.');if(!Array.isArray(t.features)||t.features.some(f=>!tableFeatures.includes(f))||typeof t.reservable!=='boolean')reject('Invalid reservation features.');t.minimumSpend??=current?.minimumSpend??0;t.premium??=current?.premium??false;t.internalNotes=String(t.internalNotes??current?.internalNotes??'').trim().slice(0,5000);if(!Number.isSafeInteger(t.minimumSpend)||t.minimumSpend<0||t.minimumSpend>100000000||typeof t.premium!=='boolean')reject('Invalid minimum spend or premium flag.');const err=geometryError({x:t.cx,y:t.cy,...t},f);if(err)reject(t.label+': '+err);return {current,geometry:Object.fromEntries(managerTableKeys.map(k=>[k,t[k]]))};});
 for(const t of s.tables.filter(t=>t.active&&!f.tables.some(x=>x.id===t.id)))if(protectedTable(s,t))reject(t.label+' has an active visit or future reservation and cannot be removed.',409);
 const bg=f.background;if(!bg||typeof bg.locked!=='boolean'||!Number.isFinite(bg.opacity)||bg.opacity<0||bg.opacity>1||!Number.isFinite(bg.x)||!Number.isFinite(bg.y)||!Number.isFinite(bg.width)||!Number.isFinite(bg.height)||bg.x<0||bg.y<0||bg.width<=0||bg.height<=0||bg.x+bg.width>1200||bg.y+bg.height>800)reject('Invalid background settings.');
 validateImage(bg.image);
 for(const t of s.tables.filter(t=>t.active&&!f.tables.some(x=>x.id===t.id))){t.active=false;t.version++;}
 for(const {current,geometry}of tables){if(current){Object.assign(current,geometry,{x:geometry.cx/12,y:geometry.cy/8,version:current.version+1});}else{s.tables.push({...geometry,id:uid(),qr:uid(),x:geometry.cx/12,y:geometry.cy/8,active:true,cleaning:false,version:0,size:geometry.width});}}
 s.floor={schemaVersion:2,revision:s.floor.revision+1,width:1200,height:800,zones,objects,background:{image:bg.image,opacity:bg.opacity,locked:bg.locked,x:bg.x,y:bg.y,width:bg.width,height:bg.height}};
 s.settings.background=bg.image;
 return floorView(s);
}
function cleanObject(o,f){if(!text(o.label,80))reject('Object label is required.');const err=geometryError(o,f);if(err)reject(o.label+': '+err);return {id:o.id,type:o.type,label:o.label,x:o.x,y:o.y,width:o.width,height:o.height,rotation:o.rotation,locked:!!o.locked,hidden:!!o.hidden,material:['wood','stone','garden'].includes(o.material)?o.material:'stone',...(o.type==='zone'?{color:o.color}:{})};}
export function validateImage(image){if(image!==null&&(typeof image!=='string'||image.length>1000000||!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(image)))reject('Choose a PNG or JPEG under 700 KB.');}
export function legacyTable(s,b){
 if(b.add){const t={id:uid(),qr:uid(),label:'T'+(s.tables.length+1),capacity:2,zone:'Main room',x:50,y:50,cx:600,cy:400,width:110,height:110,rotation:0,size:72,shape:'square',active:true,cleaning:false,version:0};s.tables.push(t);s.floor.revision++;return t;}
 const t=s.tables.find(t=>t.id===b.id);if(!t||t.version!==b.version)reject('Layout changed. Refresh before saving.',409);
 if(b.active===false&&protectedTable(s,t))reject('This table has a visit or reservation.',409);
 if(!text(b.label,30)||!text(b.zone,40)||!Number.isInteger(b.capacity)||b.capacity<1||b.capacity>20||!Number.isFinite(b.x)||!Number.isFinite(b.y)||b.x<8||b.x>92||b.y<15||b.y>85||!['round','square','rectangle'].includes(b.shape))reject('Invalid table geometry');
 const geometry={...t,cx:b.x*12,cy:b.y*8};if(geometryError({...geometry,x:geometry.cx,y:geometry.cy},s.floor))reject('Table is outside the floor.');
 Object.assign(t,{label:b.label,zone:b.zone,capacity:b.capacity,x:b.x,y:b.y,cx:b.x*12,cy:b.y*8,shape:b.shape,active:b.active!==false,version:t.version+1});if(b.shape!=='rectangle')t.height=t.width;s.floor.revision++;return t;
}

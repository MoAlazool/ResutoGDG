import {salesInquiry,setupView,saveSetup,plans,availableTables,recommendTables,reservationView,changeReservation} from './restaurant-experience.js';
import {renderShell,seoDocument,shellKey} from './seo.js';
import {marketplace,adapters} from './integrations.js';
import {migratePlatform,billFor,placeOnline,createSplit,splitView,shareFor,shareView,payShare,addRating,insights,quoteLines} from './platform-domain.js';
import {recommend,managerInsights} from './ai-service.js';
import {receiptFor,receiptsForVisit,receiptForPayment,checkoutReceipt} from './receipts.js';
import {suggestOrder} from './suggestions.js';
import http from 'node:http';
import {createRequire} from 'node:module';
import {randomBytes,randomInt,createHash,timingSafeEqual} from 'node:crypto';
import {readFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {menuPreview,importMenu,exportRows,toCSV,extractMenu} from './data-tools.js';
import {paymentConfig,createCheckout,verifyPaymentEvent} from './payments.js';
import QRCode from 'qrcode';
import {migrateFloor,floorView,publicFloorView,saveFloor,legacyTable,validateImage} from './floor-domain.js';
import {aiCapabilities,geminiImage} from './gemini-provider.js';
import {extractMenuDraft,extractFloorDraft} from './ai-imports.js';
import {localMediaStore,firestoreMediaStore,decodeMedia} from './media-store.js';
import {createFirebasePlatform} from './firebase-platform.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const nativeRequire=createRequire(import.meta.url);
const uid=()=>randomBytes(16).toString('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const int=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const str=(x,max=200)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
const hash=x=>createHash('sha256').update(x).digest('hex');
const equal=(a,b)=>timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export const createTenantSeed=({name='New Restaurant',branch='Main branch',plan='growth',ownerUid=''}={})=>({demo:false,tables:Array.from({length:6},(_,i)=>({id:'t'+(i+1),qr:uid(),label:'T'+(i+1),capacity:[2,4,4,6,2,6][i],zone:'Main room',x:[20,50,78,22,52,80][i],y:i<3?30:70,shape:i%3===0?'round':'square',size:72,cleaning:false,active:true,version:0})),menu:[],reservations:[],visits:[],orders:[],payments:[],requests:[],audit:[],idem:{},sessions:[],settings:{name,branch,duration:90,buffer:15,deposit:0,deliveryFee:0,deliveryEnabled:false},profile:{name,type:'Restaurant',cuisine:'',country:'Egypt',contact:'',language:'en',currency:'EGP',timezone:'Africa/Cairo'},setup:{revision:0,mode:'native',step:0,plan,ownerUid},credentials:{}});
export const migrateTenantState=state=>{migrateFloor(state);migratePlatform(state)};
export function createApp({dbPath=process.env.DB_PATH||path.join(root,'data/resuto.sqlite'),origin=process.env.APP_ORIGIN||'http://localhost:3000',managerPassword=process.env.MANAGER_PASSWORD,kitchenPassword=process.env.KITCHEN_PASSWORD,hostPassword=process.env.HOST_PASSWORD,paymentFetch=fetch,aiFetch=fetch,storage=null,identityProvider=null,mediaStore=localMediaStore(path.join(root,'data/media'))}={}){
 if(!storage&&dbPath!==':memory:')mkdirSync(path.dirname(dbPath),{recursive:true});
 const db=storage?null:new (nativeRequire('node:sqlite').DatabaseSync)(dbPath);db?.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');
 const seed=()=>({demo:true,tables:Array.from({length:6},(_,i)=>({id:'t'+(i+1),qr:uid(),label:'T'+(i+1),capacity:[2,4,4,6,2,6][i],zone:i<4?'Main room':'Terrace',x:[20,50,78,22,52,80][i],y:i<3?30:70,shape:i%3===0?'round':'square',size:72,cleaning:false,active:true,version:0})),menu:[['Burrata & heirloom tomato','Starters',145,'Cold kitchen',18,['milk'],true],['Roasted pumpkin soup','Starters',95,'Hot kitchen',24,[],true],['Grilled chicken supreme','Mains',285,'Grill',22,[],false],['Wild mushroom risotto','Mains',245,'Hot kitchen',16,['milk'],true],['Seabass with lemon butter','Mains',345,'Grill',12,['fish','milk'],false],['Garden harvest bowl','Mains',185,'Cold kitchen',20,[],true],['Chocolate fondant','Desserts',125,'Pastry',14,['milk','eggs','wheat'],true],['Hibiscus cooler','Drinks',65,'Bar',32,[],true]].map((a,i)=>({id:'m'+i,name:a[0],category:a[1],price:a[2]*100,station:a[3],stock:a[4],allergens:a[5],vegetarian:a[6],available:true,version:0})),reservations:[],visits:[],orders:[],payments:[],requests:[],audit:[],idem:{},sessions:[],settings:{name:'The Olive Room',branch:'Zamalek, Cairo',duration:90,buffer:15,deposit:20000,deliveryFee:3500,deliveryEnabled:true},credentials:{manager:hash(managerPassword||uid()),kitchen:hash(kitchenPassword||uid()),host:hash(hostPassword||uid())}});
 if(!storage&&!db.prepare('SELECT id FROM state').get()){const s=seed();for(const role of ['manager','kitchen','host'])if(!({manager:managerPassword,kitchen:kitchenPassword,host:hostPassword})[role]){const password=uid().slice(0,12);s.credentials[role]=hash(password);console.log(`Initial ${role} password: ${password}`)}db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(s));}
 const read=()=>storage?storage.read():JSON.parse(db.prepare('SELECT json FROM state WHERE id=1').get().json);
 if(!storage){const s=read();if([migrateFloor(s),migratePlatform(s)].some(Boolean))db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(s));}
 if(!storage&&(managerPassword||kitchenPassword||hostPassword)){const s=read();if(managerPassword)s.credentials.manager=hash(managerPassword);if(kitchenPassword)s.credentials.kitchen=hash(kitchenPassword);if(hostPassword)s.credentials.host=hash(hostPassword);db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(s));}
 if(!storage){const s=read();if(!s.credentials.host){s.credentials.host=hash(hostPassword||uid());db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(s));}}
 const ready=storage?storage.initialize(seed, s=>{migrateFloor(s);migratePlatform(s);if(managerPassword)s.credentials.manager=hash(managerPassword);if(kitchenPassword)s.credentials.kitchen=hash(kitchenPassword);if(hostPassword)s.credentials.host=hash(hostPassword)}):Promise.resolve();
 const tx=fn=>{if(storage)return storage.transaction(s=>{for(const r of s.reservations)if(r.status==='held'&&r.expires<Date.now())r.status='expired';sweepVisits(s);const result=fn(s);migrateFloor(s);migratePlatform(s);s.revision=(s.revision||0)+1;return result;});db.exec('BEGIN IMMEDIATE');try{const s=read();for(const r of s.reservations)if(r.status==='held'&&r.expires<Date.now())r.status='expired';sweepVisits(s);const result=fn(s);migrateFloor(s);migratePlatform(s);s.revision=(s.revision||0)+1;db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(s));db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
 const event=(s,type,id)=>s.audit.unshift({id:uid(),type,entity:id,at:Date.now()});
 const auth=(s,req,roles)=>{if(req.identity){if(!roles.includes(req.identity.role))fail('This account does not have access to that workspace.',403);return req.identity}const token=(req.headers.cookie||'').match(/(?:^|; )session=([^;]+)/)?.[1];const session=s.sessions.find(x=>x.token===token&&x.expires>Date.now());if(!session||!roles.includes(session.role))fail('Please sign in with the correct staff role.',401);return session};
 const guest=(s,req)=>{const token=(req.headers.authorization||'').replace('Bearer ','');const v=s.visits.find(x=>x.token===token);if(!v)fail('Join your visit to continue.',401);return v};
 const bill=(s,v)=>{const subtotal=s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled').reduce((n,o)=>n+o.total,0),total=subtotal+v.fee,paid=s.payments.filter(p=>p.visitId===v.id&&p.kind==='bill').reduce((n,p)=>n+p.amount,0);return {subtotal,fee:v.fee,total,credit:v.credit,paid,due:Math.max(0,total-v.credit-paid)}};
 const view=(s,v)=>({...v,token:undefined,pin:undefined,locked:settling(s,v),bill:bill(s,v),orders:s.orders.filter(o=>o.visitId===v.id),requests:s.requests.filter(r=>r.visitId===v.id),split:splitView(s,v,origin),rated:s.ratings.some(r=>r.visitId===v.id&&!r.shareId),receipts:s.payments.filter(p=>p.visitId===v.id&&p.kind==='bill').sort((a,b)=>b.at-a.at).map(p=>({paymentId:p.id,at:p.at,amount:p.amount,share:!!p.shareId})),checkout:(s.checkouts||[]).filter(c=>c.visitId===v.id&&c.status==='pending').map(c=>({id:c.id,provider:c.provider,amount:c.amount,url:c.url||null}))});
 // Ordering pauses only while money is genuinely in flight: a provider
 // checkout awaiting its webhook, or an active split whose shares are fixed.
 // Asking for the bill or paying part of it must NOT end the meal — guests
 // keep adding dessert and drinks until they settle up for good.
 const settling=(s,v)=>(s.checkouts||[]).some(c=>c.visitId===v.id&&c.status==='pending')||(s.splits||[]).some(x=>x.visitId===v.id&&x.status==='active');
 const occupied=(s,t)=>s.visits.some(v=>v.tableId===t.id&&v.status==='open');
 const overlap=(s,t,start,end,exclude)=>s.reservations.some(r=>r.id!==exclude&&r.tableId===t.id&&(['confirmed','seated'].includes(r.status)||(r.status==='held'&&r.expires>Date.now()))&&start<r.end&&end>r.start);
 const newVisit=(s,type,table,name,reservation)=>{const v={id:uid(),token:uid(),pin:table?String(randomInt(100000,1000000)):null,type,tableId:table?.id??null,name,status:'open',locked:false,credit:reservation?.deposit||0,fee:type==='delivery'?s.settings.deliveryFee:0,created:Date.now()};s.visits.push(v);event(s,'Visit opened',v.id);return v};
 // --- Automated table lifecycle -------------------------------------------
 // A table opens itself when a guest scans it and settles itself once the bill
 // is paid, everything served, and the guests have had a grace period to order
 // again. Staff can still do both by hand; this only removes the busywork.
 const AUTO_CLOSE_MS=10*60000,AUTO_OPEN_UNDO_MS=60000,FULFILLED=['served','picked_up','delivered'];
 const settleVisit=(s,v)=>{v.status='closed';v.closedAt=Date.now();
  const unused=Math.max(0,v.credit-bill(s,v).total);
  if(unused)s.payments.push({id:uid(),visitId:v.id,kind:'test-refund',amount:unused,at:Date.now()});
  if(v.reservationId)s.reservations.find(r=>r.id===v.reservationId).status='completed';
  s.requests.filter(r=>r.visitId===v.id).forEach(r=>r.status='resolved');
  return unused};
 // Everything paid, everything served, nothing mid-flight, and quiet since.
 const autoCloseDue=(s,v)=>{
  if(v.status!=='open'||v.autoClose===false)return false;
  const b=bill(s,v);if(b.due>0||b.total<=0)return false;
  const orders=s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled');
  if(!orders.length||orders.some(o=>!FULFILLED.includes(o.status)))return false;
  if((s.checkouts||[]).some(c=>c.visitId===v.id&&c.status==='pending'))return false;
  if(s.requests.some(r=>r.visitId===v.id&&r.status==='open'))return false;
  const quietSince=Math.max(...orders.map(o=>o.fulfilledAt||o.created),...s.payments.filter(p=>p.visitId===v.id).map(p=>p.at),v.created);
  return Date.now()-quietSince>=AUTO_CLOSE_MS};
 const sweepVisits=s=>{for(const v of s.visits)if(autoCloseDue(s,v)){settleVisit(s,v);event(s,'Visit closed automatically',v.id)}};
 const sweepPending=async()=>{const s=await read();if(s.visits.some(v=>autoCloseDue(s,v)))await tx(()=>({}))};
 const idem=(s,scope,key,payload,fn)=>{if(!str(key,100))fail('A request key is required.');const id=scope+':'+key,fp=hash(JSON.stringify(payload));if(s.idem[id]){if(s.idem[id].fp!==fp)fail('Request key was already used for different data.',409);return s.idem[id].result}const result=fn();s.idem[id]={fp,result};return result};
 const rates=new Map();
 const handleRequest=async(req,res)=>{try{await ready;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Cross-Origin-Opener-Policy','same-origin-allow-popups');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' https://apis.google.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://resuto-cf8f5.firebaseapp.com https://accounts.google.com; frame-ancestors 'none'");
  const url=new URL(req.url,origin),p=url.pathname;
  let configPromise=null;const config=()=>configPromise||=read();
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
  if(req.method==='GET'&&!p.startsWith('/api/')){if(p.startsWith('/qr/')){const state=await read();
    if(p==='/qr/venue'){const target=state.settings.publicPath?new URL(state.settings.publicPath,origin).toString():origin+'/t/'+state.settings.venueQr;res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end(await QRCode.toString(target,{type:'svg',margin:2}))}
    const t=state.tables.find(t=>t.qr===p.slice(4));if(!t)fail('Table not found',404);res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end(await QRCode.toString(origin+'/t/'+t.qr,{type:'svg',margin:2}))}if(p.startsWith('/media/')){const media=await mediaStore.get(p.slice(7));if(!media)fail('Media not found',404);res.writeHead(200,{'Content-Type':media.metadata?.mime||'application/octet-stream','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});return res.end(media.data);}if(p==='/robots.txt'||p==='/sitemap.xml'||p==='/llms.txt'){const doc=seoDocument(p,origin);res.writeHead(200,{'Content-Type':doc.type,'Cache-Control':'public, max-age=3600'});return res.end(doc.body)}const asset=/^\/(?:[a-z0-9-]+\.js|[a-z0-9-]+\.css|locales\/[a-z-]+\.js|fonts\/[a-z0-9-]+\.(?:ttf|woff2))$/.test(p)||['/app.js','/data-workspace.js','/style.css','/pages.js','/pages.css','/floor-editor.js','/floor-editor.css','/floor-shared.js'].includes(p)||/^\/assets\/(?:smash\/)?[a-z0-9-]+\.(png|jpg|webp)$/.test(p);const file=asset?p:'/index.html';if(asset&&!existsSync(path.join(root,'public',file)))fail('Asset not found',404);const full=path.join(root,'public',file),info=statSync(full);
   // The app pulls sixteen stylesheets and a dozen modules per page. Fonts and
   // images never change under a given name, so they are cached hard; code and
   // markup revalidate against an ETag, turning repeat loads into 304s instead
   // of full downloads.
   const etag='"'+info.size.toString(16)+'-'+info.mtimeMs.toString(36)+(asset?'':'-'+shellKey(url))+'"';
   if(req.headers['if-none-match']===etag){res.writeHead(304,{ETag:etag});return res.end()}
   const immutable=/\.(ttf|woff2|png|jpg|webp)$/.test(file);
   res.writeHead(200,{'Content-Type':file.endsWith('.ttf')?'font/ttf':file.endsWith('.woff2')?'font/woff2':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':file.endsWith('.jpg')?'image/jpeg':file.endsWith('.webp')?'image/webp':'text/html',
    ETag:etag,'Cache-Control':immutable?'public, max-age=31536000, immutable':'no-cache'});
   return res.end(asset?readFileSync(full):renderShell(readFileSync(full,'utf8'),url,origin));}
  let b={},raw='';const webhook=p.startsWith('/api/webhooks/');if(req.method==='POST'){if(!webhook&&req.headers.origin&&req.headers.origin!==origin)fail('Cross-origin writes are not allowed.',403);if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('Use application/json',415);let data='';for await(const chunk of req){data+=chunk;if(data.length>(['/api/menu-extract','/api/floor-extract'].includes(p)?13000000:1100000))fail('Request too large',413)}raw=data;try{b=JSON.parse(data||'{}')}catch{fail('Invalid JSON')}}
  if(p.startsWith('/api/account/')){if(!identityProvider)fail('Firebase restaurant accounts are not enabled on this server.',503);if(p==='/api/account/profile'&&req.method==='GET')return send(await identityProvider.account(req.identity));if(p==='/api/account/bootstrap'&&req.method==='POST')return send(await identityProvider.bootstrap(req.identity,b),201);if(p==='/api/account/invite'&&req.method==='POST')return send(await identityProvider.invite(req.identity,b),201);fail('Not found',404)}
  if(webhook&&req.method==='POST'){const ev=verifyPaymentEvent(p.split('/').pop(),raw,req.headers,url.searchParams);if(!ev)return send({received:true});return send(await tx(s=>{const c=(s.checkouts||[]).find(c=>c.provider===ev.provider&&c.providerId===ev.providerId);if(!c)fail('Checkout not yet stored; retry notification.',409);if(c.amount!==ev.amount||ev.currency!=='EGP')fail('Payment amount or currency mismatch.',409);if(c.status==='paid')return {received:true};if(!ev.paid){if(c.status==='pending')c.status='expired';return {received:true}}const v=s.visits.find(v=>v.id===c.visitId);if(!v||v.status!=='open'||bill(s,v).due<c.amount)fail('Payment requires reconciliation.',409);c.status='paid';if(c.shareId){const share=s.shares.find(x=>x.id===c.shareId);if(!share||share.status==='paid')fail('Share already paid.',409);share.status='paid';share.paidAt=Date.now();const split=s.splits.find(x=>x.id===share.splitId);if(split&&s.shares.filter(x=>x.splitId===split.id).every(x=>x.status==='paid')){split.status='complete';split.completedAt=Date.now();}}s.payments.push({id:uid(),visitId:v.id,kind:'bill',amount:c.amount,shareId:c.shareId||null,provider:c.provider,providerId:ev.eventId,at:Date.now()});event(s,'Online payment confirmed',v.id);return {received:true}}));}
  if(p==='/api/checkout'&&req.method==='POST'){
    if(!paymentConfig(await config()).providers.includes(b.provider))fail('Payment provider not configured.',503);
    if(b.provider==='paymob'&&(!str(b.firstName,80)||!str(b.lastName,80)||!str(b.email,150)||!b.email.includes('@')||!str(b.phone,30)))fail('Paymob needs your name, email and phone.');
    const attempt=await tx(s=>{const share=b.shareToken?shareFor(s,b.shareToken):null,v=share?s.visits.find(v=>v.id===share.visitId):guest(s,req);if(share){if(share.status!=='pending'||!str(b.firstName,60))fail('Enter a name for an unpaid share.');b.amount=share.amount;share.name=b.firstName;}else if(s.splits.some(x=>x.visitId===v.id&&x.status==='active'))fail('Use the assigned payment shares.',409);if(v.status!=='open')fail('Visit is closed.',409);s.checkouts||=[];return idem(s,'checkout:'+v.id+':'+(share?.id||'bill'),b.key,{amount:b.amount,provider:b.provider},()=>{if(!int(b.amount,1,bill(s,v).due))fail('Balance changed. Refresh your bill.',409);if(s.checkouts.some(c=>c.visitId===v.id&&c.status==='pending'&&(!share||c.shareId===share.id)))fail('A checkout is already open. Resume it from your bill.',409);v.locked=true;const c={id:uid(),visitId:v.id,shareId:share?.id||null,returnPath:share?'/s/'+share.token:'/order',amount:b.amount,provider:b.provider,status:'pending',created:Date.now()};s.checkouts.push(c);return {id:c.id}})});
    let c=(await read()).checkouts.find(c=>c.id===attempt.id);if(c.status!=='pending')fail('This checkout is finished. Refresh your bill.',409);if(c.url)return send({url:c.url,checkoutId:c.id});
    // Claim creation once. An uncertain provider response must not create a second charge.
    await tx(s=>{const c=s.checkouts.find(c=>c.id===attempt.id);if(c.creating&&c.provider!=='stripe')fail('Checkout creation is pending or needs manager reconciliation. Do not submit another payment.',409);c.creating=true;});
    const created=await createCheckout(c,origin,b,paymentFetch);await tx(s=>Object.assign(s.checkouts.find(c=>c.id===attempt.id),created));return send({url:created.url,checkoutId:attempt.id});
  }
  if(p==='/api/login'&&req.method==='POST'){const ip=req.socket.remoteAddress,rate=rates.get(ip)||{n:0,at:Date.now()};if(Date.now()-rate.at>60000){rate.n=0;rate.at=Date.now()}rates.set(ip,rate);if(++rate.n>20)fail('Too many attempts. Try again in a minute.',429);const token=await tx(s=>{if(!['manager','kitchen','host'].includes(b.role)||typeof b.password!=='string'||!equal(s.credentials[b.role],hash(b.password)))fail('Incorrect role or password.',401);const token=uid();s.sessions=s.sessions.filter(x=>x.expires>Date.now());s.sessions.push({token,role:b.role,expires:Date.now()+8*3600000});return token});res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${origin.startsWith('https')?'; Secure':''}`);return send({ok:true})}
  if(p==='/api/plans'&&req.method==='GET')return send({plans,billingEnabled:false});
  if(p==='/api/integration-capabilities'&&req.method==='GET')return send({native:true,connectors:['foodics','odoo','stripe','paymob'],payments:paymentConfig(await config()).methods.map(({id,kind,available,confirmation})=>({id,kind,available,confirmation}))});
  if(p==='/api/setup'&&req.method==='GET'){const s=await read();auth(s,req,['manager']);return send(setupView(s));}
  if(p==='/api/reservation'&&req.method==='GET')return send(reservationView(await read(),url.searchParams.get('token')));
  if(p==='/api/table-recommend'&&req.method==='POST'){const result=await recommendTables(await read(),b),ids=new Set(availableTables(await read(),b).map(t=>t.id));return send({...result,tableIds:result.tableIds.filter(id=>ids.has(id)),tables:result.tables.filter(t=>ids.has(t.id))});}
  if(p==='/api/availability'&&req.method==='GET'){const s=await read(),q=Object.fromEntries(url.searchParams),ids=availableTables(s,q).map(t=>t.id),start=Number(q.start),end=start+(s.settings.duration+s.settings.buffer)*60000;return send({tableIds:ids,tableStates:Object.fromEntries(s.tables.filter(t=>t.active&&(t.branchId||'main')===(q.branchId||'main')).map(t=>[t.id,ids.includes(t.id)?'available':overlap(s,t,start,end)?'reserved':'unavailable']))});}
  if(p==='/api/public'&&req.method==='GET'){const s=await read(),start=Number(url.searchParams.get('start'))||Date.now(),end=start+(s.settings.duration+s.settings.buffer)*60000;return send({payments:paymentConfig(await config()),settings:{...s.settings,venueQr:s.settings.serviceMode==='tables'?undefined:s.settings.venueQr},brand:{name:s.settings.name,logo:s.profile?.logo||null},branches:s.branches,menu:s.menu.map(({internalNotes,...m})=>m),floor:publicFloorView(s),tables:s.tables.filter(t=>t.active).map(({internalNotes,...t})=>({...t,available:t.reservable!==false&&!t.cleaning&&!(start<Date.now()+s.settings.duration*60000&&occupied(s,t))&&!overlap(s,t,start,end)}))})}
  if(p==='/api/staff'&&req.method==='GET'){await sweepPending();const s=await read(),a=auth(s,req,['manager','kitchen','host']);return send({revision:s.revision,branches:s.branches,analytics:a.role==='manager'?insights(s):null,payments:paymentConfig(await config()),role:a.role,settings:s.settings,floor:floorView(s),tables:s.tables,menu:s.menu,orders:s.orders,requests:s.requests,visits:s.visits.map(v=>({...view(s,v),pin:a.role==='manager'?v.pin:undefined})),reservations:['manager','host'].includes(a.role)?s.reservations:[],audit:a.role==='manager'?s.audit.slice(0,100):[]})}
  if(p==='/api/floor'&&req.method==='GET'){const s=await read();auth(s,req,['manager']);return send(floorView(s))}
  if(p==='/api/visit'&&req.method==='GET'){const s=await read();return send(view(s,guest(s,req)))}
  // Receipts are read-only projections of confirmed payments. A pending status
  // means the provider has not been verified yet — never a paid receipt.
  if(p==='/api/receipts'&&req.method==='GET'){const s=await read();return send({receipts:receiptsForVisit(s,guest(s,req))})}
  if(p==='/api/receipt'&&req.method==='GET'){const s=await read(),q=url.searchParams;
   if(q.get('checkout')){const c=(s.checkouts||[]).find(x=>x.id===q.get('checkout'));if(!c)fail('Receipt not found.',404);
    const owner=q.get('share')?shareFor(s,q.get('share')).id===c.shareId:guest(s,req).id===c.visitId;if(!owner)fail('Receipt not found.',404);
    return send(checkoutReceipt(s,c))}
   if(q.get('reservation')){const r=s.reservations.find(x=>x.token===q.get('reservation'));if(!r)fail('Receipt not found.',404);
    const paid=s.payments.find(x=>x.reservationId===r.id&&x.kind==='deposit');return send({status:paid?'paid':'pending',receipt:paid?receiptFor(s,paid):null})}
   if(q.get('share')){const share=shareFor(s,q.get('share')),paid=s.payments.find(x=>x.shareId===share.id&&x.kind==='bill');
    return send({status:paid?'paid':'pending',receipt:paid?receiptFor(s,paid):null})}
   const v=guest(s,req);return send({status:'paid',receipt:receiptForPayment(s,q.get('payment'),pay=>pay.visitId===v.id)})}
  if(p==='/api/export'&&req.method==='GET'){const s=await read();auth(s,req,['manager']);const kind=url.searchParams.get('kind'),rows=exportRows(s,kind),csv=url.searchParams.get('format')!=='json';res.writeHead(200,{'Content-Type':csv?'text/csv; charset=utf-8':'application/json','Content-Disposition':'attachment; filename="resuto-'+kind+(csv?'.csv':'.json')+'"','Cache-Control':'no-store'});return res.end(csv?toCSV(rows):JSON.stringify({currency:'EGP',moneyUnits:kind==='menu'?'major':'minor',rows},null,2));}
  if(p==='/api/ai-capabilities'&&req.method==='GET'){const s=await read();auth(s,req,['manager']);return send(aiCapabilities());}
  if(p==='/api/menu-extract'&&req.method==='POST'){auth(await read(),req,['manager']);return send(await extractMenuDraft(b,aiFetch));}
  if(p==='/api/floor-extract'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);return send(await extractFloorDraft(b,floorView(s),aiFetch));}
  if(p==='/api/menu-image-generate'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);const item=s.menu.find(x=>x.id===b.menuItemId);if(!item)fail('Menu item not found.',404);return send(await geminiImage({fetcher:aiFetch,prompt:typeof b.prompt==='string'?b.prompt.slice(0,1200):`Editorial restaurant menu photograph for ${item.name}. Respect this description only: ${item.description||''}. No text, logos, people, packaging or invented ingredients.`}));}
  if(p==='/api/menu-image'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);const item=s.menu.find(x=>x.id===b.menuItemId);if(!item)fail('Menu item not found.',404);if(b.action==='remove'){const old=item.imageMediaKey;await tx(state=>{const target=state.menu.find(x=>x.id===b.menuItemId);delete target.imageUrl;delete target.imageMediaKey;target.version++;return {ok:true};});if(old)await mediaStore.delete(old);return send({ok:true});}const decoded=decodeMedia(b),extension={'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[decoded.mime],key=`menu-${item.id}-${uid().slice(0,12)}.${extension}`,stored=await mediaStore.put(key,decoded.data,{mime:decoded.mime,menuItemId:item.id});const result=await tx(state=>{const target=state.menu.find(x=>x.id===b.menuItemId);if(!target)fail('Menu item not found.',404);const old=target.imageMediaKey;target.imageUrl=stored.url;target.imageMediaKey=stored.key;target.version++;return {url:stored.url,key:stored.key,old};});if(result.old)await mediaStore.delete(result.old);return send({url:result.url});}
  if(p==='/api/menu-preview'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);return send({rows:menuPreview(b.rows??b.csv,s)});}
  if(p==='/api/recommend'&&req.method==='POST')return send(await recommend(await read(),b));
  // Complementary suggestions for the guest's own visit. Read-only.
  if(p==='/api/suggest'&&req.method==='POST'){const s=await read();return send(await suggestOrder(s,guest(s,req),b.cart,aiFetch));}
  if(p==='/api/manager-insights'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);return send(await managerInsights(s,b));}
  if(p==='/api/integrations'&&req.method==='GET'){const s=await read();auth(s,req,['manager']);return send(marketplace(s));}
  if(p==='/api/integration-sync'&&req.method==='POST'){const s=await read();auth(s,req,['manager']);if(!s.integrations[b.id]?.enabled||!adapters[b.id])fail('Connect the provider first.');try{const rows=await adapters[b.id].menu();await tx(s=>{s.integrations[b.id].lastSync=Date.now();s.integrations[b.id].error=null;});return send({rows});}catch(e){await tx(s=>{s.integrations[b.id].error='Provider connection failed.'});throw e;}}
  if(p==='/api/events'&&req.method==='GET'){await sweepPending();const s=await read();return send({revision:s.revision||0});}
  if(p==='/api/share'&&req.method==='GET'){const s=await read();return send({...shareView(s,shareFor(s,url.searchParams.get('token'))),payments:paymentConfig(await config())});}
  if(p==='/api/share-qr'&&req.method==='GET'){const s=await read(),share=shareFor(s,url.searchParams.get('token'));res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});return res.end(await QRCode.toString(origin+'/s/'+share.token,{type:'svg',margin:2}));}
  if(p==='/api/sales-inquiry'&&req.method==='POST'){const k='sales:'+req.socket.remoteAddress,rate=rates.get(k)||{n:0,at:Date.now()};if(Date.now()-rate.at>60000){rate.n=0;rate.at=Date.now();}rates.set(k,rate);if(++rate.n>5)fail('Too many inquiries. Try again in a minute.',429);}
  // Fast path: rejoining an existing order needs no write at all.
  if(p==='/api/table-session'&&req.method==='POST'){const s=await read();
   const counter=s.settings.serviceMode!=='tables'&&b.qr===s.settings.venueQr;
   const token=(req.headers.authorization||'').replace('Bearer ','');
   const open=counter
    ?s.visits.find(v=>v.token===token&&v.status==='open')
    :s.visits.find(v=>v.status==='open'&&v.tableId===s.tables.find(t=>t.active&&t.qr===b.qr)?.id);
   if(open)return send(counter
    ?{tableId:null,label:s.settings.name,counter:true,token:open.token}
    :{tableId:open.tableId,label:s.tables.find(t=>t.id===open.tableId)?.label,token:open.token});
  }
  if(req.method!=='POST')fail('Not found',404);
  const result=await tx(s=>{
   if(p==='/api/sales-inquiry')return idem(s,'sales-inquiry',b.key,b,()=>salesInquiry(s,b));
   if(p==='/api/reservation-change')return idem(s,'reservation-change',b.key,b,()=>changeReservation(s,b));
   if(p==='/api/online-order')return idem(s,'online-order',b.key,b,()=>{const result=placeOnline(s,b);event(s,'Online order received',result.orderId);return result});
   if(p==='/api/split'){const v=guest(s,req);return idem(s,'split:'+v.id,b.key,b,()=>createSplit(s,v,b,origin));}
   if(p==='/api/share-pay'){const share=shareFor(s,b.token);return idem(s,'share-pay:'+share.id,b.key,b,()=>{const result=payShare(s,share,b);event(s,'Share paid',share.id);return result});}
   if(p==='/api/rating'){const share=b.shareToken?shareFor(s,b.shareToken):null,v=share?s.visits.find(v=>v.id===share.visitId):guest(s,req);return addRating(s,v,b,share?.id);}
   if(p==='/api/logout'){const token=(req.headers.cookie||'').match(/session=([^;]+)/)?.[1];s.sessions=s.sessions.filter(x=>x.token!==token);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return {ok:true}}
   if(p==='/api/reserve'){if(s.settings.serviceMode!=='tables'||!s.settings.reservationsEnabled)fail('This restaurant does not take reservations.',409);return idem(s,'reserve',b.key,b,()=>{const t=s.tables.find(t=>t.id===b.tableId&&t.active&&t.reservable!==false);if(!t||!s.branches.some(x=>x.id===(t.branchId||'main')&&x.active&&x.reservations)||!int(b.party,1,t.capacity)||!str(b.name)||!str(b.contact))fail('Provide guest details and a table large enough for your party.');const start=Number(b.start),end=start+(s.settings.duration+s.settings.buffer)*60000;if(!Number.isFinite(start)||start<Date.now()-60000||start>Date.now()+180*86400000)fail('Choose a future time within 180 days.');if(t.cleaning||(start<Date.now()+s.settings.duration*60000&&occupied(s,t))||overlap(s,t,start,end))fail('This table is no longer available.',409);const r={id:uid(),token:uid(),tableId:t.id,name:b.name,contact:b.contact,party:b.party,start,end,expires:Date.now()+300000,status:'held',deposit:s.settings.deposit};s.reservations.push(r);event(s,'Reservation held',r.id);return r})}
   if(p==='/api/deposit'){if(paymentConfig(s).mode==='live')fail('Online reservation deposits are not enabled. Contact the restaurant.',503);const r=s.reservations.find(r=>r.token===b.token);if(!r)fail('Reservation not found',404);return idem(s,'deposit:'+r.id,b.key,b,()=>{if(r.status!=='held'||r.expires<Date.now())fail('This hold has expired or is already confirmed.',409);r.status='confirmed';s.payments.push({id:uid(),reservationId:r.id,amount:r.deposit,kind:'deposit',at:Date.now()});event(s,'Test deposit confirmed',r.id);return r})}
   // Scanning the table QR opens the visit. Staff are notified and can undo it
   // while it is still empty; a busy, dirty or imminently-reserved table is
   // never auto-opened, so this cannot take a table from someone.
   if(p==='/api/table-session'){
    if(s.settings.serviceMode!=='tables'&&b.qr===s.settings.venueQr){
     if(s.settings.serviceMode==='delivery')fail('This restaurant takes online orders only.',409);
     const existing=s.visits.find(v=>v.token===(req.headers.authorization||'').replace('Bearer ','')&&v.status==='open');
     if(existing)return {tableId:null,label:s.settings.name,counter:true,token:existing.token};
     const v=newVisit(s,'counter',null,'Counter order');v.auto=true;v.counter=true;
     event(s,'Counter order opened by QR scan',v.id);
     return {tableId:null,label:s.settings.name,counter:true,token:v.token};
    }
    if(s.settings.serviceMode!=='tables')fail('Table not found.',404);
    const t=s.tables.find(t=>t.active&&t.qr===b.qr);if(!t)fail('Table not found.',404);
    let v=s.visits.find(v=>v.tableId===t.id&&v.status==='open');
    if(!v&&!t.cleaning&&t.reservable!==false&&s.branches.some(x=>x.id===(t.branchId||'main')&&x.active)){
     const now=Date.now(),held=s.reservations.find(r=>r.tableId===t.id&&r.status==='confirmed'&&now>=r.start-15*60000&&now<=r.start+30*60000);
     if(!overlap(s,t,now,now+(s.settings.duration+s.settings.buffer)*60000,held?.id)){
      v=newVisit(s,'dine-in',t,held?.name||'Table '+t.label,held);
      v.auto=true;if(held){held.status='seated';v.reservationId=held.id;}
      event(s,'Table opened by QR scan',v.id);
     }
    }
    return {tableId:t.id,label:t.label,token:v?.token||null}}
   if(p==='/api/join'){const ip=req.socket.remoteAddress,k='join:'+ip,rate=rates.get(k)||{n:0,at:Date.now()};if(Date.now()-rate.at>60000){rate.n=0;rate.at=Date.now()}rates.set(k,rate);if(++rate.n>20)fail('Too many PIN attempts. Wait one minute.',429);const v=s.visits.find(v=>v.status==='open'&&v.tableId===s.tables.find(t=>t.qr===b.qr)?.id&&v.pin===b.pin);if(!v)fail('No current visit matches this PIN.',403);return {token:v.token}}
   if(p==='/api/offsite'){if(!['pickup','delivery'].includes(b.type)||!str(b.name)||!str(b.contact)||b.type==='delivery'&&(!s.settings.deliveryEnabled||!str(b.address)))fail('Complete your contact and delivery details.');return idem(s,'offsite',b.key,b,()=>{const v=newVisit(s,b.type,null,b.name);v.contact=b.contact;v.address=b.address||'';v.requested=b.requested||'';return {token:v.token}})}
   if(['/api/order','/api/pay','/api/request'].includes(p)){const v=guest(s,req);if(v.status!=='open')fail('This visit is closed.',409);return idem(s,v.id+p,b.key,b,()=>{
    if(p==='/api/order'){if(settling(s,v))fail('A payment is being processed. New orders resume as soon as it finishes.',409);if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>50)fail('Your cart is empty.');const lines=quoteLines(s,b.lines,v.branchId||'main');for(const x of lines){const m=s.menu.find(m=>m.id===x.id);m.stock-=x.qty;m.version++;}const o={id:uid(),number:s.orders.length+1,visitId:v.id,tableId:v.tableId,type:v.type,name:v.name,lines,total:lines.reduce((n,l)=>n+l.qty*l.price,0),notes:String(b.notes||'').slice(0,500),status:'received',version:0,created:Date.now()};s.orders.push(o);event(s,'Order received',o.id);return o}
    if(p==='/api/pay'){if(s.splits.some(x=>x.visitId===v.id&&x.status==='active'))fail('Use the assigned payment shares.',409);if(paymentConfig(s).mode==='live')fail('Use online checkout; simulated payments are disabled.',403);if((s.checkouts||[]).some(c=>c.visitId===v.id&&c.status==='pending'))fail('Finish the pending online checkout first.',409);const due=bill(s,v).due;if(!int(b.amount,1,due))fail('Payment exceeds the remaining balance or is invalid.',409);const pay={id:uid(),visitId:v.id,kind:'bill',amount:b.amount,at:Date.now()};s.payments.push(pay);event(s,'Test bill payment',v.id);return {...bill(s,v),paymentId:pay.id}}
    if(!['waiter','bill'].includes(b.type))fail('Invalid request');if(!s.requests.some(r=>r.visitId===v.id&&r.type===b.type&&r.status==='open'))s.requests.push({id:uid(),visitId:v.id,tableId:v.tableId,type:b.type,status:'open',created:Date.now()});return {ok:true};
   })}
   const HOST_ACTIONS=['/api/seat','/api/clean','/api/resolve','/api/close','/api/undo-auto-open'];
   const a=auth(s,req,p==='/api/transition'||p==='/api/resolve'?['manager','kitchen','host']:HOST_ACTIONS.includes(p)?['manager','host']:['manager']);
   if(p==='/api/setup')return saveSetup(s,b);
   if(p==='/api/branch'){if(!str(b.name,100)||!str(b.nameAr,100)||!Array.isArray(b.deliveryAreas)||b.deliveryAreas.length>50||b.deliveryAreas.some(x=>!str(x,100))||!['auto','demo','stripe','paymob'].includes(b.paymentProvider))fail('Invalid branch details.');let branch=s.branches.find(x=>x.id===b.id);if(b.id&&!branch)fail('Branch not found.');if(branch?.id==='main'&&!b.active)fail('The primary branch must stay active.');if(!branch){branch={id:uid(),reservations:false};s.branches.push(branch);for(const m of s.menu)m.branchIds.push(branch.id);}Object.assign(branch,{name:b.name,nameAr:b.nameAr,pickup:!!b.pickup,delivery:!!b.delivery,active:!!b.active,deliveryAreas:b.deliveryAreas,paymentProvider:b.paymentProvider});return branch;}
   if(p==='/api/integrations'){const provider=marketplace(s).find(x=>x.id===b.id);if(!provider?.implemented||b.enabled&&!provider.configured)fail('Server credentials required',503);s.integrations[b.id]={...s.integrations[b.id],enabled:!!b.enabled,error:null};event(s,b.enabled?'Integration enabled':'Integration disconnected',b.id);return {ok:true};}
   if(p==='/api/menu-metadata'){const m=s.menu.find(x=>x.id===b.id);if(!m||m.version!==b.version)fail('Menu changed. Refresh before saving.',409);if(typeof b.nameAr!=='string'||b.nameAr.length>100||typeof b.description!=='string'||b.description.length>1000||typeof b.descriptionAr!=='string'||b.descriptionAr.length>1000||!int(b.spice,0,3)||b.prepMinutes!==null&&!int(b.prepMinutes,1,180)||!Array.isArray(b.modifiers)||b.modifiers.length>20)fail('Invalid menu metadata.');const ids=new Set();for(const x of b.modifiers){if(!str(x.id,40)||ids.has(x.id)||!str(x.name,80)||!int(x.price,0,100000)||typeof x.available!=='boolean')fail('Invalid menu option.');ids.add(x.id);}Object.assign(m,{nameAr:b.nameAr,description:b.description,descriptionAr:b.descriptionAr,spice:b.spice,prepMinutes:b.prepMinutes,modifiers:b.modifiers.map(x=>({id:x.id,name:x.name,nameAr:String(x.nameAr||'').slice(0,100),price:x.price,available:x.available,required:!!x.required})),version:m.version+1});return {ok:true};}
   if(p==='/api/menu-import')return idem(s,'menu-import',b.key,b,()=>{const result=importMenu(b.rows??b.csv,s);event(s,'Menu imported','catalog');return result});
   if(p==='/api/floor')return idem(s,'floor-save',b.key,b,()=>{const result=saveFloor(s,b);event(s,'Floor layout saved','restaurant');return result});
   if(p==='/api/seat'){const t=s.tables.find(t=>t.id===b.tableId&&t.active);if(!t||t.cleaning||occupied(s,t))fail('This table is occupied or needs cleaning.',409);const r=b.reservationId?s.reservations.find(r=>r.id===b.reservationId&&r.tableId===t.id&&r.status==='confirmed'):null;if(b.reservationId&&!r)fail('Confirmed reservation not found.');if(r&&(Date.now()<r.start-15*60000||Date.now()>r.start+30*60000))fail('Check-in is available from 15 minutes before to 30 minutes after the reservation.');if(overlap(s,t,Date.now(),Date.now()+(s.settings.duration+s.settings.buffer)*60000,r?.id))fail('An upcoming reservation conflicts with this visit.',409);const v=newVisit(s,'dine-in',t,r?.name||String(b.name||'Walk-in').slice(0,200),r);if(r){r.status='seated';v.reservationId=r.id;}return {...view(s,v),pin:v.pin}}
   if(p==='/api/transition'){const o=s.orders.find(o=>o.id===b.id);if(!o)fail('Order not found');if(o.version!==b.version)fail('Order changed. Refresh and try again.',409);const next={received:'preparing',preparing:'ready',ready:o.type==='dine-in'?'served':o.type==='delivery'?'out_for_delivery':'picked_up',out_for_delivery:'delivered'};if(b.status==='cancelled'){if(a.role!=='manager'||o.status!=='received'||settling(s,s.visits.find(v=>v.id===o.visitId)))fail('Only unstarted orders before settlement can be cancelled.');for(const l of o.lines){const m=s.menu.find(m=>m.id===l.id);m.stock+=l.qty;m.version++;}}else if(next[o.status]!==b.status)fail('Invalid order transition',409);o.status=b.status;o.version++;if(FULFILLED.includes(o.status))o.fulfilledAt=Date.now();event(s,'Order '+b.status,o.id);return o}
   if(p==='/api/resolve'){const r=s.requests.find(r=>r.id===b.id);if(!r)fail('Request not found');r.status='resolved';return {ok:true}}
   if(p==='/api/close'){const v=s.visits.find(v=>v.id===b.id&&v.status==='open');if(!v)fail('Visit is not open');if((s.checkouts||[]).some(c=>c.visitId===v.id&&c.status==='pending'))fail('Reconcile the pending checkout before closing.',409);if(bill(s,v).due||s.orders.some(o=>o.visitId===v.id&&!['served','picked_up','delivered','cancelled'].includes(o.status)))fail('Settle the bill and fulfill all orders before closing.',409);const unused=settleVisit(s,v);event(s,'Visit closed',v.id);return {ok:true,refund:unused}}
   // Undo an auto-opened table while nothing has happened on it yet.
   if(p==='/api/undo-auto-open'){const v=s.visits.find(v=>v.id===b.id&&v.status==='open');if(!v||!v.auto)fail('This visit was not opened automatically.',404);
    if(Date.now()-v.created>AUTO_OPEN_UNDO_MS)fail('This table has been open too long to undo. Close the visit instead.',409);
    if(s.orders.some(o=>o.visitId===v.id)||s.payments.some(x=>x.visitId===v.id))fail('This table already has activity. Close the visit instead.',409);
    v.status='closed';v.closedAt=Date.now();v.undone=true;
    if(v.reservationId){const r=s.reservations.find(r=>r.id===v.reservationId);if(r&&r.status==='seated')r.status='confirmed';}
    event(s,'Auto-opened table released',v.id);return {ok:true}}
   if(p==='/api/clean'){const t=s.tables.find(t=>t.id===b.id);if(!t||occupied(s,t))fail('Table cannot be cleaned yet');t.cleaning=false;t.version++;event(s,'Table cleaned',t.id);return t}
   if(p==='/api/table'){const t=legacyTable(s,b);event(s,'Floor updated',t.id);return t}
   if(p==='/api/menu'){let m=s.menu.find(m=>m.id===b.id);if(b.add){if(!str(b.name,100)||!str(b.category,40)||!str(b.station,40))fail('Enter an item name, category and kitchen station.');m={id:uid(),name:b.name,category:b.category,station:b.station,allergens:[],vegetarian:false,version:0};s.menu.push(m)}else if(!m||m.version!==b.version)fail('Menu changed. Refresh before saving.',409);if(!int(b.price,1,10000000)||!int(b.stock,0,100000))fail('Invalid price or portions');if(b.name!==undefined){if(!str(b.name,100)||!str(b.category,40)||!str(b.station,40)||!Array.isArray(b.allergens)||b.allergens.length>30||b.allergens.some(a=>!str(a,40)))fail('Invalid menu details');Object.assign(m,{name:b.name,category:b.category,station:b.station,allergens:b.allergens,vegetarian:!!b.vegetarian})}Object.assign(m,{price:b.price,stock:b.stock,available:!!b.available,version:m.version+1});event(s,'Menu updated',m.id);return m}
   if(p==='/api/background'){validateImage(b.image);s.settings.background=b.image;s.floor.background.image=b.image;s.floor.revision++;event(s,'Floor background updated','restaurant');return {ok:true}}
   if(p==='/api/reservation-cancel'){const r=s.reservations.find(r=>r.id===b.id);if(!r)fail('Reservation not found.',404);if(!['held','confirmed'].includes(r.status))fail('Only held or confirmed reservations can be cancelled.',409);r.status='cancelled';r.cancelledAt=Date.now();event(s,'Reservation cancelled',r.id);return r;}
   if(p==='/api/settings'){if(!str(b.name,80)||!str(b.branch,80)||!int(b.duration,15,240)||!int(b.buffer,0,60)||!int(b.deposit,0,1000000)||!int(b.deliveryFee,0,100000))fail('Invalid restaurant settings');
    if(b.serviceMode!==undefined&&!['tables','counter','delivery'].includes(b.serviceMode))fail('Choose a valid service model.');
    s.settings={...s.settings,name:b.name,branch:b.branch,duration:b.duration,buffer:b.buffer,deposit:b.deposit,deliveryFee:b.deliveryFee,deliveryEnabled:!!b.deliveryEnabled,
     serviceMode:b.serviceMode||s.settings.serviceMode,reservationsEnabled:b.serviceMode==='tables'?!!b.reservationsEnabled:false};event(s,'Settings updated','restaurant');return s.settings}
   fail('Not found',404);
  });send(result);
 }catch(e){if(!res.headersSent){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'Something went wrong. Please try again.'}))}else res.end();if(!e.status)console.error(e)}};
 const handler=async(req,res)=>{if(!identityProvider||!storage?.withTenant)return handleRequest(req,res);try{const context=await identityProvider.resolve(req,new URL(req.url,origin));req.identity=context.identity;return await storage.withTenant(context.restaurantId,()=>handleRequest(req,res))}catch(e){if(!res.headersSent){res.writeHead(e.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.status?e.message:'Authentication service unavailable.'}))}}};
 const server=http.createServer(handler);
 return {server,handler,db,read,ready};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const port=Number(process.env.PORT)||3000,firebaseEnabled=process.env.FIREBASE_TENANT_MODE==='true',firebase=firebaseEnabled?createFirebasePlatform({projectId:process.env.FIREBASE_PROJECT_ID||'resuto-cf8f5',seedTenant:createTenantSeed,migrateTenant:migrateTenantState}):null;createApp({storage:firebase?.store||null,identityProvider:firebase,...(firebase?{mediaStore:firestoreMediaStore(firebase.firestore.collection('media'))}:{})}).server.listen(port,'0.0.0.0',()=>console.log(`Resuto running at http://localhost:${port}${firebaseEnabled?' with Firebase tenant isolation':''}`));}

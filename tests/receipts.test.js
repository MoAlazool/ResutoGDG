import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';
import {createHmac} from 'node:crypto';

async function setup(t,options={}){
 const app=createApp({dbPath:':memory:',origin:'http://localhost:3000',managerPassword:'manager-test',kitchenPassword:'kitchen-test',...options});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close()});
 const call=async(endpoint,body,credential,extra={})=>{const res=await fetch(base+'/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(credential?.includes('session=')?{Cookie:credential}:credential?{Authorization:'Bearer '+credential}:{}),...extra},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]}};
 const manager=(await call('login',{role:'manager',password:'manager-test'})).cookie;
 const seat=async(tableId='t1')=>{const v=await call('seat',{tableId},manager);const table=(await call('public')).data.tables.find(x=>x.id===tableId);const joined=await call('join',{qr:table.qr,pin:v.data.pin});return {v:v.data,token:joined.data.token}};
 return {...app,call,manager,seat};
}

test('a receipt exists only for a confirmed payment and is scoped to its own visit',async t=>{
 const {call,seat}=await setup(t);const {token}=await seat();const other=await seat('t2');
 await call('order',{lines:[{id:'m0',qty:2,price:14500}],key:'o1'},token);
 // No payment yet: nothing to show, and an unknown payment id is not guessable.
 assert.deepEqual((await call('receipts',undefined,token)).data.receipts,[]);
 assert.equal((await call('receipt?payment=made-up',undefined,token)).status,404);
 const paid=(await call('pay',{amount:29000,key:'p1'},token)).data;
 const mine=await call('receipt?payment='+paid.paymentId,undefined,token);
 assert.equal(mine.status,200);assert.equal(mine.data.status,'paid');
 assert.equal(mine.data.receipt.totals.amount,29000);
 assert.equal(mine.data.receipt.items[0].qty,2);
 assert.equal(mine.data.receipt.visit.table,'T1');
 assert.equal(mine.data.receipt.payment.provider,'demo');
 // Another table's guest cannot read it, and neither can an anonymous caller.
 assert.equal((await call('receipt?payment='+paid.paymentId,undefined,other.token)).status,404);
 assert.equal((await call('receipt?payment='+paid.paymentId)).status,401);
});

test('a provider receipt stays pending until the signed webhook confirms it',async t=>{
 const keys=['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','PAYMENT_MODE'],previous=keys.map(k=>process.env[k]);
 process.env.STRIPE_SECRET_KEY='sk_test_fixture';process.env.STRIPE_WEBHOOK_SECRET='fixture-secret';process.env.PAYMENT_MODE='live';
 t.after(()=>keys.forEach((k,i)=>previous[i]===undefined?delete process.env[k]:process.env[k]=previous[i]));
 const {call,seat}=await setup(t,{paymentFetch:async()=>({ok:true,json:async()=>({id:'cs_fixture',url:'https://checkout.stripe.com/c/fixture'})})});
 const {token}=await seat();await call('order',{lines:[{id:'m0',qty:2,price:14500}],key:'o1'},token);
 const checkout=(await call('checkout',{provider:'stripe',amount:29000,key:'c1'},token)).data;
 assert.ok(checkout.checkoutId,'the client needs an id to watch for confirmation');
 // Redirected back but the webhook has not landed: pending, never a paid receipt.
 const waiting=await call('receipt?checkout='+checkout.checkoutId,undefined,token);
 assert.equal(waiting.data.status,'pending');assert.equal(waiting.data.receipt,null);
 const event={id:'evt_fixture',type:'checkout.session.completed',data:{object:{id:'cs_fixture',payment_status:'paid',amount_total:29000,currency:'egp'}}};
 const stamp=String(Math.floor(Date.now()/1000)),signature=createHmac('sha256','fixture-secret').update(stamp+'.'+JSON.stringify(event)).digest('hex');
 assert.equal((await call('webhooks/stripe',event,null,{'stripe-signature':'t='+stamp+',v1='+signature})).status,200);
 const settled=await call('receipt?checkout='+checkout.checkoutId,undefined,token);
 assert.equal(settled.data.status,'paid');
 assert.equal(settled.data.receipt.totals.amount,29000);
 assert.equal(settled.data.receipt.payment.provider,'stripe');
 assert.equal(settled.data.receipt.payment.mode,'live');
 // Re-reading is safe: polling or refreshing never creates a second payment.
 assert.equal((await call('receipt?checkout='+checkout.checkoutId,undefined,token)).data.receipt.paymentId,settled.data.receipt.paymentId);
 assert.equal((await call('receipts',undefined,token)).data.receipts.length,1);
});

test('deposit and share receipts report their own context and stay pending until paid',async t=>{
 const {call,seat}=await setup(t);
 const reservation=(await call('reserve',{tableId:'t3',party:3,name:'Guest',contact:'fictional',start:Date.now()+3600000,key:'r1'})).data;
 assert.equal((await call('receipt?reservation='+reservation.token)).data.status,'pending');
 await call('deposit',{token:reservation.token,key:'d1'});
 const deposit=(await call('receipt?reservation='+reservation.token)).data;
 assert.equal(deposit.status,'paid');assert.equal(deposit.receipt.kind,'deposit');
 assert.equal(deposit.receipt.reservation.party,3);
 assert.equal(deposit.receipt.reservation.table,'T3');
 assert.equal(deposit.receipt.totals.deposit,deposit.receipt.totals.total);

 const {token}=await seat();await call('order',{lines:[{id:'m0',qty:4,price:14500}],key:'o1'},token);
 await call('split',{method:'equal',people:2,names:['Sara','Omar'],key:'s1'},token);
 const shareUrl=(await call('visit',undefined,token)).data.split.shares[0].url,shareToken=shareUrl.split('/').pop();
 assert.equal((await call('receipt?share='+shareToken)).data.status,'pending');
 await call('share-pay',{token:shareToken,name:'Sara',key:'sp1'});
 const share=(await call('receipt?share='+shareToken)).data;
 assert.equal(share.status,'paid');assert.equal(share.receipt.kind,'share');
 assert.equal(share.receipt.split.participants,2);
 assert.equal(share.receipt.split.paidCount,1);
 assert.equal(share.receipt.totals.amount,29000);
 assert.equal(share.receipt.totals.due,29000,'the other half is still owed');
});

test('the front desk role can seat and clear tables but never touches money, menu or layout',async t=>{
 const app=createApp({dbPath:':memory:',origin:'http://localhost:3000',managerPassword:'manager-test',kitchenPassword:'kitchen-test',hostPassword:'host-test'});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close()});
 const call=async(endpoint,body,credential)=>{const res=await fetch(base+'/api/'+endpoint,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(credential?{Cookie:credential}:{})},body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]}};
 const host=(await call('login',{role:'host',password:'host-test'})).cookie;
 assert.ok(host,'the host role can sign in');
 assert.equal((await call('login',{role:'host',password:'manager-test'})).status,401);

 // Sees the live board, including today's bookings, so guests can be checked in.
 const board=(await call('staff',undefined,host)).data;
 assert.equal(board.role,'host');
 assert.ok(Array.isArray(board.reservations),'host needs reservations to check guests in');
 assert.equal(board.analytics,null,'but not the revenue analytics');

 // Front-of-house actions are allowed.
 const seated=await call('seat',{tableId:'t1',name:'Walk-in'},host);
 assert.equal(seated.status,200);
 assert.equal((await call('close',{id:seated.data.id},host)).status,200);
 assert.equal((await call('clean',{id:'t1'},host)).status,200);

 // Everything that moves money, the menu, the layout or the business stays out.
 for(const [endpoint,body] of [
  ['menu',{id:'m0',price:1,stock:1,available:true,version:0}],
  ['settings',{name:'x',branch:'y',duration:60,buffer:10,deposit:0,deliveryFee:0}],
  ['floor',{baseRevision:0,layout:{},key:'k'}],
  ['branch',{name:'x',nameAr:'x',deliveryAreas:[],paymentProvider:'auto',active:true}],
  ['menu-import',{rows:[],key:'k'}],
  ['integrations',{id:'foodics',enabled:true}],
 ])assert.equal((await call(endpoint,body,host)).status,401,endpoint+' must stay manager-only');
 assert.equal((await call('export?kind=payments',undefined,host)).status,401);
});

test('the service model decides how guests can order at all',async t=>{
 const {call,manager,read}=await setup(t);
 const base={name:'Cloud Kitchen',branch:'Nasr City',duration:90,buffer:15,deposit:0,deliveryFee:3500,deliveryEnabled:true};
 assert.equal(read().settings.serviceMode,'tables','table service is the default');
 assert.equal((await call('settings',{...base,serviceMode:'nonsense'},manager)).status,400);

 // --- counter: one venue QR, a fresh order per guest, no reservations -------
 assert.equal((await call('settings',{...base,serviceMode:'counter'},manager)).status,200);
 assert.equal(read().settings.reservationsEnabled,false,'counter service cannot take bookings');
 assert.equal((await call('reserve',{tableId:'t1',party:2,name:'G',contact:'c',start:Date.now()+3600000,key:'r1'})).status,409);
 const venueQr=read().settings.venueQr;
 const tableQr=(await call('public')).data.tables[0].qr;
 assert.equal((await call('table-session',{qr:tableQr})).status,404,'table QRs stop working in counter mode');
 const first=(await call('table-session',{qr:venueQr})).data;
 assert.ok(first.token&&first.counter===true);
 // Two different guests at the counter get two separate orders...
 const second=(await call('table-session',{qr:venueQr})).data;
 assert.notEqual(second.token,first.token);
 // ...but the same guest re-scanning or refreshing rejoins their own.
 const again=(await call('table-session',{qr:venueQr},first.token)).data;
 assert.equal(again.token,first.token,'a refresh must not open a second order');
 assert.equal((await call('order',{lines:[{id:'m0',qty:1,price:14500}],key:'o1'},first.token)).status,200);

 // --- delivery only: nothing on site, online orders still work -------------
 assert.equal((await call('settings',{...base,serviceMode:'delivery'},manager)).status,200);
 assert.equal((await call('table-session',{qr:venueQr})).status,409);
 assert.equal((await call('online-order',{branchId:'main',type:'pickup',name:'G',contact:'c',payment:'demo',lines:[{id:'m0',qty:1,options:[],price:14500}],key:'online'})).status,200);

 // --- back to tables: reservations can be turned on again ------------------
 assert.equal((await call('settings',{...base,serviceMode:'tables',reservationsEnabled:true},manager)).status,200);
 assert.equal((await call('table-session',{qr:tableQr})).status,200);
 assert.equal((await call('reserve',{tableId:'t2',party:2,name:'G',contact:'c',start:Date.now()+3600000,key:'r2'})).status,200);
 // ...and off, which closes bookings without touching the floor.
 assert.equal((await call('settings',{...base,serviceMode:'tables',reservationsEnabled:false},manager)).status,200);
 assert.equal((await call('reserve',{tableId:'t3',party:2,name:'G',contact:'c',start:Date.now()+3600000,key:'r3'})).status,409);
 assert.equal((await call('table-session',{qr:tableQr})).status,200,'tables still work without bookings');
});

test('a counter venue can be ordered from through its own single link',async t=>{
 const {call,manager,read}=await setup(t);
 const base={name:'Kiosk',branch:'Downtown',duration:90,buffer:15,deposit:0,deliveryFee:3500,deliveryEnabled:true};
 assert.equal((await call('settings',{...base,serviceMode:'counter'},manager)).status,200);
 const venueQr=read().settings.venueQr;
 assert.ok(venueQr,'counter service needs a venue QR to hand out');

 // The one link opens an order — this used to 500 because a counter visit was
 // stored with tableId undefined, which Firestore rejects outright.
 const opened=await call('table-session',{qr:venueQr});
 assert.equal(opened.status,200);
 assert.equal(opened.data.counter,true);
 assert.equal(opened.data.tableId,null,'a counter visit has no table, and must say so as null');
 assert.ok(opened.data.token);

 // No undefined may reach the store, or the Firestore backend cannot persist it.
 const visit=read().visits.find(v=>v.token===opened.data.token);
 for(const [k,v] of Object.entries(visit))assert.notEqual(v,undefined,`visit.${k} must not be undefined`);

 // And the link actually takes an order.
 assert.equal((await call('order',{lines:[{id:'m0',qty:1,price:14500}],key:'c1'},opened.data.token)).status,200);
 assert.equal(read().orders.filter(o=>o.visitId===visit.id).length,1);
});

test('a counter order is an on-site order, not a pickup, and reaches the cashier',async t=>{
 const {call,manager,read}=await setup(t);
 await call('settings',{name:'Kiosk',branch:'Downtown',duration:90,buffer:15,deposit:0,deliveryFee:3500,deliveryEnabled:true,serviceMode:'counter'},manager);
 const {token}=(await call('table-session',{qr:read().settings.venueQr})).data;
 const visit=()=>read().visits.find(v=>v.token===token);

 // The guest is standing in the venue: no fulfilment choice applies, and the
 // visit must not be mislabelled as a remote pickup.
 assert.equal(visit().type,'counter');
 assert.equal(visit().fee,0,'an on-site order never carries a delivery fee');

 const order=(await call('order',{lines:[{id:'m0',qty:1,price:14500}],key:'c1'},token)).data;
 assert.ok(order.number,'the guest needs a number to quote at the till');
 assert.equal(order.type,'counter');

 // Paying at the counter raises a bill request the staff can see and settle.
 assert.equal((await call('request',{type:'bill',method:'cash',key:'cash1'},token)).status,200);
 const open=read().requests.filter(r=>r.visitId===visit().id&&r.type==='bill'&&r.status==='open');
 assert.equal(open.length,1);
 // Asking to pay at the till must not stop the guest adding more.
 assert.equal((await call('order',{lines:[{id:'m1',qty:1,price:9500}],key:'c2'},token)).status,200);

 // The kitchen advances a counter order to collection, never "out for delivery".
 const kitchen=(await call('login',{role:'kitchen',password:'kitchen-test'})).cookie;
 let o=order;
 for(const status of ['preparing','ready'])o=(await call('transition',{id:o.id,version:o.version,status},kitchen)).data;
 o=(await call('transition',{id:o.id,version:o.version,status:'picked_up'},kitchen)).data;
 assert.equal(o.status,'picked_up','a counter order is collected, not delivered');
});

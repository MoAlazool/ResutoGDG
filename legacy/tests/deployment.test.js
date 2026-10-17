import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../server.js';
import {memoryMediaStore} from '../media-store.js';

// Deployment guarantees, independent of which store backs them: two instances
// must agree on one dataset, concurrent writes must not lose or duplicate work,
// and a throwing handler must leave nothing behind.
//
// Firestore itself is exercised for real by `npm run test:firebase`, which runs
// against the emulators declared in firebase.json. This file pins the contract
// that any storage adapter behind createApp() has to satisfy.
function sharedStore(){
 let state=null;let queue=Promise.resolve();
 return {
  async initialize(seed,migrate){if(state)return;const next=typeof seed==='function'?seed():structuredClone(seed);await migrate?.(next);state=next;},
  async read(){if(!state)throw Object.assign(new Error('Restaurant data is not initialized.'),{status:404});return structuredClone(state);},
  // Serialised like a real transaction, and only committed if fn() succeeds.
  transaction(fn){const run=queue.then(async()=>{const draft=structuredClone(state);const result=await fn(draft);state=draft;return result;});
   queue=run.catch(()=>{});return run;},
 };
}

test('two instances share one dataset, write atomically, and roll back cleanly',async()=>{
 const storage=sharedStore(),options={storage,origin:'https://resuto.example',managerPassword:'manager-test',kitchenPassword:'kitchen-test',mediaStore:memoryMediaStore()};
 const a=createApp(options);await a.ready;
 const b=createApp(options);await b.ready;

 // A second instance starting cold must adopt the existing restaurant, not reseed it.
 const first=await a.read();
 assert.deepEqual((await b.read()).tables.map(t=>t.qr),first.tables.map(t=>t.qr));

 const call=async(app,path,body,cookie,token)=>{
  return new Promise(resolve=>{
   const chunks=[];const headers={};
   const response={writeHead(status,h){this.statusCode=status;Object.assign(headers,h)},setHeader(k,v){headers[k]=v},
    end(chunk){if(chunk)chunks.push(chunk);resolve({status:this.statusCode||200,headers,data:JSON.parse(chunks.join('')||'{}')})},headersSent:false};
   const request={method:body?'POST':'GET',url:path,socket:{remoteAddress:'127.0.0.1'},
    headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...(token?{authorization:'Bearer '+token}:{})},
    [Symbol.asyncIterator](){let sent=false;return {next:async()=>sent?{done:true}:(sent=true,{value:JSON.stringify(body||{}),done:false})}}};
   app.handler(request,response);
  });
 };

 const login=await call(a,'/api/login',{role:'manager',password:'manager-test'});
 assert.equal(login.status,200);
 const cookie=String(login.headers['Set-Cookie']).split(';')[0];
 await call(a,'/api/seat',{tableId:'t1'},cookie);
 const session=await call(a,'/api/table-session',{qr:first.tables[0].qr});
 assert.ok(session.data.token);

 // Two orders race for the last portions through two different instances.
 const orders=await Promise.all([
  call(a,'/api/order',{lines:[{id:'m0',qty:10,price:14500}],key:'one'},null,session.data.token),
  call(b,'/api/order',{lines:[{id:'m0',qty:10,price:14500}],key:'two'},null,session.data.token),
 ]);
 assert.deepEqual(orders.map(r=>r.status).sort(),[200,409],'exactly one order may take the stock');
 assert.equal((await b.read()).menu[0].stock,8);
 assert.equal((await b.read()).orders.length,1,'the losing order must leave no trace');

 // A handler that throws must not commit a partial write.
 await assert.rejects(storage.transaction(s=>{s.menu[0].stock=0;throw Error('rollback')}));
 assert.equal((await a.read()).menu[0].stock,8);
});

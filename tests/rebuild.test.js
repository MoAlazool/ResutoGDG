import test from 'node:test';
import assert from 'node:assert/strict';
import {createSplit, payShare, billFor} from '../platform-domain.js';
import {validateSources, aiCapabilities, geminiImage} from '../gemini-provider.js';
import {memoryMediaStore} from '../media-store.js';
import {createApp} from '../server.js';

function splitState({total=1001,fee=0,credit=0,paid=0}={}){
  const visit={id:'visit-1',status:'open',branchId:'main',fee,credit,locked:false};
  return {visit,state:{settings:{name:'The Olive Room'},branches:[{id:'main',name:'Main'}],visits:[visit],orders:[{id:'order-1',visitId:visit.id,status:'served',total,lines:[{id:'main-a',name:'Main A',qty:2,price:300},{id:'main-b',name:'Main B',qty:1,price:total-600}]}],payments:paid?[{id:'paid-1',visitId:visit.id,kind:'bill',amount:paid}]:[],splits:[],shares:[],checkouts:[]}};
}

test('equal and custom splits preserve every minor unit',()=>{
  const equal=splitState(),view=createSplit(equal.state,equal.visit,{method:'equal',people:3},'https://example.test');
  assert.deepEqual(view.shares.map(x=>x.amount),[334,334,333]);
  assert.equal(view.shares.reduce((n,x)=>n+x.amount,0),billFor(equal.state,equal.visit).due);

  const custom=splitState({total:1200});
  assert.throws(()=>createSplit(custom.state,custom.visit,{method:'custom',amounts:[300,899]},'https://example.test'),/add up/);
  const customView=createSplit(custom.state,custom.visit,{method:'custom',amounts:[300,900]},'https://example.test');
  assert.deepEqual(customView.shares.map(x=>x.amount),[300,900]);
});

test('item splits require one immutable allocation per ordered unit and apportion adjustments',()=>{
  const {state,visit}=splitState({total:1000,fee:100,credit:50,paid:50});
  const allocations=[
    {items:[{orderId:'order-1',lineIndex:0,unit:0},{orderId:'order-1',lineIndex:1,unit:0}]},
    {items:[{orderId:'order-1',lineIndex:0,unit:1}]}
  ];
  const view=createSplit(state,visit,{method:'items',allocations},'https://example.test');
  assert.equal(view.total,1000);
  assert.equal(view.shares.reduce((n,x)=>n+x.amount,0),1000);
  assert.equal(view.allocations.flatMap(x=>x.items).length,3);
  allocations[0].items.length=0;
  assert.equal(view.allocations[0].items.length,2);

  const invalid=splitState({total:1000});
  assert.throws(()=>createSplit(invalid.state,invalid.visit,{method:'items',allocations:[{items:[{orderId:'order-1',lineIndex:0,unit:0}]},{items:[{orderId:'order-1',lineIndex:0,unit:0}]}]},'https://example.test'),/exactly once/);
});

test('a completed share set closes its split and duplicate payment stays idempotent',()=>{
  const {state,visit}=splitState({total:1200});
  const split=createSplit(state,visit,{method:'equal',people:2,names:['Ahmed','Mona']},'https://example.test');
  const first=state.shares.find(x=>x.id===split.shares[0].id),second=state.shares.find(x=>x.id===split.shares[1].id);
  payShare(state,first,{name:'Ahmed'});
  payShare(state,first,{name:'Ahmed'});
  assert.equal(state.payments.length,1);
  payShare(state,second,{name:'Mona'});
  assert.equal(state.splits[0].status,'complete');
  assert.equal(billFor(state,visit).due,0);
});

test('AI source validation enforces type, per-source and combined limits without writing state',()=>{
  assert.throws(()=>validateSources({sources:Array(7).fill({mime:'text/plain',text:'menu'})}),/one and six/);
  assert.throws(()=>validateSources({sources:[{mime:'application/zip',data:'YQ=='}]}),/PDF/);
  assert.throws(()=>validateSources({sources:[{mime:'image/png',data:'A'.repeat(4_000_004)}]}),/3 MB/);
  const sources=validateSources({sources:[{name:'menu.txt',mime:'text/plain',text:'Soup 80'}]});
  assert.deepEqual(sources,[{name:'menu.txt',mime:'text/plain',text:'Soup 80'}]);
});

test('AI capability reporting is sanitized and image generation fails clearly when unconfigured',async()=>{
  const old={key:process.env.GEMINI_API_KEY,image:process.env.GEMINI_IMAGE_MODEL};
  delete process.env.GEMINI_API_KEY;delete process.env.GEMINI_IMAGE_MODEL;
  try{
    const caps=aiCapabilities();
    assert.equal(caps.configured,false);
    assert.equal(caps.imageGeneration,false);
    assert.equal(JSON.stringify(caps).includes('API_KEY'),false);
    await assert.rejects(geminiImage({prompt:'dish'}),error=>error.status===503&&/not configured/.test(error.message));
  }finally{
    if(old.key===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old.key;
    if(old.image===undefined)delete process.env.GEMINI_IMAGE_MODEL;else process.env.GEMINI_IMAGE_MODEL=old.image;
  }
});

test('manager media upload is authorized, referenced publicly, and served through the adapter',async t=>{
  const mediaStore=memoryMediaStore(),app=createApp({dbPath:':memory:',origin:'http://localhost:3000',managerPassword:'manager-test',kitchenPassword:'kitchen-test',mediaStore});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();});
  const call=async(path,body,cookie)=>{const response=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  assert.equal((await call('menu-image',{menuItemId:'m0',mime:'image/webp',data:'AA=='})).status,401);
  const manager=(await call('login',{role:'manager',password:'manager-test'})).cookie;
  const uploaded=await call('menu-image',{menuItemId:'m0',mime:'image/webp',data:'AA=='},manager);
  assert.equal(uploaded.status,200);
  assert.match(uploaded.data.url,/^\/media\/menu-m0-/);
  const publicData=(await call('public')).data;
  assert.equal(publicData.menu.find(x=>x.id==='m0').imageUrl,uploaded.data.url);
  const media=await fetch(base+uploaded.data.url);
  assert.equal(media.status,200);
  assert.equal(media.headers.get('content-type'),'image/webp');
  assert.deepEqual([...new Uint8Array(await media.arrayBuffer())],[0]);
});

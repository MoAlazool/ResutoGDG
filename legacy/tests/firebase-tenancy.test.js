import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createApp,createTenantSeed,migrateTenantState} from '../server.js';
import {createFirebasePlatform} from '../firebase-platform.js';

const enabled=Boolean(process.env.FIRESTORE_EMULATOR_HOST&&process.env.FIREBASE_AUTH_EMULATOR_HOST);
const projectId=process.env.FIREBASE_PROJECT_ID||'resuto-cf8f5';

async function authRequest(method,body){
 const base=`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:${method}?key=local-test`;
 const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const data=await response.json();
 assert.equal(response.ok,true,JSON.stringify(data));
 return data;
}

test('Firebase accounts isolate restaurant state, roles and direct Firestore access',{skip:!enabled},async t=>{
 const firebase=createFirebasePlatform({projectId,seedTenant:createTenantSeed,migrateTenant:migrateTenantState});
 const app=createApp({storage:firebase.store,identityProvider:firebase,origin:'http://127.0.0.1'});
 await app.ready;
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${app.server.address().port}`;
 t.after(()=>new Promise(resolve=>app.server.close(resolve)));

 const suffix=randomUUID().slice(0,8);
 const first=await authRequest('signUp',{email:`first-${suffix}@example.test`,password:'test-password-1',returnSecureToken:true});
 const second=await authRequest('signUp',{email:`second-${suffix}@example.test`,password:'test-password-2',returnSecureToken:true});
 const call=async(endpoint,{token,method='GET',body,restaurantId,role}={})=>{
  const response=await fetch(`${base}/api/${endpoint}`,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(restaurantId?{'X-Restaurant-ID':restaurantId}:{}),...(role?{'X-Workspace-Role':role}:{}),...(method==='POST'?{Origin:'http://127.0.0.1'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
 };
 const provision=async(token,name,slug)=>call('account/bootstrap',{token,method:'POST',body:{name,slug,branch:'Main branch',plan:'growth'}});
 const one=await provision(first.idToken,'Tenant One',`tenant-one-${suffix}`),two=await provision(second.idToken,'Tenant Two',`tenant-two-${suffix}`);
 assert.equal(one.status,201);assert.equal(two.status,201);

 const staffOne=await call('staff',{token:first.idToken,restaurantId:one.data.restaurantId,role:'manager'});
 const staffTwo=await call('staff',{token:second.idToken,restaurantId:two.data.restaurantId,role:'manager'});
 assert.equal(staffOne.status,200);assert.equal(staffTwo.status,200);
 assert.equal(staffOne.data.settings.name,'Tenant One');assert.equal(staffTwo.data.settings.name,'Tenant Two');

 const changed=await call('settings',{token:first.idToken,restaurantId:one.data.restaurantId,role:'manager',method:'POST',body:{...staffOne.data.settings,name:'Tenant One Updated',duration:90,buffer:15,deposit:0,deliveryFee:0,serviceMode:'tables'}});
 assert.equal(changed.status,200);
 const unchanged=await call('staff',{token:second.idToken,restaurantId:two.data.restaurantId,role:'manager'});
 assert.equal(unchanged.data.settings.name,'Tenant Two');
 assert.equal((await call('staff',{token:first.idToken,restaurantId:two.data.restaurantId,role:'manager'})).status,403,'an owner cannot select another tenant ID');

 const invited=await call('account/invite',{token:first.idToken,restaurantId:one.data.restaurantId,method:'POST',body:{name:'Kitchen User',email:`kitchen-${suffix}@example.test`,password:'test-password-3',role:'kitchen'}});
 assert.equal(invited.status,201);
 const kitchen=await authRequest('signInWithPassword',{email:invited.data.email,password:'test-password-3',returnSecureToken:true});
 assert.equal((await call('staff',{token:kitchen.idToken,restaurantId:one.data.restaurantId,role:'kitchen'})).status,200);
 assert.equal((await call('staff',{token:kitchen.idToken,restaurantId:one.data.restaurantId,role:'manager'})).status,403,'kitchen users cannot elevate their workspace role');

 const firestoreBase=`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${projectId}/databases/(default)/documents`;
 const direct=async path=>fetch(`${firestoreBase}/${path}`,{headers:{Authorization:`Bearer ${first.idToken}`}});
 assert.equal((await direct(`restaurants/${one.data.restaurantId}`)).status,200,'members may read safe restaurant metadata');
 assert.equal((await direct(`restaurants/${one.data.restaurantId}/private/state`)).status,403,'operational state stays server-only');
 assert.equal((await direct(`restaurants/${two.data.restaurantId}`)).status,403,'rules deny another restaurant metadata');
});

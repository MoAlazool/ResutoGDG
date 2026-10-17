import {AsyncLocalStorage} from 'node:async_hooks';
import {getApps,initializeApp,applicationDefault,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {FieldValue,getFirestore} from 'firebase-admin/firestore';
import {randomBytes} from 'node:crypto';

const DEMO_RESTAURANT_ID='olive-room-demo';
const cleanId=value=>String(value||'').toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,48);
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
// Firestore refuses `undefined`; the SQLite backend drops it via JSON.stringify.
// Round-tripping here keeps the two stores byte-compatible, so behaviour never
// diverges between local development and a deployed tenant.
const storable=state=>JSON.parse(JSON.stringify(state));

export class FirestoreTenantStore{
 constructor(firestore,{demoRestaurantId=DEMO_RESTAURANT_ID}={}){this.db=firestore;this.demoRestaurantId=demoRestaurantId;this.context=new AsyncLocalStorage();
  // Every request used to cost a Firestore round trip — including static assets
  // and the 2-second /api/events poll. Each tenant now keeps its state in
  // memory, refreshed by a snapshot listener, so reads are local and writes
  // from any instance still land here within one push.
  this.cache=new Map();
 }
 // Resolves once the tenant's listener has delivered its first snapshot.
 watch(restaurantId=this.tenantId()){
  let entry=this.cache.get(restaurantId);
  if(entry)return entry.ready;
  entry={state:null,revision:-1,updateTime:null,ready:null,stop:null};
  entry.ready=new Promise((resolve,reject)=>{
   entry.stop=this.stateRef(restaurantId).onSnapshot(snapshot=>{
    if(!snapshot.exists){entry.state=null;entry.revision=-1;entry.updateTime=null;}
    else{const data=snapshot.data();entry.state=data.state;entry.revision=data.revision||0;entry.updateTime=snapshot.updateTime;}
    resolve();
   },error=>{this.cache.delete(restaurantId);reject(error);});
  });
  this.cache.set(restaurantId,entry);
  return entry.ready;
 }
 // Writers publish straight into the cache so the very next read is correct,
 // without waiting for the listener to echo the change back.
 prime(restaurantId,state,revision,updateTime){
  const entry=this.cache.get(restaurantId);
  if(entry){entry.state=state;entry.revision=revision;if(updateTime)entry.updateTime=updateTime;}
 }
 stopWatching(){for(const entry of this.cache.values())entry.stop?.();this.cache.clear();}
 revisionOf(restaurantId=this.tenantId()){return this.cache.get(restaurantId)?.revision??-1}
 withTenant(restaurantId,fn){return this.context.run({restaurantId},fn)}
 tenantId(){return this.context.getStore()?.restaurantId||this.demoRestaurantId}
 stateRef(restaurantId=this.tenantId()){return this.db.doc(`restaurants/${restaurantId}/private/state`)}
 async initialize(seed,migrate){await this.initializeTenant(this.demoRestaurantId,seed,migrate,{name:'The Olive Room',slug:'olive-room',demo:true})}
 async initializeTenant(restaurantId,seed,migrate,meta={}){
  const ref=this.stateRef(restaurantId);
  await this.db.runTransaction(async transaction=>{const snapshot=await transaction.get(ref);if(snapshot.exists)return;const state=typeof seed==='function'?seed():structuredClone(seed);await migrate?.(state);transaction.set(ref,{state:storable(state),revision:0,updatedAt:FieldValue.serverTimestamp()});transaction.set(this.db.doc(`restaurants/${restaurantId}`),{name:meta.name||state.settings?.name||'Restaurant',slug:meta.slug||restaurantId,demo:!!meta.demo,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});});
 }
 async read(){
  const restaurantId=this.tenantId();
  await this.watch(restaurantId);
  const entry=this.cache.get(restaurantId);
  if(!entry?.state)throw Object.assign(new Error('Restaurant data is not initialized.'),{status:404});
  return entry.state;
 }
  // A Firestore transaction costs two round trips: read, then commit. The
 // snapshot listener already holds a current copy, so a write can be a single
 // conditional commit guarded by the document's last update time. If another
 // instance committed first the precondition fails and we retry against the
 // refreshed state — the same all-or-nothing guarantee, at half the latency.
 async transaction(fn,attempt=0){
  const restaurantId=this.tenantId(),ref=this.stateRef(restaurantId);
  await this.watch(restaurantId);
  // Attempt 0 trusts the listener's copy; a contended retry re-reads so it
  // cannot spin against a stale precondition.
  const entry=this.cache.get(restaurantId);
  let base=attempt===0&&entry?.state&&entry.updateTime
   ?{state:entry.state,revision:entry.revision,updateTime:entry.updateTime}
   :await this.snapshotOf(ref);
  if(!base)throw Object.assign(new Error('Restaurant data is not initialized.'),{status:404});
  const state=structuredClone(base.state),result=await fn(state);
  const next=storable(state),revision=(base.revision||0)+1;
  try{
   const write=await ref.update({state:next,revision,updatedAt:FieldValue.serverTimestamp()},{lastUpdateTime:base.updateTime});
   this.prime(restaurantId,next,revision,write.writeTime);
  }catch(error){
   // FAILED_PRECONDITION (code 9) means another instance committed first.
   if(error?.code!==9||attempt>=4)throw error;
   return this.transaction(fn,attempt+1);
  }
  return result;
 }
 async snapshotOf(ref){const snapshot=await ref.get();return snapshot.exists?{state:snapshot.data().state,revision:snapshot.data().revision||0,updateTime:snapshot.updateTime}:null}
}

export function createFirebasePlatform({projectId='resuto-cf8f5',seedTenant,migrateTenant}={}){
 // Locally the ambient gcloud/ADC credential is used. A hosted runtime has no
 // such credential, so FIREBASE_SERVICE_ACCOUNT carries the service-account JSON
 // (or a base64 copy of it, which survives single-line env var editors).
 const serviceAccount=()=>{
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT;
  if(!raw)return null;
  const text=raw.trim().startsWith('{')?raw:Buffer.from(raw,'base64').toString('utf8');
  try{return JSON.parse(text)}catch{throw Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON or base64-encoded JSON.')}
 };
 const hostedCredential=serviceAccount();
 const app=getApps()[0]||initializeApp({credential:hostedCredential?cert(hostedCredential):applicationDefault(),projectId:hostedCredential?.project_id||projectId});
 const db=getFirestore(app),firebaseAuth=getAuth(app),store=new FirestoreTenantStore(db);
 const verify=async req=>{const header=String(req.headers.authorization||'');if(!header.startsWith('Bearer ')||header.slice(7).split('.').length!==3)fail('Sign in to your restaurant account.',401);try{return await firebaseAuth.verifyIdToken(header.slice(7),true)}catch{fail('Your sign-in has expired. Please sign in again.',401)}};
 const memberships=async uid=>{const snapshot=await db.collection(`users/${uid}/memberships`).get();return snapshot.docs.map(doc=>({restaurantId:doc.id,...doc.data()}));};
 const membershipFor=async(uid,restaurantId)=>{const snapshot=await db.doc(`users/${uid}/memberships/${restaurantId}`).get();return snapshot.exists?{restaurantId,...snapshot.data()}:null};
 const roleFor=(membership,requested)=>{const role=membership.role||'manager';if(role==='owner')return ['manager','kitchen','host'].includes(requested)?requested:'manager';if(role==='manager')return ['manager','kitchen','host'].includes(requested)?requested:'manager';if(requested&&requested!==role)fail('This account does not have access to that workspace.',403);return role};
 const resolve=async(req,url)=>{
  const isAccount=url.pathname.startsWith('/api/account');
  const bearer=String(req.headers.authorization||'').slice(7);
  if(bearer.split('.').length===3){const decoded=await verify(req);if(isAccount&&url.pathname==='/api/account/bootstrap')return {restaurantId:DEMO_RESTAURANT_ID,identity:{uid:decoded.uid,email:decoded.email||'',role:'owner',unprovisioned:true}};
   const requestedRestaurant=cleanId(req.headers['x-restaurant-id']);let membership=requestedRestaurant?await membershipFor(decoded.uid,requestedRestaurant):null;
   if(requestedRestaurant&&!membership)fail('This account does not have access to that restaurant.',403);
   if(!membership){const rows=await memberships(decoded.uid);if(!rows.length){if(isAccount)return {restaurantId:DEMO_RESTAURANT_ID,identity:{uid:decoded.uid,email:decoded.email||'',role:'owner',unprovisioned:true}};fail('No restaurant account is linked to this user.',403)}membership=rows[0];}
   const requestedRole=String(req.headers['x-workspace-role']||'');return {restaurantId:membership.restaurantId,identity:{uid:decoded.uid,email:decoded.email||membership.email||'',name:decoded.name||membership.name||'',role:roleFor(membership,requestedRole),membershipRole:membership.role,restaurantId:membership.restaurantId}};
  }
  const slug=cleanId(req.headers['x-restaurant-slug']||url.searchParams.get('restaurant'));
  if(slug){const match=await db.doc(`restaurantSlugs/${slug}`).get();if(!match.exists)fail('Restaurant not found.',404);return {restaurantId:match.data().restaurantId,identity:null};}
  return {restaurantId:DEMO_RESTAURANT_ID,identity:null};
 };
 const account=async identity=>{if(!identity)fail('Sign in to continue.',401);const rows=await memberships(identity.uid);const restaurantDocs=await Promise.all(rows.map(row=>db.doc(`restaurants/${row.restaurantId}`).get()));return {user:{uid:identity.uid,email:identity.email,name:identity.name||''},memberships:rows.map((row,index)=>({restaurantId:row.restaurantId,role:row.role,...restaurantDocs[index].data()}))};};
 const bootstrap=async(identity,input)=>{if(!identity)fail('Sign in to continue.',401);const name=String(input.name||'').trim(),branch=String(input.branch||'').trim(),plan=String(input.plan||'growth');if(name.length<2||name.length>80||branch.length<2||branch.length>80)fail('Enter the restaurant and first branch names.');if(!['starter','growth','pro','business'].includes(plan))fail('Choose a valid plan.');let slug=cleanId(input.slug||name);if(slug.length<3)slug=`restaurant-${randomBytes(3).toString('hex')}`;const restaurantId=`${slug}-${randomBytes(4).toString('hex')}`;
  await db.runTransaction(async transaction=>{const slugRef=db.doc(`restaurantSlugs/${slug}`),slugDoc=await transaction.get(slugRef);if(slugDoc.exists)fail('That restaurant URL is already taken.',409);transaction.set(slugRef,{restaurantId,createdAt:FieldValue.serverTimestamp()});transaction.set(db.doc(`restaurants/${restaurantId}`),{name,slug,plan,subscription:{status:'trialing',trialEndsAt:Date.now()+14*86400000},createdBy:identity.uid,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()});transaction.set(db.doc(`users/${identity.uid}`),{email:identity.email||'',name:identity.name||'',lastRestaurantId:restaurantId,updatedAt:FieldValue.serverTimestamp()},{merge:true});transaction.set(db.doc(`users/${identity.uid}/memberships/${restaurantId}`),{role:'owner',email:identity.email||'',name:identity.name||'',createdAt:FieldValue.serverTimestamp()});});
  const state=seedTenant({name,branch,plan,ownerUid:identity.uid,slug});state.settings.publicSlug=slug;state.settings.publicPath=`/restaurant?restaurant=${encodeURIComponent(slug)}`;await store.initializeTenant(restaurantId,state,migrateTenant,{name,slug});return {restaurantId,slug,role:'owner'};
 };
 const invite=async(identity,input)=>{if(!identity||!['owner','manager'].includes(identity.membershipRole||identity.role))fail('Only restaurant managers can add staff.',403);const email=String(input.email||'').trim().toLowerCase(),password=String(input.password||''),name=String(input.name||'').trim(),role=String(input.role||'');if(!/^\S+@\S+\.\S+$/.test(email)||password.length<8||name.length<2||!['manager','kitchen','host'].includes(role))fail('Enter a valid staff name, email, role and password of at least 8 characters.');let user;try{user=await firebaseAuth.createUser({email,password,displayName:name,emailVerified:false})}catch(error){if(error.code==='auth/email-already-exists')user=await firebaseAuth.getUserByEmail(email);else throw error}const ref=db.doc(`users/${user.uid}/memberships/${identity.restaurantId}`);if((await ref.get()).exists)fail('This staff member already belongs to the restaurant.',409);await db.runTransaction(async transaction=>{transaction.set(db.doc(`users/${user.uid}`),{email,name,lastRestaurantId:identity.restaurantId,updatedAt:FieldValue.serverTimestamp()},{merge:true});transaction.set(ref,{role,email,name,invitedBy:identity.uid,createdAt:FieldValue.serverTimestamp()});});return {uid:user.uid,email,name,role};};
 return {store,resolve,account,bootstrap,invite,verify,firestore:db,demoRestaurantId:DEMO_RESTAURANT_ID};
}

import {randomBytes} from 'node:crypto';
import {applicationDefault,getApps,initializeApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {FieldValue,getFirestore} from 'firebase-admin/firestore';
import {createFirebasePlatform} from '../firebase-platform.js';
import {createTenantSeed,migrateTenantState} from '../server.js';

const PROJECT_ID='resuto-cf8f5';
const API_KEY='AIzaSyCPj1hpw5-e16HM6Gp_U41TYyNpXNhXuhE';
const OWNER_EMAIL=String(process.env.OWNER_EMAIL||'').trim().toLowerCase();
const OWNER_NAME=String(process.env.OWNER_NAME||'Smash & Co Owner').trim();

if(!/^\S+@\S+\.\S+$/.test(OWNER_EMAIL))throw Error('Set OWNER_EMAIL to the restaurant owner email.');

const app=getApps()[0]||initializeApp({credential:applicationDefault(),projectId:PROJECT_ID});
const db=getFirestore(app),auth=getAuth(app);
let user,createdUser=false;
try{user=await auth.getUserByEmail(OWNER_EMAIL)}catch(error){
 if(error.code!=='auth/user-not-found')throw error;
 user=await auth.createUser({email:OWNER_EMAIL,displayName:OWNER_NAME,emailVerified:true,password:randomBytes(32).toString('base64url')});
 createdUser=true;
}

const platform=createFirebasePlatform({projectId:PROJECT_ID,seedTenant:createTenantSeed,migrateTenant:migrateTenantState});
const slugRef=db.doc('restaurantSlugs/smash-and-co');
let slugDoc=await slugRef.get(),restaurantId;
if(slugDoc.exists)restaurantId=slugDoc.data().restaurantId;
else{
 const created=await platform.bootstrap({uid:user.uid,email:OWNER_EMAIL,name:OWNER_NAME,role:'owner',unprovisioned:true},{name:'Smash & Co',slug:'smash-and-co',branch:'Downtown',plan:'growth'});
 restaurantId=created.restaurantId;
 slugDoc=await slugRef.get();
}

const membershipRef=db.doc(`users/${user.uid}/memberships/${restaurantId}`);
if(!(await membershipRef.get()).exists){
 await db.runTransaction(async transaction=>{
  transaction.set(db.doc(`users/${user.uid}`),{email:OWNER_EMAIL,name:OWNER_NAME,lastRestaurantId:restaurantId,updatedAt:FieldValue.serverTimestamp()},{merge:true});
  transaction.set(membershipRef,{role:'owner',email:OWNER_EMAIL,name:OWNER_NAME,createdAt:FieldValue.serverTimestamp()});
 });
}

// Copy only the product data already used by the Smash storefront. Images stay
// in /public/assets/smash and are deliberately never written to Firestore.
const demoSnapshot=await db.doc('restaurants/olive-room-demo/private/state').get();
const targetRef=db.doc(`restaurants/${restaurantId}/private/state`),targetSnapshot=await targetRef.get();
if(!demoSnapshot.exists||!targetSnapshot.exists)throw Error('Restaurant seed data is missing.');
const demoState=demoSnapshot.data().state,state=structuredClone(targetSnapshot.data().state);
const sourceBranch=demoState.branches.find(branch=>branch.id==='burger');
const currentMain=state.branches.find(branch=>branch.id==='main')||{};
state.demo=false;
state.settings={...state.settings,name:'Smash & Co',branch:'Downtown',serviceMode:'counter',reservationsEnabled:false,deliveryEnabled:true,deliveryFee:demoState.settings.deliveryFee,publicSlug:'smash-and-co',publicPath:'/burger'};
state.profile={...state.profile,name:'Smash & Co',type:'Fast-food restaurant',cuisine:'Burgers',country:'Egypt',currency:'EGP',timezone:'Africa/Cairo'};
state.branches=[{...currentMain,...sourceBranch,id:'main',name:'Downtown',nameAr:'وسط البلد',active:true,pickup:true,delivery:true,deliveryAreas:['Downtown','وسط البلد']}];
state.menu=demoState.menu.filter(item=>item.branchIds?.includes('burger')).map(item=>{
 const copy=structuredClone(item);
 copy.branchIds=['main'];
 delete copy.image;
 delete copy.imageUrl;
 return copy;
});
await targetRef.set({state,revision:(targetSnapshot.data().revision||0)+1,updatedAt:FieldValue.serverTimestamp()},{merge:true});

const resetResponse=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${API_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestType:'PASSWORD_RESET',email:OWNER_EMAIL})});
const resetResult=await resetResponse.json();
if(!resetResponse.ok)throw Error(resetResult.error?.message||'Could not send the password setup email.');

console.log(JSON.stringify({ownerEmail:OWNER_EMAIL,ownerUid:user.uid,createdUser,restaurantId,slug:'smash-and-co',menuItems:state.menu.length,passwordSetupEmailSent:true}));

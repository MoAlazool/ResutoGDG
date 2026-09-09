import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createApp} from '../server.js';
import {saasPage,restaurantPage} from '../public/pages.js';
import {savedFloorSvg} from '../public/floor-shared.js';
import {mountKitchenDnd} from '../public/kitchen-dnd.js';

// Execute actual page templates with lightweight host stubs. This checks JavaScript
// rendering logic, not browser layout, interaction, accessibility, or device behavior.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replace("tab=['integrations','branches'].includes(location.hash.slice(1))?location.hash.slice(1):'overview'","tab='floor'");
for(const route of ['/','/restaurant','/reserve','/menu','/order','/t/example','/manager','/kitchen'])test(`page template executes: ${route}`,async()=>{
 const app=createApp({dbPath:':memory:',managerPassword:'test',kitchenPassword:'test'}),s=app.read();app.db.close();
 const role=route==='/kitchen'?'kitchen':'manager',root={innerHTML:''},listeners={};
 const document={querySelector:selector=>selector==='#app'?root:null,addEventListener:(type,fn)=>listeners[type]=fn,hidden:false,activeElement:null};
 const v={id:'visit',name:'Demo Guest',type:'pickup',status:'open',locked:false,orders:[],requests:[],bill:{total:0,subtotal:0,fee:0,credit:0,paid:0,due:0}};
 const fetch=async url=>({ok:true,json:async()=>url.includes('/visit')?v:{...s,role}});
 const store=new Map(route==='/order'?[['resuto-token','example']]:[]),sessionStorage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('window','document','location','sessionStorage','fetch','setInterval','saasPage','restaurantPage','savedFloorSvg','localizedName','language','tr','mountKitchenDnd','publicExperiencePath','venueQrPath',source)({addEventListener:()=>{}},document,{pathname:route,hash:'#floor'},sessionStorage,fetch,()=>{},saasPage,restaurantPage,savedFloorSvg,m=>m.name,'en',(en,ar)=>en,mountKitchenDnd,d=>d.settings?.serviceMode==='counter'&&d.settings?.venueQr?'/t/'+d.settings.venueQr:'/restaurant',()=>'/qr/venue');
 assert.match(root.innerHTML,/<main/);assert.doesNotMatch(root.innerHTML,/We couldn’t connect/);
 if(route==='/manager')for(const id of ['reservations','visits','orders','menu','insights','settings','floor']){await listeners.click({target:{closest:()=>({dataset:{action:'tab',id}})}});assert.ok(root.innerHTML.includes('workspace'));}
 if(route==='/reserve'){assert.match(root.innerHTML,/data-form="reserve"/);assert.match(root.innerHTML,/type="button" class="secondary full" data-action="availability"/)}
});

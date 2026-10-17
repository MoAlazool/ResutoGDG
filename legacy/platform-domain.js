import {randomBytes} from 'node:crypto';
export const uid=()=>randomBytes(16).toString('hex');
export const reject=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const names=['بوراتا مع الطماطم','شوربة القرع المشوي','دجاج مشوي مع الخضروات','ريزوتو الفطر','قاروص بزبدة الليمون','سلطة الحديقة','فون دان الشوكولاتة','كركديه مثلج'];
const descriptions=['Creamy burrata, ripe tomatoes and fresh basil.','Silky roasted pumpkin, gently seasoned.','Grilled chicken with seasonal vegetables.','Creamy rice with wild mushrooms.','Seabass with lemon butter and greens.','A colorful bowl of seasonal vegetables.','Warm chocolate cake with a soft center.','Chilled hibiscus, served over ice.'];
const descriptionsAr=['بوراتا كريمية وطماطم ناضجة وريحان طازج.','شوربة قرع مشوي ناعمة بتتبيلة خفيفة.','دجاج مشوي مع خضروات موسمية.','أرز كريمي مع تشكيلة من الفطر.','قاروص مع زبدة الليمون والخضروات.','تشكيلة ملونة من الخضروات الموسمية.','كيك شوكولاتة دافئ بقلب ناعم.','كركديه بارد يقدم مع الثلج.'];
export function migratePlatform(s){const before=JSON.stringify([s.platformVersion,s.branches,s.menu,s.tables,s.settings.serviceMode,s.settings.reservationsEnabled,s.settings.venueQr]);
 s.branches||=[{id:'main',name:s.settings.branch,nameAr:'الزمالك، القاهرة',active:true,pickup:true,delivery:s.settings.deliveryEnabled,deliveryAreas:['Zamalek','الزمالك'],paymentProvider:'auto',reservations:true}];
 s.splits||=[];s.shares||=[];s.ratings||=[];s.integrations||={};s.revision||=0;
 for(const m of s.menu){const n=/^m[0-7]$/.test(m.id)?Number(m.id.slice(1)):-1;Object.assign(m,{nameAr:m.nameAr||(n>=0?names[n]:''),description:m.description||(n>=0?descriptions[n]:''),descriptionAr:m.descriptionAr||(n>=0?descriptionsAr[n]:''),imageIndex:m.imageIndex??n,spice:m.spice??0,prepMinutes:m.prepMinutes??null,ingredients:m.ingredients||[],dietary:m.dietary||(m.vegetarian?['vegetarian']:[]),variants:m.variants||[],modifiers:m.modifiers||[],addons:m.addons||[],branchIds:m.branchIds||['main'],internalNotes:m.internalNotes||''});}
 for(const branch of s.branches){branch.reservations??=branch.id==='main';}for(const t of s.tables){t.branchId||='main';t.features||=[];t.reservable??=true;}
 for(const v of s.visits)v.branchId||='main';
 // How the venue serves: a floor of tables with a QR each, one counter QR for
 // a cloud kitchen or takeaway window, or no on-site ordering at all.
 s.settings.serviceMode||='tables';
 s.settings.reservationsEnabled??=true;
 s.settings.venueQr||=uid();
 if(s.demo)seedBurger(s);
 s.platformVersion=4;return before!==JSON.stringify([s.platformVersion,s.branches,s.menu,s.tables,s.settings.serviceMode,s.settings.reservationsEnabled,s.settings.venueQr]);
}
export function billFor(s,v){const subtotal=s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled').reduce((n,o)=>n+o.total,0),total=subtotal+v.fee,paid=s.payments.filter(p=>p.visitId===v.id&&p.kind==='bill').reduce((n,p)=>n+p.amount,0);return {subtotal,fee:v.fee,total,credit:v.credit,paid,due:Math.max(0,total-v.credit-paid)};}
export function quoteLines(s,lines,branchId='main'){
 if(!Array.isArray(lines)||!lines.length||lines.length>50)reject('Your cart is empty.');const counts={};
 const result=lines.map(l=>{const m=s.menu.find(m=>m.id===l.id);if(!m||!m.available||!m.branchIds?.includes(branchId)||!integer(l.qty,1,50))reject('An item is unavailable.',409);counts[m.id]=(counts[m.id]||0)+l.qty;const selected=Array.isArray(l.options)?l.options:[];if(new Set(selected).size!==selected.length)reject('Duplicate options.');const modifiers=selected.map(id=>m.modifiers.find(x=>x.id===id));if(modifiers.some(x=>!x||!x.available))reject('An option is unavailable.',409);for(const mod of m.modifiers)if(mod.required&&!selected.includes(mod.id))reject('Choose the required options.');const price=m.price+modifiers.reduce((n,x)=>n+x.price,0);if(l.price!==undefined&&l.price!==price)reject('A menu price changed. Refresh your cart and confirm again.',409);return {id:m.id,name:m.name,nameAr:m.nameAr,qty:l.qty,price,station:m.station,options:modifiers.map(x=>({id:x.id,name:x.name,price:x.price}))};});
 for(const [id,qty]of Object.entries(counts))if(s.menu.find(m=>m.id===id).stock<qty)reject('Insufficient portions.',409);return result;
}
export function placeOnline(s,b){const branch=s.branches.find(x=>x.id===b.branchId&&x.active);if(!branch||!['pickup','delivery'].includes(b.type)||!branch[b.type])reject('Choose an available branch and fulfillment method.');if(typeof b.name!=='string'||!b.name.trim()||b.name.length>100||typeof b.contact!=='string'||!b.contact.trim()||b.contact.length>100)reject('Enter your name and contact.');if(b.type==='delivery'&&(typeof b.address!=='string'||!b.address.trim()||b.address.length>500||!branch.deliveryAreas.includes(b.area)))reject('Choose an eligible delivery area and enter your address.');
 if(branch.paymentProvider!=='auto'&&b.payment!==branch.paymentProvider)reject('Choose the branch payment method.');const lines=quoteLines(s,b.lines,branch.id),v={id:uid(),token:uid(),type:b.type,branchId:branch.id,name:b.name,contact:b.contact,address:b.address||'',status:'open',locked:false,credit:0,fee:b.type==='delivery'?s.settings.deliveryFee:0,created:Date.now()};s.visits.push(v);
 const order={id:uid(),number:s.orders.length+1,visitId:v.id,branchId:branch.id,type:v.type,name:v.name,lines,total:lines.reduce((n,l)=>n+l.qty*l.price,0),notes:String(b.notes||'').slice(0,500),status:'received',version:0,created:Date.now()};
 if(b.payment==='demo'){if(process.env.PAYMENT_MODE==='live')reject('Simulated payments are disabled.',403);v.locked=true;s.payments.push({id:uid(),visitId:v.id,kind:'bill',amount:order.total+v.fee,provider:'demo',at:Date.now()});}else if(!['stripe','paymob'].includes(b.payment))reject('Choose a payment method.');
 for(const l of lines){const m=s.menu.find(m=>m.id===l.id);m.stock-=l.qty;m.version++;}s.orders.push(order);return {token:v.token,orderId:order.id,amount:order.total+v.fee};
}
const apportion=(total,weights)=>{const sum=weights.reduce((n,x)=>n+x,0);if(!sum)reject('Each share needs an amount.');const exact=weights.map(x=>total*x/sum),amounts=exact.map(Math.floor);let remainder=total-amounts.reduce((n,x)=>n+x,0);exact.map((x,i)=>({i,f:x-Math.floor(x)})).sort((a,b)=>b.f-a.f||a.i-b.i).slice(0,remainder).forEach(x=>amounts[x.i]++);return amounts;};
function itemSplit(s,v,b,due){
 const orders=s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled'),units=new Map();
 for(const order of orders)order.lines.forEach((line,lineIndex)=>{for(let unit=0;unit<line.qty;unit++)units.set(`${order.id}:${lineIndex}:${unit}`,{orderId:order.id,lineIndex,unit,menuItemId:line.id,name:line.name,amount:line.price});});
 const allocations=Array.isArray(b.allocations)?b.allocations:[];if(allocations.length<2||allocations.length>20)reject('Assign the bill to between 2 and 20 shares.');
 const seen=new Set(),normalized=allocations.map((allocation,shareIndex)=>{const keys=Array.isArray(allocation.items)?allocation.items:[];if(!keys.length)reject('Every share needs at least one item.');const items=keys.map(item=>{const key=`${item.orderId}:${item.lineIndex}:${item.unit}`,unit=units.get(key);if(!unit||seen.has(key))reject('Every item must be assigned exactly once.');seen.add(key);return unit;});return {shareIndex,items,raw:items.reduce((n,x)=>n+x.amount,0)};});
 if(seen.size!==units.size)reject('Every item must be assigned exactly once.');const amounts=apportion(due,normalized.map(x=>x.raw));return {amounts,allocations:normalized.map((x,i)=>({shareIndex:i,items:x.items,amount:amounts[i]}))};
}
export function splitView(s,v,origin){const split=[...s.splits].reverse().find(x=>x.visitId===v.id&&['active','complete'].includes(x.status));return split?{id:split.id,method:split.method||'equal',total:split.total,status:split.status,created:split.created,allocations:structuredClone(split.allocations||[]),shares:s.shares.filter(x=>x.splitId===split.id).map(x=>({id:x.id,name:x.name,amount:x.amount,status:x.status,url:origin+'/s/'+x.token,allocation:structuredClone(x.allocation||null)})),bill:billFor(s,v)}:null;}
export function createSplit(s,v,b,origin){
 const method=b.method||'equal';if(v.status!=='open'||!['full','equal','custom','items'].includes(method))reject('Choose a valid split method.');
 const current=s.splits.find(x=>x.visitId===v.id&&x.status==='active');if(current)return splitView(s,v,origin);
 if((s.checkouts||[]).some(c=>c.visitId===v.id&&c.status==='pending'))reject('Finish the pending checkout first.',409);
 const due=billFor(s,v).due;if(due<1)reject('This bill is already settled.',409);
 let amounts,allocations=[];
 if(method==='full')amounts=[due];
 else if(method==='equal'){if(!integer(b.people,2,20)||due<b.people)reject('Choose between 2 and 20 people.');amounts=apportion(due,Array(b.people).fill(1));}
 else if(method==='custom'){if(!Array.isArray(b.amounts)||b.amounts.length<2||b.amounts.length>20||b.amounts.some(x=>!integer(x,1,due))||b.amounts.reduce((n,x)=>n+x,0)!==due)reject('Custom shares must add up to the remaining balance.');amounts=[...b.amounts];}
 else({amounts,allocations}=itemSplit(s,v,b,due));
 const split={id:uid(),visitId:v.id,method,total:due,status:'active',allocations,created:Date.now()};s.splits.push(split);v.locked=true;
 amounts.forEach((amount,i)=>s.shares.push({id:uid(),token:uid(),splitId:split.id,visitId:v.id,amount,name:String(b.names?.[i]||'').trim().slice(0,60),allocation:allocations[i]||null,status:'pending',created:Date.now()}));
 return splitView(s,v,origin);
}
export function shareFor(s,token){const share=s.shares.find(x=>x.token===token);if(!share)reject('Payment invitation not found.',404);return share;}
export function shareView(s,x){const v=s.visits.find(v=>v.id===x.visitId);return {name:x.name,amount:x.amount,status:x.status,restaurant:s.settings.name,branch:s.branches.find(b=>b.id===v.branchId)?.name,remaining:billFor(s,v).due,canRate:x.status==='paid',checkout:(s.checkouts||[]).find(c=>c.shareId===x.id&&c.status==='pending')?.url||null};}
export function payShare(s,x,b){if(!b.name?.trim()||b.name.length>60)reject('Enter your first name.');if(x.status==='paid')return shareView(s,x);if(x.status!=='pending')reject('This payment invitation is no longer active.',409);if((s.checkouts||[]).some(c=>c.shareId===x.id&&c.status==='pending'))reject('Complete the pending checkout first.',409);if(process.env.PAYMENT_MODE==='live')reject('Simulated payments are disabled.',403);const v=s.visits.find(v=>v.id===x.visitId);if(v.status!=='open'||billFor(s,v).due<x.amount)reject('Balance changed.',409);x.name=b.name.trim();x.status='paid';x.paidAt=Date.now();s.payments.push({id:uid(),visitId:v.id,shareId:x.id,kind:'bill',amount:x.amount,provider:'demo',at:Date.now()});const split=s.splits.find(y=>y.id===x.splitId);if(split&&s.shares.filter(y=>y.splitId===split.id).every(y=>y.status==='paid')){split.status='complete';split.completedAt=Date.now();}return shareView(s,x);}
export function addRating(s,v,b,shareId){if(!s.payments.some(p=>p.visitId===v.id&&p.kind==='bill'&&(!shareId||p.shareId===shareId)))reject('Complete payment before rating.',409);if(!integer(b.overall,1,5)||['food','service','speed','value'].some(k=>b[k]!=null&&!integer(b[k],1,5)))reject('Choose a rating from one to five.');const existing=s.ratings.find(r=>r.visitId===v.id&&r.shareId===(shareId||null));if(existing)return {ok:true};s.ratings.push({id:uid(),visitId:v.id,branchId:v.branchId||'main',tableId:v.tableId||null,orderIds:s.orders.filter(o=>o.visitId===v.id).map(o=>o.id),shareId:shareId||null,overall:b.overall,food:b.food??null,service:b.service??null,speed:b.speed??null,value:b.value??null,comment:String(b.comment||'').slice(0,1000),at:Date.now()});return {ok:true};}
export function insights(s){const orders=s.orders.filter(o=>o.status!=='cancelled'),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(Date.now()),payments=s.payments.filter(p=>p.kind==='bill'),day=p=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo'}).format(p.at)===today;return {revenueToday:payments.filter(day).reduce((n,p)=>n+p.amount,0),ordersToday:orders.filter(o=>day({at:o.created})).length,activeTables:s.visits.filter(v=>v.status==='open'&&v.tableId).length,lowStock:s.menu.filter(m=>m.available&&m.stock<6),ratings:{count:s.ratings.length,average:s.ratings.length?s.ratings.reduce((n,r)=>n+r.overall,0)/s.ratings.length:null,details:['food','service','speed','value'].map(k=>{const rows=s.ratings.filter(r=>r[k]);return {key:k,count:rows.length,average:rows.length?rows.reduce((n,r)=>n+r[k],0)/rows.length:null}})},stations:[...new Set(s.menu.map(m=>m.station))].map(name=>({name,portions:orders.filter(o=>['received','preparing'].includes(o.status)).flatMap(o=>o.lines).filter(l=>l.station===name).reduce((n,l)=>n+l.qty,0)})),recentPayments:payments.slice(-10).reverse(),customers:Object.values(s.visits.filter(v=>v.contact).reduce((a,v)=>{a[v.contact]||={name:v.name,contact:v.contact,visits:0,spent:0};a[v.contact].visits++;a[v.contact].spent+=payments.filter(p=>p.visitId===v.id).reduce((n,p)=>n+p.amount,0);return a},{}))};}

// A second storefront: a burger counter that shares this backend but has its
// own branch, its own catalogue and its own guest site at /burger. Menu rows
// are branch-scoped, so quoteLines() already refuses cross-brand ordering.
const BURGER=[
 ['Classic Smash','برجر سماش كلاسيك','Burgers',13500,'Grill',40,['wheat','milk'],false,'Two smashed patties, cheese, pickles, house sauce.','قطعتا لحم مسحوق، جبنة، مخلل، وصوص البيت.'],
 ['Double Smash','دوبل سماش','Burgers',18500,'Grill',30,['wheat','milk'],false,'Four patties for a serious appetite.','أربع قطع لحم لمن يريد وجبة دسمة.'],
 ['Crispy Chicken','برجر دجاج مقرمش','Burgers',14500,'Fryer',35,['wheat'],false,'Buttermilk chicken, slaw, spicy mayo.','دجاج متبّل مقرمش مع سلطة كول سلو ومايونيز حار.'],
 ['Veggie Smash','برجر نباتي','Burgers',12500,'Grill',20,['wheat'],true,'Charred mushroom patty, smoked cheese.','قرص فطر مشوي مع جبنة مدخّنة.'],
 ['Loaded Fries','بطاطس محمّلة','Sides',8500,'Fryer',45,['milk'],true,'Fries under cheese sauce and jalapeños.','بطاطس تحت صوص الجبنة والهالابينو.'],
 ['Classic Fries','بطاطس مقلية','Sides',5500,'Fryer',60,[],true,'Skin-on, salted, straight from the fryer.','مقرمشة بقشرها، مملّحة، من المقلاة مباشرة.'],
 ['Onion Rings','حلقات بصل','Sides',6500,'Fryer',30,['wheat'],true,'Thick-cut rings in a crisp batter.','حلقات سميكة بعجينة مقرمشة.'],
 ['Chocolate Shake','ميلك شيك شوكولاتة','Shakes',7500,'Bar',25,['milk'],true,'Thick shake, real chocolate.','ميلك شيك كثيف بشوكولاتة حقيقية.'],
 ['Cola','كولا','Drinks',3500,'Bar',80,[],true,'Served over ice.','تُقدَّم مع الثلج.'],
];
const BURGER_OPTIONS={
 Burgers:[['extra-cheese','Extra cheese','جبنة إضافية',1500],['bacon','Add bacon','إضافة بيكون',2500],['spicy','Make it spicy','زودها حرارة',0]],
 Sides:[['cheese-sauce','Cheese sauce','صوص جبنة',1200]],
};
function seedBurger(s){
 if(s.branches.some(b=>b.id==='burger'))return;
 s.branches.push({id:'burger',name:'Smash & Co',nameAr:'سماش آند كو',active:true,pickup:true,delivery:true,
  deliveryAreas:['Downtown','وسط البلد'],paymentProvider:'auto',reservations:false});
 BURGER.forEach(([name,nameAr,category,price,station,stock,allergens,veg,description,descriptionAr],i)=>{
  s.menu.push({id:'b'+i,name,nameAr,category,price,station,stock,allergens,vegetarian:veg,description,descriptionAr,
   available:true,version:0,branchIds:['burger'],imageIndex:-1,spice:0,prepMinutes:null,ingredients:[],
   dietary:veg?['vegetarian']:[],variants:[],addons:[],internalNotes:'',
   modifiers:(BURGER_OPTIONS[category]||[]).map(([id,mname,mnameAr,mprice])=>({id,name:mname,nameAr:mnameAr,price:mprice,available:true,required:false}))});
 });
}

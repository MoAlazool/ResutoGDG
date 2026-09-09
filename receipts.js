// Digital receipt projections.
//
// A receipt is ALWAYS derived from a confirmed payment record in s.payments.
// Nothing in this module can create, confirm or imply a payment: demo payments
// are written by /api/pay and payShare, provider payments only by the verified
// webhook. If there is no payment row, there is no receipt.
import {billFor} from './platform-domain.js';

const fail=(message,status=404)=>{throw Object.assign(Error(message),{status})};
const ref=(prefix,value)=>prefix+'-'+String(value||'').replace(/[^a-z0-9]/gi,'').slice(0,8).toUpperCase();
const branchOf=(s,id)=>s.branches.find(b=>b.id===(id||'main'))||s.branches[0]||null;
const brand=s=>({name:s.settings.name,branch:s.settings.branch,logo:s.profile?.logo||null});

// Lines across every uncancelled order of a visit, merged by dish and unit price.
function itemsFor(s,v){
 const merged=new Map();
 for(const o of s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled'))
  for(const l of o.lines){
   const id=l.id+':'+l.price,row=merged.get(id)||{name:l.name,nameAr:l.nameAr||'',price:l.price,qty:0,total:0};
   row.qty+=l.qty;row.total+=l.qty*l.price;merged.set(id,row);
  }
 return [...merged.values()];
}

const orderRefs=(s,v)=>s.orders.filter(o=>o.visitId===v.id&&o.status!=='cancelled').map(o=>'RS-'+String(o.number).padStart(5,'0'));

function splitFor(s,p){
 if(!p.shareId)return null;
 const share=s.shares.find(x=>x.id===p.shareId);if(!share)return null;
 const shares=s.shares.filter(x=>x.splitId===share.splitId);
 return {yourShare:share.amount,participants:shares.length,paidCount:shares.filter(x=>x.status==='paid').length,method:s.splits.find(x=>x.id===share.splitId)?.method||'equal',name:share.name||''};
}

// One confirmed payment row -> one receipt document.
export function receiptFor(s,p){
 const online=p.provider&&p.provider!=='demo';
 const receipt={
  id:ref('RC',p.id),paymentId:p.id,status:'paid',at:p.at,currency:'EGP',
  kind:p.reservationId?'deposit':p.shareId?'share':'bill',
  restaurant:brand(s),amount:p.amount,
  payment:{provider:p.provider||'demo',mode:online?'live':'test',transactionId:ref('TXN',p.providerId||p.id)}
 };
 if(p.reservationId){
  const r=s.reservations.find(x=>x.id===p.reservationId);if(!r)fail('Reservation not found.');
  const table=s.tables.find(t=>t.id===r.tableId);
  return {...receipt,reference:{reservation:ref('RSV',r.id)},branch:branchOf(s,table?.branchId),
   reservation:{status:r.status,start:r.start,end:r.end,party:r.party,name:r.name,table:table?.label||'',zone:table?.zone||''},
   totals:{deposit:p.amount,total:p.amount},items:[]};
 }
 const v=s.visits.find(x=>x.id===p.visitId);if(!v)fail('Visit not found.');
 const bill=billFor(s,v),table=s.tables.find(t=>t.id===v.tableId);
 return {...receipt,reference:{orders:orderRefs(s,v)},branch:branchOf(s,v.branchId),
  visit:{type:v.type,name:v.name,table:table?.label||'',zone:table?.zone||'',guests:s.reservations.find(r=>r.id===v.reservationId)?.party||null,opened:v.created,status:v.status},
  items:itemsFor(s,v),
  totals:{subtotal:bill.subtotal,fee:bill.fee,credit:bill.credit,total:bill.total,paid:bill.paid,due:bill.due,amount:p.amount},
  split:splitFor(s,p)};
}

// Every receipt a visit has earned, newest first. Refunds are not receipts.
export const receiptsForVisit=(s,v)=>s.payments.filter(p=>p.visitId===v.id&&p.kind==='bill').sort((a,b)=>b.at-a.at).map(p=>receiptFor(s,p));

export function receiptForPayment(s,id,allow){
 const p=s.payments.find(x=>x.id===id&&x.kind!=='test-refund');
 if(!p||!allow(p))fail('Receipt not found.');
 return receiptFor(s,p);
}

// A checkout is only ever reported paid once the verified webhook wrote its
// payment row; until then the caller must keep waiting rather than assume.
export function checkoutReceipt(s,c){
 if(!c)fail('Checkout not found.');
 if(c.status!=='paid')return {status:c.status==='expired'?'failed':'pending',receipt:null};
 const p=s.payments.find(x=>x.providerId&&x.visitId===c.visitId&&x.amount===c.amount&&(x.shareId||null)===(c.shareId||null));
 return p?{status:'paid',receipt:receiptFor(s,p)}:{status:'pending',receipt:null};
}

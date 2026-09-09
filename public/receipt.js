// Digital receipt — a paper-inspired document built from a confirmed payment.
// Every part is a small pure renderer so the same document serves the payment
// success flow, the bill history and the share/reservation confirmations.
import {t,language,money} from './i18n.js';
import {escapeHtml as e} from './floor-shared.js';

const locale=()=>language==='ar'?'ar-EG':'en-GB';
const dateOf=at=>new Intl.DateTimeFormat(locale(),{timeZone:'Africa/Cairo',day:'numeric',month:'short',year:'numeric'}).format(at);
const timeOf=at=>new Intl.DateTimeFormat(locale(),{timeZone:'Africa/Cairo',hour:'numeric',minute:'2-digit'}).format(at);
const nameOfLine=l=>language==='ar'&&l.nameAr?l.nameAr:l.name;
const providerLabel=p=>({demo:t('Test payment'),stripe:'Stripe · '+t('Card'),paymob:'Paymob · '+t('Card')})[p]||p;

// Code 39 — self-checking, and every receipt id is inside its charset.
const CODE39={'0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw','5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn','A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn','F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn','K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn','P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn','U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn','Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','*':'nwnnwnwnn'};
export function barcodeSvg(value,height=54){
 const text='*'+String(value).toUpperCase().replace(/[^0-9A-Z\-. ]/g,'')+'*';
 const narrow=2,wide=narrow*3,bars=[];let x=0;
 for(const char of text){
  const pattern=CODE39[char];if(!pattern)continue;
  for(let i=0;i<pattern.length;i++){const w=pattern[i]==='w'?wide:narrow;if(i%2===0)bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`);x+=w}
  x+=narrow; // inter-character gap
 }
 return `<svg class="receipt-barcode" viewBox="0 0 ${x} ${height}" role="img" aria-label="${t('Receipt code')} ${e(value)}" preserveAspectRatio="none">${bars.join('')}</svg>`;
}

const rule=(cls='')=>`<div class="receipt-rule ${cls}" aria-hidden="true"></div>`;
const metaCell=(label,value)=>value?`<div><dt>${t(label)}</dt><dd>${e(String(value))}</dd></div>`:'';
const amountRow=(label,value,cls='')=>`<div class="receipt-amount ${cls}"><span>${t(label)}</span><b dir="ltr">${money(value)}</b></div>`;

function receiptHeader(r){
 const logo=r.restaurant.logo?`<img class="receipt-logo" src="${e(r.restaurant.logo)}" alt="">`:`<span class="receipt-monogram" aria-hidden="true">${e((r.restaurant.name||'R').trim()[0])}</span>`;
 return `<header class="receipt-head">${logo}<h2 class="receipt-title">${t('Receipt')}</h2><p class="receipt-stamp">✓ ${t('Payment Successful')}</p><span class="receipt-stars" aria-hidden="true">✳ ✳ ✳</span></header>`;
}

function receiptMeta(r){
 const rows=[metaCell('Order',(r.reference?.orders||[])[0]),metaCell('Receipt',r.id)];
 if(r.kind==='deposit'){
  rows.push(metaCell('Reservation',r.reference?.reservation),metaCell('Date',dateOf(r.reservation.start)),metaCell('Time',timeOf(r.reservation.start)),metaCell('Table',r.reservation.table),metaCell('Guests',r.reservation.party));
 }else{
  rows.push(metaCell('Date',dateOf(r.at)),metaCell('Time',timeOf(r.at)));
  if(r.visit.table)rows.push(metaCell('Table',r.visit.table));
  if(r.visit.guests)rows.push(metaCell('Guests',r.visit.guests));
  if(!r.visit.table)rows.push(metaCell('Fulfillment',t(r.visit.type==='delivery'?'Delivery':'Pickup')));
 }
 const orders=(r.reference?.orders||[]).slice(1);
 return `<section class="receipt-venue"><strong>${e(t(r.restaurant.name))}</strong><span>${e(r.branch?.[language==='ar'?'nameAr':'name']||r.restaurant.branch||'')}</span></section>${rule()}<dl class="receipt-meta">${rows.filter(Boolean).join('')}</dl>${orders.length?`<p class="receipt-note">${t('Also covers')}: ${e(orders.join(', '))}</p>`:''}`;
}

function receiptItems(r){
 if(r.kind==='deposit')return `${rule('dotted')}<div class="receipt-items"><div class="receipt-item"><span class="receipt-qty">1</span><span class="receipt-item-name">${t('Reservation deposit')}<small>${e(r.reservation.name||'')}</small></span><b class="receipt-item-price" dir="ltr">${money(r.totals.deposit)}</b></div></div>`;
 if(!r.items.length)return '';
 return `${rule('dotted')}<div class="receipt-items">${r.items.map(l=>`<div class="receipt-item"><span class="receipt-qty">${l.qty}</span><span class="receipt-item-name">${e(nameOfLine(l))}<small dir="ltr">${money(l.price)} ${t('each')}</small></span><b class="receipt-item-price" dir="ltr">${money(l.total)}</b></div>`).join('')}</div>`;
}

function receiptTotals(r){
 if(r.kind==='deposit')return `${rule('dotted')}<div class="receipt-totals">${amountRow('Deposit paid',r.totals.deposit)}${amountRow('TOTAL',r.totals.total,'receipt-grand')}</div><p class="receipt-note">${t('The deposit is credited to your bill at check-in.')}</p>`;
 const {subtotal,fee,credit,total,due}=r.totals;
 return `${rule('dotted')}<div class="receipt-totals">${amountRow('Subtotal',subtotal)}${fee?amountRow('Delivery fee',fee):''}${credit?amountRow('Reservation deposit',-credit,'receipt-credit'):''}${amountRow('TOTAL',total,'receipt-grand')}</div>${rule('dotted')}<div class="receipt-totals">${amountRow(r.split?'Your payment':'Paid now',r.totals.amount,'receipt-paid')}${amountRow(due?'Remaining balance':'Remaining',due,due?'receipt-due':'')}</div>${due?'':`<p class="receipt-settled">✓ ${t('Fully paid')}</p>`}`;
}

function receiptPayment(r){
 const split=r.split?`<div><dt>${t('Split bill')}</dt><dd>${r.split.paidCount} / ${r.split.participants} ${t('paid')}</dd></div>`:'';
 return `${rule('dotted')}<dl class="receipt-meta receipt-payment"><div><dt>${t('Payment method')}</dt><dd>${e(providerLabel(r.payment.provider))}</dd></div><div><dt>${t('Payment status')}</dt><dd class="receipt-paid-flag">${t('PAID')} ✓</dd></div><div><dt>${t('Transaction ID')}</dt><dd dir="ltr">${e(r.payment.transactionId)}</dd></div>${split}</dl>${r.payment.mode==='test'?`<p class="receipt-note">${t('Test mode. No real money is charged.')}</p>`:''}`;
}

const receiptCode=r=>`${rule('dotted')}<footer class="receipt-foot"><p class="receipt-thanks">${t('Thank you for visiting')} <span aria-hidden="true">♥</span></p>${barcodeSvg(r.id)}<span class="receipt-code" dir="ltr">${e(r.id)}</span></footer>`;

// The paper itself. Grows with its content; the torn edges stay attached.
export const receiptDocument=r=>`<article class="receipt-paper" dir="${language==='ar'?'rtl':'ltr'}" aria-label="${t('Receipt')} ${e(r.id)}"><div class="receipt-body">${receiptHeader(r)}${receiptMeta(r)}${receiptItems(r)}${receiptTotals(r)}${receiptPayment(r)}${receiptCode(r)}</div></article>`;

export const receiptSkeleton=(label='Confirming your payment…')=>`<div class="receipt-stage"><article class="receipt-paper is-loading" aria-busy="true"><div class="receipt-body"><div class="receipt-spinner" aria-hidden="true"></div><p class="receipt-pending-title">${t(label)}</p><p class="receipt-note">${t('Waiting for confirmation from the payment provider. Do not pay again.')}</p><div class="receipt-skeleton" aria-hidden="true">${'<span></span>'.repeat(7)}</div></div></article></div>`;

export const receiptFailed=message=>`<div class="receipt-stage"><article class="receipt-paper is-failed"><div class="receipt-body"><div class="receipt-failed-mark" aria-hidden="true">!</div><p class="receipt-pending-title">${t('Payment was not completed')}</p><p class="receipt-note">${e(message||t('No payment was taken. You can safely try again from your bill.'))}</p></div></article></div>`;

// Success beat, then the paper slides in. Kept short and non-blocking.
const checkmark=`<div class="receipt-checkmark" aria-hidden="true"><svg viewBox="0 0 52 52"><circle cx="26" cy="26" r="24"/><path d="M15 27l8 8 15-16"/></svg></div>`;
export const receiptSuccess=(r,opts={})=>`<div class="receipt-stage">${opts.celebrate===false?'':checkmark}${receiptDocument(r)}${receiptActions(r,opts)}</div>`;

export function receiptActions(r,{primary='Done',showRate=false}={}){
 const act=(label,action,cls='receipt-action')=>`<button type="button" class="${cls}" data-do="${action}" data-receipt="${e(r.paymentId||'')}">${t(label)}</button>`;
 return `<div class="receipt-actions">${act('Download','receipt-download')}${act('Share','receipt-share')}${r.kind==='bill'?act('View order','receipt-order'):''}</div><div class="receipt-actions receipt-actions-primary">${showRate?act('Rate your visit','rate','receipt-action'):''}${act(primary,'receipt-done','primary full')}</div>`;
}

// Sharing/saving works off a self-contained printable copy of this receipt.
export function receiptShareText(r){
 const lines=[`${r.restaurant.name} — ${t('Receipt')} ${r.id}`,`${dateOf(r.at)} ${timeOf(r.at)}`];
 if(r.kind==='deposit')lines.push(`${t('Reservation deposit')}: ${money(r.totals.deposit)}`);
 else{for(const l of r.items)lines.push(`${l.qty} × ${nameOfLine(l)}  ${money(l.total)}`);lines.push(`${t('TOTAL')}: ${money(r.totals.total)}`,`${t('Paid now')}: ${money(r.totals.amount)}`);}
 lines.push(`${t('Transaction ID')}: ${r.payment.transactionId}`);
 return lines.join('\n');
}

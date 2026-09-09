import {createHmac,timingSafeEqual} from 'node:crypto';
const error=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const matches=(a,b)=>typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function paymentConfig(state){
 const stripe=!!(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_WEBHOOK_SECRET)&&state?.integrations?.stripe?.enabled!==false;
 const paymob=!!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_PUBLIC_KEY&&process.env.PAYMOB_HMAC_SECRET&&process.env.PAYMOB_INTEGRATION_ID_CARD)&&state?.integrations?.paymob?.enabled!==false;
 const wallet=paymob&&!!process.env.PAYMOB_INTEGRATION_ID_WALLET,instapay=!!process.env.INSTAPAY_MERCHANT_ADDRESS;
 return {mode:process.env.PAYMENT_MODE==='live'?'live':'test',providers:[stripe?'stripe':null,paymob?'paymob':null].filter(Boolean),methods:[{id:'cash',kind:'request',available:true,confirmation:'restaurant'},{id:'card',kind:'online',available:stripe||paymob,providers:[stripe?'stripe':null,paymob?'paymob':null].filter(Boolean)},{id:'wallet',kind:'online',available:wallet,providers:wallet?['paymob']:[]},{id:'instapay',kind:'manual',available:instapay,confirmation:'manager'}],instapayAddress:instapay?process.env.INSTAPAY_MERCHANT_ADDRESS:null};
}
export async function createCheckout(attempt,origin,customer,fetcher=fetch){
  const {provider,id,amount}=attempt;
  if(!paymentConfig().providers.includes(provider))error('This payment provider is not configured.',503);
  if(provider==='stripe'){
    const body=new URLSearchParams({mode:'payment','payment_method_types[0]':'card',client_reference_id:id,'metadata[resuto_attempt]':id,'line_items[0][price_data][currency]':'egp','line_items[0][price_data][unit_amount]':String(amount),'line_items[0][price_data][product_data][name]':'Restaurant bill payment','line_items[0][quantity]':'1',success_url:origin+(attempt.returnPath||'/order')+'?checkout=returned',cancel_url:origin+(attempt.returnPath||'/order')+'?checkout=cancelled',expires_at:String(Math.floor(attempt.created/1000)+1800)});
    const r=await fetcher('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:'Bearer '+process.env.STRIPE_SECRET_KEY,'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':id},body,signal:AbortSignal.timeout(15000)});if(!r.ok)error('Stripe checkout could not be created. Retry this same payment request.',502);const result=await r.json();if(!result.id||!result.url?.startsWith('https://checkout.stripe.com/'))error('Invalid checkout response.',502);return {providerId:result.id,url:result.url};
  }
  const base=process.env.PAYMOB_BASE_URL||'https://accept.paymob.com';if(!/^https:\/\/(accept|uae|ksa|oman)\.paymob\.com$/.test(base))error('Invalid Paymob region configuration.',503);
  const integration=customer.method==='wallet'?process.env.PAYMOB_INTEGRATION_ID_WALLET:process.env.PAYMOB_INTEGRATION_ID_CARD;if(!integration)error('This Paymob payment method is not configured.',503);
  const r=await fetcher(base+'/v1/intention/',{method:'POST',headers:{Authorization:'Token '+process.env.PAYMOB_SECRET_KEY,'Content-Type':'application/json'},body:JSON.stringify({amount,currency:'EGP',payment_methods:[Number(integration)],special_reference:id,expiration:1800,billing_data:{first_name:customer.firstName,last_name:customer.lastName,email:customer.email,phone_number:customer.phone,apartment:'NA',floor:'NA',street:'NA',building:'NA',city:'NA',state:'NA',country:'EGY'},items:[{name:'Restaurant bill payment',amount,quantity:1}],notification_url:origin+'/api/webhooks/paymob',redirection_url:origin+'/order?checkout=returned'}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)error('Paymob checkout was not confirmed. Ask the manager to reconcile this attempt before starting another.',502);const result=await r.json();if(!result.client_secret||!result.intention_order_id)error('Invalid checkout response. Ask the manager to reconcile this attempt.',502);return {providerId:String(result.intention_order_id),url:base+'/unifiedcheckout/?'+new URLSearchParams({publicKey:process.env.PAYMOB_PUBLIC_KEY,clientSecret:result.client_secret})};
}
export function verifyPaymentEvent(provider,raw,headers,query){
  if(provider==='stripe'){
    if(!process.env.STRIPE_WEBHOOK_SECRET)error('Provider not configured.',503);const values=String(headers['stripe-signature']||'').split(',').map(x=>x.split('='));const timestamp=values.find(x=>x[0]==='t')?.[1];const expected=createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(timestamp+'.'+raw).digest('hex');if(!timestamp||Math.abs(Date.now()/1000-Number(timestamp))>300||!values.some(x=>x[0]==='v1'&&matches(expected,x[1])))error('Invalid webhook signature.',401);
    const event=JSON.parse(raw),o=event.data?.object;if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.expired'].includes(event.type))return null;if(event.type!=='checkout.session.expired'&&o.payment_status!=='paid')return null;
    return {provider,eventId:event.id,providerId:o.id,amount:o.amount_total,currency:o.currency?.toUpperCase(),paid:event.type!=='checkout.session.expired'};
  }
  if(provider!=='paymob'||!process.env.PAYMOB_HMAC_SECRET)error('Provider not configured.',503);const o=JSON.parse(raw).obj;if(!o||!o.order||!o.source_data)error('Invalid webhook.',400);
  const fields=['amount_cents','created_at','currency','error_occured','has_parent_transaction','id','integration_id','is_3d_secure','is_auth','is_capture','is_refunded','is_standalone_payment','is_voided','order.id','owner','pending','source_data.pan','source_data.sub_type','source_data.type','success'];
  const payload=fields.map(p=>p.split('.').reduce((v,k)=>v?.[k],o)).map(String).join('');const expected=createHmac('sha512',process.env.PAYMOB_HMAC_SECRET).update(payload).digest('hex');if(!matches(expected,query.get('hmac')))error('Invalid webhook signature.',401);
  if(o.success!==true||o.pending!==false||o.is_refunded||o.is_voided||o.is_auth||String(o.integration_id)!==process.env.PAYMOB_INTEGRATION_ID_CARD)return null;
  return {provider,eventId:String(o.id),providerId:String(o.order.id),amount:o.amount_cents,currency:o.currency,paid:true};
}

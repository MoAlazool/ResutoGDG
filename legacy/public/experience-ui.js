import {language,switcher,t} from './i18n.js';
import {escapeHtml} from './floor-shared.js';
export const e=escapeHtml;
export const copy=(en,ar)=>language==='ar'?ar:en;
export const header=()=>`<nav class="experience-nav"><a class="resuto-wordmark" href="/">${language==='ar'?'<img src="/assets/resuto-arabic-logo.png" width="160" alt="ريسوتو">':'<span>r</span>resuto.'}</a><div><a href="/restaurant">${copy('Restaurant demo','تجربة المطعم')}</a><a href="/pricing">${copy('Pricing','الأسعار')}</a>${switcher()}</div></nav>`;
export async function api(route,body){const r=await fetch('/api/'+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{status:r.status});return data;}
export const field=(en,ar,name,value='',type='text',extra='')=>`<label>${copy(en,ar)}<input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
export const notice=message=>{const el=document.querySelector('#toast');el.textContent=t(message);el.className='show';setTimeout(()=>el.className='',6000);};

import en from './locales/en.js';
import ar from './locales/ar.js';
import operations from './locales/ar-operations.js';
import extra from './locales/ar-extra.js';
import experience from './locales/ar-experience.js';
import rebuild from './locales/ar-rebuild.js';
import landing from './locales/ar-landing.js';
import receipt from './locales/ar-receipt.js';
Object.assign(ar,operations,extra,experience,rebuild,landing,receipt);
const lower=Object.fromEntries(Object.entries(ar).map(([k,v])=>[k.toLowerCase(),v]));
export function translatePhrase(text){if(ar[text]||lower[text.toLowerCase()])return ar[text]||lower[text.toLowerCase()];return text.replace(/\b(Contains|tables occupied|ready to serve|capacity used|seats|guests|tables|orders|portions|selected|pickup|delivery|milk|eggs|fish|wheat)\b/gi,k=>lower[k.toLowerCase()]||k).replace(/\bEGP\s*/g,'ج.م. ');}
export let language=localStorage.getItem('resuto-language')==='ar'?'ar':'en';
export const t=key=>(language==='ar'?ar[key]:en[key])||key;
export const money=n=>new Intl.NumberFormat(language==='ar'?'ar-EG':'en-EG',{style:'currency',currency:'EGP',maximumFractionDigits:2}).format(n/100);
export const nameOf=m=>language==='ar'&&m.nameAr?m.nameAr:m.name;
export const switcher=()=>`<button class="language-switch" data-language="${language==='ar'?'en':'ar'}" aria-label="${language==='ar'?'Switch to English':'التبديل إلى العربية'}">${language==='ar'?'EN':'العربية'}</button>`;
export function setLanguage(lang){language=lang==='ar'?'ar':'en';localStorage.setItem('resuto-language',language);document.documentElement.lang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';}
setLanguage(language);
document.addEventListener('click',e=>{const button=e.target.closest('[data-language]');if(button){setLanguage(button.dataset.language);location.reload();}});
// Compatibility translation for the retained operations/editor renderers.
export function translateLegacy(){if(language!=='ar')return;const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){if(node.parentElement?.closest('script,style,textarea,[data-user-content]'))continue;const text=node.textContent.trim();const translated=translatePhrase(text);if(translated!==text)node.textContent=node.textContent.replace(text,translated);}document.querySelectorAll('[aria-label],[placeholder],[title]').forEach(el=>{for(const attr of ['aria-label','placeholder','title']){const text=el.getAttribute(attr);if(text&&translatePhrase(text)!==text)el.setAttribute(attr,translatePhrase(text));}});}
export function watchLegacy(){const observer=new MutationObserver(()=>{observer.disconnect();translateLegacy();observer.observe(document.body,{childList:true,subtree:true,characterData:true});});translateLegacy();observer.observe(document.body,{childList:true,subtree:true,characterData:true});}

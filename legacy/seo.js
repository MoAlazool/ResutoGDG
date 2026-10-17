/* Search and answer-engine output: the per-route <head>, structured data, a
   readable fallback inside #app for clients that do not run the page script,
   and robots.txt, sitemap.xml and llms.txt. Everything stated here is drawn
   from the plan data and the approved pricing copy, so it cannot drift. */
import {plans} from './restaurant-experience.js';
import {faq} from './public/plan-comparison.js';

const VERSION='1';
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pick=(s,ar)=>s.split('|')[ar?1:0];
const PUBLIC={
 '/':['Resuto: restaurant reservations, QR ordering, kitchen display and split bills|ريسوتو: حجوزات المطاعم وطلبات QR وشاشة المطبخ وتقسيم الفاتورة','Resuto runs a restaurant’s service in one system: a floor plan guests book from, QR table ordering, a kitchen board, split bills and a manager view. In Arabic and English, from 799 EGP a month.|ريسوتو يدير خدمة المطعم في نظام واحد: مخطط صالة يحجز منه الضيوف، وطلبات QR من الطاولة، وشاشة المطبخ، وتقسيم الفاتورة، وشاشة المدير. بالعربية والإنجليزية، ابتداءً من ٧٩٩ جنيهًا شهريًا.'],
 '/pricing':['Resuto pricing: plans from 799 EGP a month|أسعار ريسوتو: خطط تبدأ من ٧٩٩ جنيهًا شهريًا','Compare Resuto’s Starter, Growth, Pro and Business plans feature by feature, with prices in Egyptian pounds, add-ons, a 14-day trial and a side-by-side look at Foodics Basic.|قارن خطط ريسوتو Starter وGrowth وPro وBusiness ميزة بميزة، مع الأسعار بالجنيه المصري والإضافات وتجربة ١٤ يومًا ومقارنة مع الباقة الأساسية من فودكس.'],
 '/restaurant':['The Olive Room demo restaurant · Resuto|مطعم تجريبي · ريسوتو','Try Resuto as a guest: open the demo restaurant, browse the menu, order from a table and split the bill. Nothing is charged.|جرّب ريسوتو كضيف: افتح المطعم التجريبي، تصفّح القائمة، اطلب من الطاولة وقسّم الفاتورة. دون أي خصم.'],
 '/menu':['Demo menu and online ordering · Resuto|قائمة تجريبية وطلب أونلاين · ريسوتو','Browse the demo restaurant’s bilingual menu and place a test pickup or delivery order with Resuto.|تصفّح القائمة التجريبية بالعربية والإنجليزية وجرّب طلب استلام أو توصيل مع ريسوتو.'],
 '/reserve':['Book a table on a real floor plan · Resuto demo|احجز طاولة من مخطط الصالة · عرض ريسوتو','See how guests reserve with Resuto: pick a time, choose a table on the restaurant’s own floor plan and get a confirmation.|شاهد كيف يحجز الضيوف مع ريسوتو: اختر الوقت، ثم طاولة من مخطط صالة المطعم، واحصل على تأكيد.']
};
const FEATURES=[
 ['Floor plan and reservations|مخطط الصالة والحجوزات','Draw the room once. Guests book a specific table from it, and staff run service on the same plan.|ارسم الصالة مرة واحدة. يحجز الضيوف طاولة محددة منها، ويدير الفريق الخدمة على المخطط نفسه.'],
 ['QR table ordering|طلبات QR من الطاولة','Guests scan the table’s QR code and order from the live menu in a browser, with no app or account.|يمسح الضيوف رمز الطاولة ويطلبون من القائمة الحالية في المتصفح دون تطبيق أو حساب.'],
 ['Kitchen display|شاشة المطبخ','Orders reach one kitchen board the moment they are confirmed. Each line shows its station, and the guest sees the status the kitchen sets.|تصل الطلبات إلى شاشة المطبخ لحظة تأكيدها. كل صنف يعرض قسمه، ويرى الضيف الحالة التي يحددها المطبخ.'],
 ['Split bills|تقسيم الفاتورة','A table can split its bill equally, by item or by custom amounts. Each guest pays on their own phone and gets a receipt.|يمكن تقسيم فاتورة الطاولة بالتساوي أو حسب الأصناف أو بمبالغ مخصصة. كل ضيف يدفع من هاتفه ويستلم إيصالًا.'],
 ['Menu import|استيراد القائمة','Upload a PDF, a photo or a CSV file. Resuto drafts the dishes and prices in Arabic and English, and nothing is published until you approve it.|ارفع ملف PDF أو صورة أو ملف CSV. يعدّ ريسوتو مسودة بالأصناف والأسعار بالعربية والإنجليزية، ولا يُنشر شيء قبل اعتمادك.'],
 ['Manager view|شاشة المدير','Today’s revenue, orders, ratings, station load and low stock in one place.|إيرادات اليوم والطلبات والتقييمات وضغط الأقسام والمخزون المنخفض في مكان واحد.']
];
const priced=plans.filter(p=>p.monthly);
const planLine=(p,ar)=>ar?`${p.name}: ${p.monthly} جنيهًا شهريًا`:`${p.name}: ${p.monthly.toLocaleString('en-US')} EGP a month`;

function fallback(path,ar){
 const link=(href,en,arText)=>`<a href="${href}${ar?(href.includes('?')?'&':'?')+'lang=ar':''}">${ar?arText:en}</a>`;
 if(path==='/pricing')return `<main class="seo-shell"><h1>${ar?'أسعار ريسوتو':'Resuto pricing'}</h1><p>${esc(pick(PUBLIC['/pricing'][1],ar))}</p><ul>${priced.map(p=>`<li>${esc(planLine(p,ar))}</li>`).join('')}<li>${ar?'Business: سعر حسب الاتفاق':'Business: priced by agreement'}</li></ul>${faq.map(([q,a])=>`<h2>${esc(pick(q,ar))}</h2><p>${esc(pick(a,ar))}</p>`).join('')}<p>${link('/','Resuto home','الرئيسية')}</p></main>`;
 if(path==='/')return `<main class="seo-shell"><h1>${ar?'أدِر الصالة. وريسوتو يدير كل ما عدا ذلك.':'Run the room. Resuto runs everything else.'}</h1><p>${esc(pick(PUBLIC['/'][1],ar))}</p>${FEATURES.map(([h,b])=>`<h2>${esc(pick(h,ar))}</h2><p>${esc(pick(b,ar))}</p>`).join('')}<p>${link('/pricing','See pricing and compare plans','الأسعار ومقارنة الخطط')} · ${link('/restaurant','Open the live demo','جرّب العرض المباشر')}</p></main>`;
 return '';
}

function structured(path,origin,ar){
 const org={'@type':'Organization','@id':origin+'/#org',name:'Resuto',url:origin+'/',logo:origin+'/assets/resuto-icon.png'};
 const graph=[org,{'@type':'WebSite','@id':origin+'/#site',url:origin+'/',name:'Resuto',publisher:{'@id':org['@id']},inLanguage:['en','ar']}];
 if(path==='/'||path==='/pricing')graph.push({'@type':'SoftwareApplication','@id':origin+'/#app',name:'Resuto',applicationCategory:'BusinessApplication',applicationSubCategory:'Restaurant management software',operatingSystem:'Web',url:origin+'/',description:pick(PUBLIC['/'][1],ar),inLanguage:['en','ar'],featureList:FEATURES.map(f=>pick(f[0],ar)),publisher:{'@id':org['@id']},
  offers:priced.map(p=>({'@type':'Offer',name:p.name,price:String(p.monthly),priceCurrency:'EGP',url:origin+'/pricing',category:'Monthly subscription'}))});
 if(path==='/pricing')graph.push({'@type':'FAQPage','@id':origin+'/pricing#faq',mainEntity:faq.map(([q,a])=>({'@type':'Question',name:pick(q,ar),acceptedAnswer:{'@type':'Answer',text:pick(a,ar)}}))});
 return JSON.stringify({'@context':'https://schema.org','@graph':graph}).replace(/</g,'\\u003c');
}

const langOf=url=>url.searchParams.get('lang')==='ar'?'ar':'en';
/* Distinguishes one rendered shell from another, for the ETag. */
export const shellKey=url=>VERSION+(PUBLIC[url.pathname]?url.pathname.length:0)+langOf(url);

export function renderShell(html,url,origin){
 const path=url.pathname,ar=langOf(url)==='ar',meta=PUBLIC[path];
 const title=meta?pick(meta[0],ar):'Resuto',desc=meta?pick(meta[1],ar):'';
 const self=origin+path,arUrl=self+'?lang=ar';
 // Staff screens, accounts and guest sessions are not for search results.
 const head=meta?`<meta name="description" content="${esc(desc)}">
 <link rel="canonical" href="${ar?arUrl:self}">
 <link rel="alternate" hreflang="en" href="${self}">
 <link rel="alternate" hreflang="ar" href="${arUrl}">
 <link rel="alternate" hreflang="x-default" href="${self}">
 <meta name="robots" content="index,follow,max-image-preview:large">
 <meta property="og:type" content="website">
 <meta property="og:site_name" content="Resuto">
 <meta property="og:title" content="${esc(title)}">
 <meta property="og:description" content="${esc(desc)}">
 <meta property="og:url" content="${ar?arUrl:self}">
 <meta property="og:locale" content="${ar?'ar_EG':'en_US'}">
 <meta property="og:image" content="${origin}/assets/og-resuto.png">
 <meta property="og:image:width" content="1200">
 <meta property="og:image:height" content="630">
 <meta name="twitter:card" content="summary_large_image">
 <script type="application/ld+json">${structured(path,origin,ar)}</script>`:'<meta name="robots" content="noindex,nofollow">';
 return html
  .replace('<html lang="en">',`<html lang="${ar?'ar':'en'}" dir="${ar?'rtl':'ltr'}">`)
  .replace(/ <meta name="description"[^>]*>\n/,'')
  .replace(/<title>[^<]*<\/title>/,`<title>${esc(title)}</title>\n <link rel="icon" type="image/png" href="/assets/resuto-icon.png">\n <link rel="apple-touch-icon" href="/assets/resuto-icon.png">\n <link rel="preload" href="/fonts/manrope.ttf" as="font" type="font/ttf" crossorigin>\n ${head}`)
  .replace('<div id="app"></div>',`<div id="app">${fallback(path,ar)}</div>`);
}

export function seoDocument(path,origin){
 if(path==='/robots.txt')return {type:'text/plain; charset=utf-8',body:`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /manager\nDisallow: /kitchen\nDisallow: /host\nDisallow: /account\nDisallow: /t/\nDisallow: /s/\nDisallow: /order\n\nSitemap: ${origin}/sitemap.xml\n`};
 if(path==='/sitemap.xml')return {type:'application/xml; charset=utf-8',body:`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${Object.keys(PUBLIC).map(p=>` <url><loc>${origin+p}</loc><xhtml:link rel="alternate" hreflang="en" href="${origin+p}"/><xhtml:link rel="alternate" hreflang="ar" href="${origin+p}?lang=ar"/></url>`).join('\n')}\n</urlset>\n`};
 // A plain summary for answer engines, kept to facts the product supports.
 return {type:'text/plain; charset=utf-8',body:`# Resuto\n\n> ${pick(PUBLIC['/'][1],false)}\n\nResuto is not a POS or cashier system and does not replace one.\n\n## What it does\n${FEATURES.map(([h,b])=>`- ${pick(h,false)}: ${pick(b,false)}`).join('\n')}\n\n## Pricing (Egyptian pounds, per month)\n${priced.map(p=>'- '+planLine(p,false)).join('\n')}\n- Business: priced by agreement\n- Yearly billing costs ten months instead of twelve.\n- 14-day trial, no card needed. Subscription billing is not enabled yet.\n\n## Questions\n${faq.map(([q,a])=>`### ${pick(q,false)}\n${pick(a,false)}`).join('\n\n')}\n\n## Pages\n${Object.entries(PUBLIC).map(([p,m])=>`- [${pick(m[0],false)}](${origin+p})`).join('\n')}\n`};
}

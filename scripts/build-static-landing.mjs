/* Build the landing page as a static site (for Vercel or any static host).

   The landing page normally asks the Resuto server for the demo restaurant.
   Here that data comes from a saved snapshot, so the page needs no server.
   Every other route (demo restaurant, booking, staff, pricing) is redirected
   to the running app by vercel.json.

     node scripts/build-static-landing.mjs              build into dist-landing/
     node scripts/build-static-landing.mjs --snapshot   refresh the snapshot from a
                                                        local server (npm start) first

   SITE_ORIGIN  where the static site is served   (default https://resuto.vercel.app)
   APP_URL      the running Resuto app            (default https://resutogdg.onrender.com) */
import {cpSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderShell} from '../seo.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pub=path.join(root,'public'),out=path.join(root,'dist-landing'),snapshotFile=path.join(root,'scripts','landing-snapshot.json');
const SITE=process.env.SITE_ORIGIN||'https://resuto.vercel.app',APP=process.env.APP_URL||'https://resutogdg.onrender.com';

if(process.argv.includes('--snapshot')){
 const from=process.env.SNAPSHOT_FROM||'http://localhost:3000';
 const data=await (await fetch(from+'/api/public')).json();
 // Table QR tokens belong to the installation they came from; the static page only needs a picture.
 data.tables.forEach(t=>{t.qr='demo'});
 const {default:QRCode}=await import('qrcode');
 const qr=await QRCode.toString(APP+'/restaurant',{type:'svg',margin:2});
 writeFileSync(snapshotFile,JSON.stringify({public:data,plans:await (await fetch(from+'/api/plans')).json(),qr},null,1)+'\n');
 console.log('snapshot refreshed from',from);
}
const snap=JSON.parse(readFileSync(snapshotFile,'utf8'));

// Follow the page's own imports so only what the landing page loads is shipped.
const scripts=new Set();
(function walk(file){
 if(scripts.has(file))return;
 scripts.add(file);
 const src=readFileSync(path.join(pub,file),'utf8');
 for(const m of src.matchAll(/(?:from|import)\s*\(?\s*'(\.\/[^']+\.js)'/g)){
  const next=path.posix.join(path.posix.dirname(file),m[1]);
  // entry.js routes to other pages' modules; the static site only serves the landing page.
  if(file==='entry.js'&&!['i18n.js','landing.js'].includes(next))continue;
  walk(next);
 }
})('entry.js');

rmSync(out,{recursive:true,force:true});
for(const f of scripts){mkdirSync(path.dirname(path.join(out,f)),{recursive:true});cpSync(path.join(pub,f),path.join(out,f))}
readdirSync(pub).filter(f=>f.endsWith('.css')).forEach(f=>cpSync(path.join(pub,f),path.join(out,f)));
cpSync(path.join(pub,'fonts'),path.join(out,'fonts'),{recursive:true});
mkdirSync(path.join(out,'assets'));
// Only images the landing page references.
const used=[...scripts].map(f=>readFileSync(path.join(pub,f),'utf8')).join('')+readFileSync(path.join(pub,'landing.css'),'utf8')+readFileSync(path.join(root,'seo.js'),'utf8');
readdirSync(path.join(pub,'assets')).filter(f=>used.includes('/assets/'+f)).forEach(f=>cpSync(path.join(pub,'assets',f),path.join(out,'assets',f)));

mkdirSync(path.join(out,'data'));
writeFileSync(path.join(out,'data','public.json'),JSON.stringify(snap.public));
writeFileSync(path.join(out,'data','plans.json'),JSON.stringify(snap.plans));
writeFileSync(path.join(out,'data','capabilities.json'),JSON.stringify({native:true,connectors:[],payments:[]}));
writeFileSync(path.join(out,'data','qr.svg'),snap.qr);

writeFileSync(path.join(out,'index.html'),renderShell(readFileSync(path.join(pub,'index.html'),'utf8'),new URL(SITE+'/'),SITE));
writeFileSync(path.join(out,'robots.txt'),`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
writeFileSync(path.join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n <url><loc>${SITE}/</loc><xhtml:link rel="alternate" hreflang="en" href="${SITE}/"/><xhtml:link rel="alternate" hreflang="ar" href="${SITE}/?lang=ar"/></url>\n</urlset>\n`);
console.log(`built dist-landing: ${scripts.size} scripts, ${readdirSync(path.join(out,'assets')).length} images, site ${SITE}, app ${APP}`);

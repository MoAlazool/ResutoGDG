// Original flat illustrations for the Smash & Co catalogue.
//
// The photography sheet in /assets is Olive Room food, and there is no burger
// imagery to draw on, so this storefront is illustrated rather than shot. Flat
// marks also suit a fast-food identity better than borrowed photos would, and
// nothing here pretends to be a photograph of real food.
const F={bun:'#e8a33d',bunHi:'#f2bd62',meat:'#6b3a22',cheese:'#ffc531',salad:'#4f9e46',tomato:'#d8422c',
 potato:'#f0b840',cup:'#e8ded0',shake:'#5a3826',cream:'#fff6e8',plate:'#241e1a',onion:'#e9d5b5'};

const wrap=inner=>`<svg viewBox="0 0 120 120" role="presentation" aria-hidden="true"><rect width="120" height="120" fill="none"/>${inner}</svg>`;

const burger=(patties=1,accent=F.meat)=>{
 const rows=[];let y=72;
 for(let i=0;i<patties;i++){
  rows.push(`<rect x="26" y="${y}" width="68" height="9" rx="4.5" fill="${accent}"/>`);
  rows.push(`<path d="M26 ${y-5}h68l-5 6H31z" fill="${F.cheese}"/>`);
  y-=15;
 }
 return wrap(`
  <path d="M24 ${y+4}c0-16 16-26 36-26s36 10 36 26z" fill="${F.bun}"/>
  <path d="M32 ${y-6}c4-8 14-12 28-12s24 4 28 12" fill="none" stroke="${F.bunHi}" stroke-width="3" stroke-linecap="round"/>
  <circle cx="48" cy="${y-6}" r="2" fill="${F.bunHi}"/><circle cx="62" cy="${y-11}" r="2" fill="${F.bunHi}"/><circle cx="74" cy="${y-5}" r="2" fill="${F.bunHi}"/>
  <path d="M24 ${y+4}h72v5H24z" fill="${F.salad}"/>
  ${rows.join('')}
  <rect x="24" y="83" width="72" height="12" rx="6" fill="${F.bun}"/>`);
};

const fries=(loaded=false)=>wrap(`
 <path d="M34 58h52l-6 44a6 6 0 0 1-6 5H46a6 6 0 0 1-6-5z" fill="${F.tomato}"/>
 ${[0,1,2,3,4].map(i=>`<rect x="${36+i*10}" y="${30+(i%2?8:0)}" width="8" height="34" rx="3" fill="${F.potato}"/>`).join('')}
 <rect x="34" y="58" width="52" height="9" rx="4" fill="#b8341f"/>
 ${loaded?`<path d="M38 56c8 6 36 6 44 0v6c-8 6-36 6-44 0z" fill="${F.cheese}"/><circle cx="52" cy="52" r="3" fill="${F.salad}"/><circle cx="70" cy="50" r="3" fill="${F.salad}"/>`:''}`);

const rings=()=>wrap(`
 <ellipse cx="60" cy="86" rx="34" ry="9" fill="${F.plate}"/>
 ${[[60,74,22],[46,58,17],[74,52,15]].map(([cx,cy,r])=>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${F.onion}" stroke-width="9"/>`).join('')}`);

const shake=()=>wrap(`
 <path d="M42 44h36l-5 54a7 7 0 0 1-7 6H54a7 7 0 0 1-7-6z" fill="${F.cup}"/>
 <path d="M46 62h28l-4 36a5 5 0 0 1-5 4h-10a5 5 0 0 1-5-4z" fill="${F.shake}"/>
 <ellipse cx="60" cy="42" rx="20" ry="7" fill="${F.cream}"/>
 <circle cx="54" cy="36" r="7" fill="${F.cream}"/><circle cx="66" cy="34" r="6" fill="${F.cream}"/>
 <rect x="72" y="16" width="5" height="30" rx="2.5" fill="${F.tomato}" transform="rotate(14 74 30)"/>`);

const cola=()=>wrap(`
 <path d="M44 40h32l-4 58a6 6 0 0 1-6 5H54a6 6 0 0 1-6-5z" fill="${F.tomato}"/>
 <path d="M48 56h24l-3 40a4 4 0 0 1-4 4h-10a4 4 0 0 1-4-4z" fill="#3a1108" opacity=".55"/>
 <ellipse cx="60" cy="39" rx="17" ry="6" fill="#f3f0ea"/>
 <rect x="74" y="14" width="5" height="32" rx="2.5" fill="#f3f0ea" transform="rotate(12 76 30)"/>`);

// Category first, then the specific dish, so a new menu row still gets a mark.
export function dishArt(item){
 const n=(item.name||'').toLowerCase(),c=(item.category||'').toLowerCase();
 if(n.includes('double'))return burger(2);
 if(n.includes('chicken'))return burger(1,'#c98a3a');
 if(n.includes('veggie'))return burger(1,'#5f7d3c');
 if(c.includes('burger'))return burger(1);
 if(n.includes('loaded'))return fries(true);
 if(n.includes('ring'))return rings();
 if(c.includes('side'))return fries();
 if(c.includes('shake'))return shake();
 return cola();
}

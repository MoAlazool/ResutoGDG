"""Manager and kitchen across widths and both languages: overflow, untranslated
strings and render errors."""
import sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
env = dict(l.split('=', 1) for l in (ROOT / '.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
OUT = ROOT / 'artifacts' / 'audit'; OUT.mkdir(parents=True, exist_ok=True)
TABS = ['overview','floor','reservations','visits','orders','menu','inventory','customers','payments','analytics','branches','integrations','data','settings']
problems, latin = [], set()
SAFE = re.compile(r'^(Resuto|EGP|QR|AI|POS|SLA|API|WhatsApp|Stripe|Paymob|Foodics|Odoo|InstaPay|Gemini|T\d+|#\d+|[\d\W_]+|[A-Z]{1,3})$')

with sync_playwright() as p:
    b = p.chromium.launch()
    for role, path, password in [('manager', '/manager', env['MANAGER_PASSWORD']), ('kitchen', '/kitchen', env['KITCHEN_PASSWORD'])]:
        for lang in ['en', 'ar']:
            for w, h in [(1440, 950), (1024, 800), (768, 1024), (390, 844)]:
                ctx = b.new_context(viewport={'width': w, 'height': h}, is_mobile=w < 700, has_touch=w < 700)
                pg = ctx.new_page()
                label = f'{role}/{lang}/{w}'
                pg.on('pageerror', lambda e, l=label: problems.append(f'{l} | PAGEERROR | {e}'))
                pg.on('console', lambda m, l=label: problems.append(f'{l} | CONSOLE | {m.text[:130]}')
                      if m.type == 'error' and '401' not in m.text else None)
                pg.add_init_script("localStorage.setItem('resuto-language','%s')" % lang)
                pg.goto(ORIGIN + path, wait_until='networkidle')
                if pg.locator('input[type="password"]').count():
                    pg.locator('input[type="password"]').fill(password)
                    pg.locator('form button, button[type="submit"]').first.click()
                pg.wait_for_timeout(1200)
                if lang == 'ar' and pg.locator('html').get_attribute('dir') != 'rtl':
                    problems.append(f'{label} | DIR | html dir is not rtl')
                tabs = TABS if role == 'manager' else ['orders']
                for tab in tabs:
                    loc = pg.locator(f'[data-action="tab"][data-id="{tab}"]')
                    if loc.count():
                        loc.first.click(); pg.wait_for_timeout(360)
                    sw = pg.evaluate('document.documentElement.scrollWidth')
                    iw = pg.evaluate('document.documentElement.clientWidth')
                    if sw > iw + 1:
                        who = pg.evaluate("""(()=>{const W=document.documentElement.clientWidth,out=[];
                          document.querySelectorAll('body *').forEach(el=>{if(el.ownerSVGElement)return;const r=el.getBoundingClientRect();
                          if(r.width>2&&(r.right>W+1||r.left<-1)){let q=el.parentElement,clip=false;
                            while(q){const cs=getComputedStyle(q);if(['auto','scroll','hidden','clip'].includes(cs.overflowX)){clip=true;break}q=q.parentElement}
                            if(!clip)out.push(el.tagName+'.'+(typeof el.className==='string'?el.className.slice(0,40):''))}});
                          return [...new Set(out)].slice(0,4)})()""")
                        problems.append(f'{label}/{tab} | OVERFLOW | {sw}>{iw} {who}')
                    if lang == 'ar' and w == 1440:
                        for line in (pg.locator('.page').inner_text() if pg.locator('.page').count() else '').splitlines():
                            s = line.strip()
                            if s and re.search(r'[A-Za-z]{4,}', s) and not SAFE.match(s):
                                latin.add(f'{tab}: {s[:70]}')
                if w == 390:
                    pg.screenshot(path=str(OUT / f'{role}-{lang}-390.png'), full_page=True)
                if w == 1440 and lang == 'ar':
                    pg.screenshot(path=str(OUT / f'{role}-ar-1440.png'), full_page=True)
                ctx.close()
    b.close()

print('=== PROBLEMS ===' if problems else '=== NO LAYOUT/RUNTIME PROBLEMS ===')
for x in problems: print(' -', x)
print(f'\n=== UNTRANSLATED IN ARABIC ({len(latin)}) ===')
for x in sorted(latin)[:40]: print(' -', x)

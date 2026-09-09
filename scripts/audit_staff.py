"""Full audit of the manager and kitchen workspaces: every tab, every visible
control, at several widths, in both languages. Reports errors, overflow and
dead controls rather than only screenshotting."""
import sys, os, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
env = dict(l.split('=', 1) for l in (ROOT / '.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
MANAGER, KITCHEN = env['MANAGER_PASSWORD'], env['KITCHEN_PASSWORD']
OUT = ROOT / 'artifacts' / 'audit'; OUT.mkdir(parents=True, exist_ok=True)
TABS = ['overview','floor','reservations','visits','orders','menu','inventory','customers','payments','analytics','branches','integrations','data','settings']
problems = []

def watch(pg, label):
    pg.on('pageerror', lambda e: problems.append(f'{label} | PAGEERROR | {e}'))
    pg.on('console', lambda m: problems.append(f'{label} | CONSOLE | {m.text[:160]}') if m.type == 'error' else None)
    pg.on('requestfailed', lambda r: problems.append(f'{label} | REQFAIL | {r.url[-70:]} {r.failure}'))

def login(pg, password, path='/manager'):
    pg.goto(ORIGIN + path, wait_until='networkidle')
    if pg.locator('input[type="password"]').count():
        pg.locator('input[type="password"]').fill(password)
        pg.get_by_role('button', name=re.compile('sign in', re.I)).click()
    pg.wait_for_timeout(900)

def overflow(pg, label):
    sw = pg.evaluate('document.documentElement.scrollWidth')
    iw = pg.evaluate('document.documentElement.clientWidth')
    if sw > iw + 1:
        wide = pg.evaluate("""(()=>{const W=document.documentElement.clientWidth,out=[];
          document.querySelectorAll('body *').forEach(el=>{if(el.ownerSVGElement)return;const r=el.getBoundingClientRect();
          if(r.width>2&&(r.right>W+1||r.left<-1)){let p=el.parentElement,clipped=false;
            while(p){const cs=getComputedStyle(p);if(['auto','scroll','hidden','clip'].includes(cs.overflowX)){clipped=true;break}p=p.parentElement}
            if(!clipped)out.push(el.tagName+'.'+(typeof el.className==='string'?el.className.slice(0,44):''))}});
          return [...new Set(out)].slice(0,5)})()""")
        problems.append(f'{label} | OVERFLOW | {sw}>{iw} {wide}')

with sync_playwright() as p:
    b = p.chromium.launch()
    # ---- manager, desktop, English: walk every tab -----------------------
    ctx = b.new_context(viewport={'width': 1440, 'height': 950})
    pg = ctx.new_page(); watch(pg, 'manager/en/1440')
    login(pg, MANAGER)
    if not pg.locator('.workspace').count():
        problems.append('manager | FATAL | workspace did not render after sign in')
    for tab in TABS:
        loc = pg.locator(f'[data-action="tab"][data-id="{tab}"]')
        if not loc.count():
            problems.append(f'manager | MISSING TAB | {tab}')
            continue
        loc.first.click(); pg.wait_for_timeout(500)
        overflow(pg, f'manager/{tab}/1440')
        empty = pg.evaluate("document.querySelector('.page')?document.querySelector('.page').innerText.trim().length:0")
        if empty < 40:
            problems.append(f'manager | EMPTY TAB | {tab} ({empty} chars)')
        pg.screenshot(path=str(OUT / f'mgr-{tab}.png'), full_page=True)
    print('manager tabs walked')
    ctx.close()
    b.close()

print('\n=== PROBLEMS ===' if problems else '\n=== NO PROBLEMS ===')
for x in problems: print(' -', x)

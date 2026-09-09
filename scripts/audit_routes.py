"""Every public route renders, and every internal link on every page resolves."""
import sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
env = dict(l.split('=', 1) for l in (ROOT / '.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
problems = []

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1280, 'height': 900})
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: problems.append(f'PAGEERROR | {e}'))
    tables = pg.request.get(ORIGIN + '/api/public').json()['tables']
    routes = ['/', '/restaurant', '/menu', '/reserve', '/pricing', '/order', '/t/' + tables[0]['qr']]
    links = set()
    for r in routes:
        pg.goto(ORIGIN + r, wait_until='networkidle'); pg.wait_for_timeout(1400)
        text = pg.evaluate("document.body.innerText.trim().length")
        if text < 60:
            problems.append(f'{r} | EMPTY | {text} chars')
        for href in pg.evaluate("[...document.querySelectorAll('a[href]')].map(a=>a.getAttribute('href'))"):
            if href and href.startswith('/') and not href.startswith('//'):
                links.add(href.split('#')[0] or '/')
        print(f'OK {r} ({text} chars)', flush=True)
    for href in sorted(links):
        res = pg.request.get(ORIGIN + href)
        if res.status >= 400:
            problems.append(f'LINK {href} | HTTP {res.status}')
    print(f'\nchecked {len(links)} distinct internal links: {sorted(links)}')
    b.close()

print('\n=== PROBLEMS ===' if problems else '\n=== ALL ROUTES AND LINKS OK ===')
for x in problems: print(' -', x)

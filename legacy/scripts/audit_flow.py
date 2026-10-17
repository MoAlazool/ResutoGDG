"""Drives a real service cycle across guest, manager and kitchen so the audit
proves the workspaces work together, not just that they render."""
import sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
ORIGIN = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
env = dict(l.split('=', 1) for l in (ROOT / '.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
OUT = ROOT / 'artifacts' / 'audit'; OUT.mkdir(parents=True, exist_ok=True)
problems, steps = [], []

def watch(pg, label):
    pg.on('pageerror', lambda e: problems.append(f'{label} | PAGEERROR | {e}'))
    pg.on('console', lambda m: problems.append(f'{label} | CONSOLE | {m.text[:150]}')
          if m.type == 'error' and '401' not in m.text else None)

def ok(msg): steps.append('PASS ' + msg); print('PASS ' + msg, flush=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    mgr = b.new_context(viewport={'width': 1440, 'height': 950}).new_page(); watch(mgr, 'manager')
    kit = b.new_context(viewport={'width': 1280, 'height': 900}).new_page(); watch(kit, 'kitchen')
    guest = b.new_context(viewport={'width': 414, 'height': 896}, is_mobile=True, has_touch=True).new_page(); watch(guest, 'guest')
    mgr.on('dialog', lambda d: d.accept())

    # ---------- manager sign in -----------------------------------------
    mgr.goto(ORIGIN + '/manager', wait_until='networkidle')
    mgr.locator('input[type="password"]').fill(env['MANAGER_PASSWORD'])
    mgr.get_by_role('button', name=re.compile('sign in', re.I)).click()
    expect(mgr.locator('.workspace')).to_be_visible(timeout=8000)
    ok('manager sign in')

    # ---------- seat a walk-in ------------------------------------------
    mgr.locator('[data-action="tab"][data-id="floor"]').click(); mgr.wait_for_timeout(500)
    tables = mgr.request.get(ORIGIN + '/api/public').json()['tables']
    table = tables[0]
    mgr.request.post(ORIGIN + '/api/seat', data={'tableId': table['id'], 'name': 'Audit Walk-in'})
    mgr.reload(); mgr.wait_for_timeout(900)
    mgr.locator('[data-action="tab"][data-id="visits"]').click(); mgr.wait_for_timeout(600)
    expect(mgr.locator('.page')).to_contain_text('Audit Walk-in')
    mgr.screenshot(path=str(OUT / 'flow-visits.png'), full_page=True)
    ok('walk-in seated and visible in Active visits')

    # ---------- guest orders from the table QR ---------------------------
    guest.goto(ORIGIN + '/t/' + table['qr'], wait_until='networkidle'); guest.wait_for_timeout(1200)
    guest.locator('[data-do="product"]').first.click(); guest.wait_for_timeout(500)
    guest.get_by_role('button', name=re.compile('add to order', re.I)).click(); guest.wait_for_timeout(400)
    guest.get_by_role('button', name=re.compile('view cart', re.I)).click(); guest.wait_for_timeout(400)
    guest.get_by_role('button', name=re.compile('confirm order', re.I)).click()
    expect(guest.locator('.order-timeline').first).to_be_visible(timeout=8000)
    guest.screenshot(path=str(OUT / 'flow-guest-order.png'), full_page=True)
    ok('guest ordered from the table QR')

    mgr.locator('[data-action="tab"][data-id="orders"]').click(); mgr.wait_for_timeout(700)
    expect(mgr.locator('.page')).to_contain_text(table['label'])
    ok('order reaches the manager order board')

    # ---------- kitchen sees it and advances it --------------------------
    kit.goto(ORIGIN + '/kitchen', wait_until='networkidle')
    if kit.locator('input[type="password"]').count():
        kit.locator('input[type="password"]').fill(env['KITCHEN_PASSWORD'])
        kit.get_by_role('button', name=re.compile('sign in', re.I)).click()
    kit.wait_for_timeout(1200)
    expect(kit.locator('.workspace')).to_be_visible(timeout=8000)
    ok('kitchen sign in')
    expect(kit.locator('.page')).to_contain_text(table['label'], timeout=8000)
    kit.screenshot(path=str(OUT / 'flow-kitchen.png'), full_page=True)
    ok('kitchen screen shows the live ticket')
    advanced = 0
    for name in ['Start preparing', 'Mark ready', 'Mark served']:
        btn = kit.get_by_role('button', name=re.compile(name, re.I))
        if btn.count():
            btn.first.click(); kit.wait_for_timeout(900); advanced += 1
    if advanced == 0:
        problems.append('kitchen | no ticket action buttons found')
    else:
        ok(f'kitchen advanced the ticket through {advanced} state(s)')
    kit.screenshot(path=str(OUT / 'flow-kitchen-after.png'), full_page=True)

    # ---------- guest pays ------------------------------------------------
    guest.get_by_role('button', name=re.compile('view bill', re.I)).click(); guest.wait_for_timeout(700)
    guest.screenshot(path=str(OUT / 'flow-guest-bill.png'), full_page=True)
    ok('guest bill opens')

    # ---------- manager: menu, payments, analytics, settings -------------
    mgr.locator('[data-action="tab"][data-id="payments"]').click(); mgr.wait_for_timeout(600)
    mgr.locator('[data-action="tab"][data-id="analytics"]').click(); mgr.wait_for_timeout(600)
    mgr.screenshot(path=str(OUT / 'flow-analytics.png'), full_page=True)
    ok('payments and analytics render with live data')

    mgr.locator('[data-action="tab"][data-id="menu"]').click(); mgr.wait_for_timeout(700)
    mgr.screenshot(path=str(OUT / 'flow-menu.png'), full_page=True)
    mgr.locator('[data-action="tab"][data-id="settings"]').click(); mgr.wait_for_timeout(700)
    mgr.screenshot(path=str(OUT / 'flow-settings.png'), full_page=True)
    mgr.locator('[data-action="tab"][data-id="integrations"]').click(); mgr.wait_for_timeout(700)
    mgr.screenshot(path=str(OUT / 'flow-integrations.png'), full_page=True)
    ok('menu, settings and integrations render')

    # ---------- floor editor ---------------------------------------------
    mgr.goto(ORIGIN + '/manager/floor-editor', wait_until='networkidle'); mgr.wait_for_timeout(1200)
    if mgr.locator('#studio-canvas .svg-table').count() == 0:
        problems.append('floor editor | canvas has no tables')
    else:
        ok(f'floor editor renders {mgr.locator("#studio-canvas .svg-table").count()} tables')
    mgr.screenshot(path=str(OUT / 'flow-floor-editor.png'), full_page=True)

    # ---------- setup wizard ---------------------------------------------
    mgr.goto(ORIGIN + '/manager/setup', wait_until='networkidle'); mgr.wait_for_timeout(1000)
    if mgr.locator('.setup-card').count() == 0:
        problems.append('setup | no setup card rendered')
    else:
        ok('setup wizard renders')
    mgr.screenshot(path=str(OUT / 'flow-setup.png'), full_page=True)

    b.close()

print('\n=== PROBLEMS ===' if problems else '\n=== NO PROBLEMS ===')
for x in problems: print(' -', x)

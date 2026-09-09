"""Real Chromium smoke test. Uses an isolated temporary database and test staff accounts.
Run: python scripts/browser_smoke.py
Requires: pip install playwright; python -m playwright install chromium
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "http://localhost:3100"

def run():
    with tempfile.TemporaryDirectory(prefix="resuto-browser-") as tmp:
        env = {**os.environ, "PORT": "3100", "APP_ORIGIN": ORIGIN,
               "DB_PATH": str(Path(tmp) / "smoke.sqlite"),
               "MANAGER_PASSWORD": "smoke-manager", "KITCHEN_PASSWORD": "smoke-kitchen"}
        # Never call a configured external model during this reproducible smoke test.
        env.pop("GEMINI_API_KEY", None)
        log = open(Path(tmp) / "server.log", "w")
        process = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(60):
                if process.poll() is not None:
                    raise RuntimeError("Test server exited. " + (Path(tmp) / "server.log").read_text())
                try:
                    urllib.request.urlopen(ORIGIN, timeout=1)
                    break
                except OSError:
                    time.sleep(.2)
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                errors = []
                contexts = []
                def page(mobile=False):
                    context = browser.new_context(viewport={"width": 390 if mobile else 1440, "height": 844 if mobile else 1000}, is_mobile=mobile, has_touch=mobile)
                    contexts.append(context)
                    page = context.new_page()
                    page.on("pageerror", lambda err: errors.append(str(err)))
                    return page
                manager, kitchen, guest, second = page(), page(), page(True), page(True)
                for current, route, password in [(manager, '/manager', 'smoke-manager'), (kitchen, '/kitchen', 'smoke-kitchen')]:
                    current.goto(ORIGIN + route)
                    current.get_by_label('Password', exact=True).fill(password)
                    current.get_by_role('button', name='Sign in', exact=False).click()
                    expect(current.locator('.workspace')).to_be_visible()
                print('PASS separate manager and kitchen logins', flush=True)
                manager.locator('[data-action="walkin"]').click()
                manager.get_by_label('Guest name').fill('Smoke Guest')
                manager.locator('select[name="tableId"]').select_option('t1')
                manager.get_by_role('button', name='Start visit', exact=True).click()
                expect(manager.get_by_role('link', name='Open guest view')).to_be_visible()
                guest_url = manager.get_by_role('link', name='Open guest view').get_attribute('href')
                for current in [guest, second]:
                    current.goto(ORIGIN + guest_url)
                    expect(current.get_by_label('Visit PIN')).to_have_count(0)
                    expect(current.locator('.menu-grid')).to_be_visible()
                guest.locator('[data-action="add"][data-id="m0"]').click()
                lost_order_response = [False]
                def lose_order_response(route):
                    if not lost_order_response[0]:
                        route.fetch()
                        lost_order_response[0] = True
                        route.abort()
                    else:
                        route.continue_()
                guest.route('**/api/order', lose_order_response)
                guest.locator('[data-action="submit-order"]').click()
                expect(guest.locator('[data-action="submit-order"]')).to_be_enabled()
                guest.locator('[data-action="submit-order"]').click()
                expect(guest.locator('.order-card')).to_have_count(1)
                expect(kitchen.locator('.order-card')).to_have_count(1, timeout=8000)
                print('PASS shared QR visit; lost order response retries without duplication', flush=True)
                for label, state in [('Start preparing', 'preparing'), ('Mark ready', 'ready'), ('Mark served', 'served')]:
                    kitchen.get_by_role('button', name=label, exact=True).click()
                    started = time.monotonic()
                    expect(guest.locator('.order-card .badge')).to_have_text(state, timeout=8000)
                    elapsed = time.monotonic() - started
                    print(f'PASS guest receives {state} in {elapsed:.2f}s', flush=True)
                guest.get_by_role('button', name='View bill', exact=True).click()
                guest.get_by_label('Amount to pay').fill('50')
                lost_payment_response = [False]
                def lose_payment_response(route):
                    if not lost_payment_response[0]:
                        route.fetch()
                        lost_payment_response[0] = True
                        route.abort()
                    else:
                        route.continue_()
                guest.route('**/api/pay', lose_payment_response)
                guest.get_by_role('button', name='Continue with payment').click()
                expect(guest.get_by_role('button', name='Continue with payment')).to_be_enabled()
                guest.get_by_role('button', name='Continue with payment').click()
                expect(guest.locator('dialog')).to_have_count(0)
                second.get_by_role('button', name='View bill', exact=True).click()
                expect(second.get_by_label('Amount to pay')).to_have_value('95')
                second.get_by_role('button', name='Continue with payment').click()
                expect(second.locator('dialog')).to_have_count(0)
                expect(manager.locator('.table-detail .bill-row strong')).to_have_text('EGP 0', timeout=8000)
                manager.locator('[data-action="close-visit"]').click()
                manager.locator('[data-action="confirm-close"]').click()
                expect(manager.locator('[data-action="clean"]')).to_be_visible()
                manager.locator('[data-action="clean"]').click()
                expect(manager.locator('.table-detail .badge')).to_have_text('available')
                print('PASS split payment, close, and cleaning', flush=True)

                # A reservation is made through the actual floor selection form.
                guest.goto(ORIGIN + '/reserve')
                guest.get_by_label('Your name', exact=True).fill('Reservation Guest')
                guest.get_by_label('Phone or email').fill('fictional@example.test')
                cairo_start = guest.evaluate("new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(Date.now()+300000)).replace(' ','T')")
                guest.get_by_label('Date & time').fill(cairo_start)
                guest.locator('[data-action="select-table"][data-id="t2"]').click()
                guest.get_by_role('button', name='Hold this table').click()
                guest.get_by_role('button', name='Confirm test deposit').click()
                expect(guest.get_by_text('Your table is confirmed', exact=True)).to_be_visible()
                guest.get_by_role('button', name='Done', exact=True).click()
                manager.locator('[data-action="tab"][data-id="reservations"]').click()
                expect(manager.get_by_text('Reservation Guest', exact=True)).to_be_visible(timeout=8000)
                second.goto(ORIGIN + '/reserve')
                second.get_by_label('Date & time').fill(cairo_start)
                second.get_by_role('button', name='Check availability').click()
                expect(second.locator('[data-action="select-table"][data-id="t2"]')).to_have_attribute('aria-disabled', 'true')
                manager.get_by_role('button', name='Check in', exact=True).click()
                manager.locator('[data-action="tab"][data-id="visits"]').click()
                expect(manager.get_by_text('Reservation Guest', exact=True)).to_be_visible()
                state = manager.evaluate("fetch('/api/staff').then(r=>r.json())")
                reserved_visit = next(v for v in state['visits'] if v['name']=='Reservation Guest')
                assert reserved_visit['bill']['credit'] == 20000
                print('PASS reservation conflict, check-in and one-time deposit credit', flush=True)
                for kind in ['pickup', 'delivery']:
                    guest.goto(ORIGIN + '/menu')
                    guest.get_by_label('Order type').select_option(kind)
                    guest.get_by_label('Your name', exact=True).fill(kind.title() + ' Guest')
                    guest.get_by_label('Phone number').fill('01000000000')
                    guest.get_by_label('Delivery address').fill('Fictional test address')
                    guest.get_by_role('button', name='Explore the menu').click()
                    guest.locator('[data-action="add"][data-id="m0"]').click()
                    guest.locator('[data-action="submit-order"]').click()
                    expect(guest.locator('.order-card')).to_have_count(1)
                    expect(kitchen.locator('.order-card').filter(has_text=kind.title() + ' Guest')).to_have_count(1, timeout=8000)
                print('PASS pickup and delivery share the kitchen', flush=True)
                manager.locator('[data-action="tab"][data-id="floor"]').click()
                manager.locator('[data-action="layout"]').click()
                expect(manager.locator('#studio-canvas')).to_be_visible()
                table = manager.locator('#studio-canvas [data-object-id="t1"]')
                box = table.bounding_box()
                manager.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)
                manager.mouse.down()
                manager.mouse.move(box['x'] + box['width']/2 + 25, box['y'] + box['height']/2 + 10, steps=5)
                manager.mouse.up()
                manager.locator('[data-tool="save"]').click()
                expect(manager.locator('#draft-status')).to_have_text('✓ All changes saved')
                manager.get_by_role('link', name='Back to service').click()
                manager.locator('[data-action="select-table"][data-id="t1"]').click()
                expect(manager.get_by_role('link', name='Open guest view')).to_have_attribute('href', guest_url)
                print('PASS dedicated editor save preserves table QR URL', flush=True)
                for current in [manager, kitchen, guest, second]:
                    assert current.evaluate('document.documentElement.scrollWidth') <= current.viewport_size['width'], 'Horizontal page overflow: ' + current.url
                before_restart = manager.evaluate("fetch('/api/staff').then(r=>r.json())")
                process.terminate()
                process.wait(timeout=10)
                process = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=log, stderr=log)
                for _ in range(60):
                    try:
                        urllib.request.urlopen(ORIGIN, timeout=1)
                        break
                    except OSError:
                        time.sleep(.2)
                after_restart = manager.evaluate("fetch('/api/staff').then(r=>r.json())")
                assert before_restart['orders'] == after_restart['orders']
                assert before_restart['reservations'] == after_restart['reservations']
                assert before_restart['tables'] == after_restart['tables']
                print('PASS server restart preserves orders, reservations, and floor identities', flush=True)
                assert not errors, errors
                artifacts = ROOT / 'artifacts'
                artifacts.mkdir(exist_ok=True)
                manager.reload()
                expect(manager.locator('.floor-panel')).to_be_visible()
                manager.screenshot(path=str(artifacts / 'manager.png'), full_page=True)
                guest.screenshot(path=str(artifacts / 'guest-mobile.png'), full_page=True)
                print('PASS desktop/mobile viewport widths and no page errors', flush=True)
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
            log.close()

if __name__ == '__main__':
    run()

"""QR preview, reviewed imports, exports, AI fallback and family split in Chromium."""
import os, subprocess, tempfile, time, json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://localhost:3102'
with tempfile.TemporaryDirectory(prefix='resuto-data-') as tmp:
 env={**os.environ,'PORT':'3102','APP_ORIGIN':ORIGIN,'DB_PATH':str(Path(tmp)/'data.sqlite'),'MANAGER_PASSWORD':'data-test','KITCHEN_PASSWORD':'kitchen-test','PAYMENT_MODE':'test'}
 env.pop('GEMINI_API_KEY',None)
 with open(Path(tmp)/'server.log','w') as log:
  process=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
  try:
   for _ in range(60):
    try: urllib.request.urlopen(ORIGIN,timeout=1);break
    except OSError: time.sleep(.2)
   with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);errors=[]
    manager=browser.new_page(viewport={'width':1440,'height':1000},accept_downloads=True)
    guest=browser.new_page(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    for page in [manager,guest]:page.on('pageerror',lambda e:errors.append(str(e)))
    tables=manager.request.get(ORIGIN+'/api/public').json()['tables'];qr=tables[0]['qr']
    guest.goto(ORIGIN+'/t/'+qr);expect(guest.locator('.dish-grid')).to_be_visible();expect(guest.get_by_label('Visit PIN')).to_have_count(0)
    guest.locator('[data-do="product"]').first.click();guest.get_by_role('button',name='Add to order').click();guest.get_by_role('button',name='View cart',exact=False).click();expect(guest.get_by_role('button',name='Checkout')).to_be_disabled();guest.get_by_role('button',name='Close').click()
    manager.goto(ORIGIN+'/manager');manager.get_by_label('Password',exact=True).fill('data-test');manager.get_by_role('button',name='Sign in',exact=False).click()
    manager.locator('[data-action="tab"][data-id="data"]').click()
    manager.locator('#menu-csv').set_input_files({'name':'menu.csv','mimeType':'text/csv','buffer':b'name,price_egp,stock,category,station\nCitrus salad,89.50,10,Starters,Cold kitchen'})
    manager.locator('#extract-menu').click();expect(manager.locator('[data-review-row]')).to_have_count(1);manager.get_by_role('button',name='Approve item').click();manager.get_by_role('button',name='Publish approved items').click();expect(manager.locator('#import-status')).to_contain_text('1 reviewed items published')
    with manager.expect_download() as downloaded:manager.locator('a[href="/api/export?kind=menu&format=csv"]').click()
    assert 'Citrus salad' in Path(downloaded.value.path()).read_text(encoding='utf8')
    manager.locator('#menu-csv').set_input_files([]);manager.locator('#menu-text').fill('Soup 50 EGP');manager.locator('#extract-menu').click();expect(manager.locator('#import-status')).to_contain_text('not configured')
    out=ROOT/'artifacts';out.mkdir(exist_ok=True);manager.screenshot(path=str(out/'data-workspace.png'),full_page=True)
    manager.request.post(ORIGIN+'/api/seat',data={'tableId':'t1','name':'Demo family'})
    expect(guest.get_by_role('button',name='View bill',exact=True)).to_be_visible(timeout=8000)
    guest.get_by_role('button',name='Help me choose').click();guest.get_by_role('button',name='Suggest a meal').click();expect(guest.locator('#ai-result')).to_contain_text('Demo rules');guest.locator('[data-do="dismiss"]').click()
    guest.get_by_role('button',name='View cart',exact=False).click();guest.get_by_role('button',name='Confirm order').click();expect(guest.locator('.order-timeline')).to_have_count(1)
    guest.get_by_role('button',name='View bill',exact=True).click();guest.get_by_role('button',name='Split bill',exact=True).click();guest.get_by_role('button',name='Split equally',exact=True).click();guest.get_by_label('People',exact=True).fill('4');guest.get_by_role('button',name='Create payment links').click();expect(guest.locator('.share-row')).to_have_count(4)
    guest.screenshot(path=str(out/'family-split-mobile.png'),full_page=True)
    for width in [1440,390]:
     manager.set_viewport_size({'width':width,'height':1000 if width>600 else 844});manager.goto(ORIGIN+'/');expect(manager.locator('.lp-hero h1')).to_contain_text('Run the room.');assert manager.evaluate('document.documentElement.scrollWidth<=innerWidth');manager.screenshot(path=str(out/('saas-updated-'+str(width)+'.png')),full_page=True)
    assert not errors,errors
    print('PASS PIN-free menu preview, staff activation, CSV review/import/export, extraction configuration error, assistant, family split, landing desktop/mobile; no page errors',flush=True)
    browser.close()
  finally:process.terminate();process.wait(timeout=10)

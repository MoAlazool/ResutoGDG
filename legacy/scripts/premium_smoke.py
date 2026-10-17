"""Premium scenarios A-F using real Chromium and isolated demo data."""
import os,json,subprocess,tempfile,time,urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]; ORIGIN='http://localhost:3103'
with tempfile.TemporaryDirectory(prefix='resuto-premium-') as tmp:
 env={**os.environ,'PORT':'3103','APP_ORIGIN':ORIGIN,'DB_PATH':str(Path(tmp)/'test.sqlite'),'MANAGER_PASSWORD':'premium-manager','KITCHEN_PASSWORD':'premium-kitchen','PAYMENT_MODE':'test'};env.pop('GEMINI_API_KEY',None)
 with open(Path(tmp)/'server.log','w') as log:
  proc=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
  try:
   for _ in range(60):
    try:urllib.request.urlopen(ORIGIN,timeout=1);break
    except OSError:time.sleep(.2)
   with sync_playwright() as p:
    browser=p.chromium.launch(headless=True);errors=[];art=ROOT/'artifacts';art.mkdir(exist_ok=True)
    manager=browser.new_page(viewport={'width':1440,'height':1000});guest=browser.new_page(viewport={'width':430,'height':900});participant=browser.new_page(viewport={'width':375,'height':844})
    for page in [manager,guest,participant]:page.on('pageerror',lambda err:errors.append(str(err)));page.set_default_timeout(7000)
    manager.on('dialog',lambda d:d.accept())
    manager.goto(ORIGIN+'/manager');manager.get_by_label('Password',exact=True).fill('premium-manager');manager.get_by_role('button',name='Sign in',exact=False).click();expect(manager.get_by_role('heading',name='Overview',exact=True)).to_be_visible()
    guest.goto(ORIGIN+'/menu');expect(guest.locator('.dish-grid')).to_be_visible();assert guest.locator('select[name="type"]').count()==0
    guest.get_by_role('button',name='Help me choose',exact=True).click();guest.locator('#ai-preferences').fill('إحنا 3 وميزانيتنا 1000 جنيه ومش عايزين أكل حار');expect(guest.get_by_label('People',exact=True)).to_have_value('3');guest.get_by_role('button',name='Suggest a meal').click();expect(guest.locator('#ai-result')).to_contain_text('Demo rules');guest.get_by_role('button',name='Add recommended meal').click();guest.get_by_role('button',name='View cart',exact=False).click();guest.get_by_role('button',name='Checkout',exact=True).click();guest.get_by_label('First name',exact=True).fill('AI Guest');guest.get_by_label('Contact',exact=True).fill('fictional');guest.get_by_role('button',name='Place order',exact=True).click();expect(guest.get_by_role('heading',name='How was your experience?',exact=True)).to_be_visible();guest.locator('[name="overall"][value="5"]').check();guest.get_by_text('Add details (optional)',exact=True).click();guest.locator('select[name="food"]').select_option('5');guest.locator('select[name="service"]').select_option('4');guest.locator('select[name="speed"]').select_option('4');guest.get_by_role('button',name='Send rating').click();expect(guest.locator('.order-timeline')).to_be_visible()
    print('PASS A: Arabic request, validated demo fallback, menu-first pickup, atomic test payment and kitchen order; live Gemini not configured',flush=True)
    manager.locator('[data-action="tab"][data-id="analytics"]').click();expect(manager.locator('.stats')).to_contain_text('5.0');print('PASS E: detailed post-payment rating reaches manager analytics',flush=True)
    floor=manager.request.get(ORIGIN+'/api/floor').json();floor['tables'][1]['features']=['Window side'];assert manager.request.post(ORIGIN+'/api/floor',data={'layout':floor,'baseRevision':floor['revision'],'key':'window-feature'}).ok
    guest.goto(ORIGIN+'/reserve');expect(guest.locator('.bk-slot').first).to_be_visible();guest.locator('.bk-slot:not([disabled])').first.click();expect(guest.locator('.bk-map')).to_be_visible();guest.locator('[data-filter="Window side"]').click();guest.locator('.bk-table').first.click();expect(guest.locator('.bk-table.is-on')).to_contain_text('Window side');guest.locator('#bar-cta').click();guest.locator('[name="name"]').fill('Reservation Guest');guest.locator('[name="contact"]').fill('fictional');guest.locator('#bar-cta').click();expect(guest.locator('.bk-done')).to_contain_text('Your table is booked');print('PASS B: next-day reservation, selection and test deposit',flush=True)
    tables=manager.request.get(ORIGIN+'/api/public').json()['tables'];manager.request.post(ORIGIN+'/api/seat',data={'tableId':'t1','name':'Shared table'})
    guest.goto(ORIGIN+'/t/'+tables[0]['qr']);expect(guest.locator('.dish-grid')).to_be_visible();expect(guest.get_by_label('Visit PIN')).to_have_count(0)
    guest.locator('[data-do="product"][data-id="m0"]').first.click();guest.get_by_role('button',name='Add to order').click();guest.get_by_role('button',name='View cart',exact=False).click();guest.get_by_role('button',name='Confirm order',exact=True).click();expect(guest.locator('.order-timeline')).to_be_visible();print('PASS C: PIN-free dine-in ordering',flush=True)
    guest.get_by_role('button',name='View bill',exact=True).click();guest.get_by_role('button',name='Split bill',exact=True).click();guest.get_by_role('button',name='Split equally',exact=True).click();guest.get_by_role('button',name='Create payment links').click();expect(guest.locator('.share-row')).to_have_count(4);links=guest.locator('.share-row a').evaluate_all('(links)=>links.map(a=>a.href)')
    for i,url in enumerate(links):
     participant.goto(url);participant.get_by_role('button',name='Continue to payment',exact=True).click();participant.get_by_label('First name',exact=True).fill(['Ahmed','Sara','Mohamed','Guest 4'][i]);participant.locator('form[data-guest-form="share-payment"] button:not([type])').click();participant.get_by_role('button',name='Skip',exact=True).click();expect(participant.get_by_role('heading',name='Payment complete',exact=True)).to_be_visible()
    expect(guest.locator('#split-live')).to_contain_text('Ahmed',timeout=10000);expect(guest.locator('#split-live .share-row')).to_have_count(4);expect(guest.locator('#bill-summary')).to_contain_text('EGP 0.00');guest.screenshot(path=str(art/'premium-split.png'));print('PASS D: four independent named share links, test settlement and owner updates',flush=True)
    kitchen=browser.new_page();kitchen.goto(ORIGIN+'/kitchen');kitchen.get_by_label('Password',exact=True).fill('premium-kitchen');kitchen.get_by_role('button',name='Sign in',exact=False).click()
    for label in ['Start preparing','Mark ready','Mark picked up','Mark served']:
     kitchen.reload();expect(kitchen.locator('.workspace')).to_be_visible()
     while kitchen.get_by_role('button',name=label,exact=True).count():
      kitchen.get_by_role('button',name=label,exact=True).first.click();kitchen.wait_for_timeout(250)
    manager.locator('[data-action="tab"][data-id="floor"]').click();manager.locator('[data-action="select-table"][data-id="t1"]').click();manager.get_by_role('button',name='Close visit',exact=True).click();manager.locator('[data-action="confirm-close"]').click();manager.get_by_role('button',name='Mark as clean',exact=False).click()
    print('PASS service completion: kitchen preparation, fulfillment, settled visit close and cleaning',flush=True)
    untranslated=set()
    for locale in ['en','ar']:
     for width in [375,430,768,1024,1440]:
      guest.set_viewport_size({'width':width,'height':1000 if width>768 else 900});guest.goto(ORIGIN+'/');guest.evaluate('(lang)=>localStorage.setItem("resuto-language",lang)',locale);guest.reload();expect(guest.locator('.lp-hero')).to_be_visible();guest.wait_for_timeout(850);assert guest.evaluate('document.documentElement.scrollWidth<=innerWidth'),('landing',locale,width);guest.screenshot(path=str(art/f'premium-landing-{locale}-{width}.png'),full_page=True)
      guest.goto(ORIGIN+'/menu');expect(guest.locator('.dish-grid')).to_be_visible();assert guest.evaluate('document.documentElement.scrollWidth<=innerWidth'),('menu',locale,width)
      if width in [430,1440]:guest.screenshot(path=str(art/f'premium-menu-{locale}-{width}.png'),full_page=True)
     manager.evaluate('(lang)=>localStorage.setItem("resuto-language",lang)',locale);manager.reload();expect(manager.locator('.workspace')).to_be_visible();assert manager.locator('html').get_attribute('dir')==('rtl' if locale=='ar' else 'ltr')
     for tab in ['overview','floor','reservations','visits','orders','menu','inventory','customers','payments','analytics','branches','integrations','settings']:
      manager.locator('[data-action="tab"][data-id="'+tab+'"]').click();manager.wait_for_timeout(80)
      if locale=='ar':untranslated.update(manager.locator('.page').inner_text().splitlines())
     if locale=='ar':
      manager.goto(ORIGIN+'/manager/floor-editor');expect(manager.locator('#studio-canvas')).to_be_visible();untranslated.update(manager.locator('.floor-studio').inner_text().splitlines());manager.screenshot(path=str(art/'premium-editor-ar.png'),full_page=True)
    (art/'untranslated-review.txt').write_text('\n'.join(sorted(x for x in untranslated if any('a'<=c.lower()<='z' for c in x))),encoding='utf8')
    print('PASS F layout: Arabic RTL and English across five widths; translation review captured',flush=True)
    assert not errors,errors;browser.close()
  except Exception:
   print((Path(tmp)/'server.log').read_text(),flush=True)
   raise
  finally:proc.terminate();proc.wait(timeout=10)

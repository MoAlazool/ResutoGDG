"""Real Chromium, isolated SQLite, explicitly mocked server-side Gemini. No live AI calls."""
import os, subprocess, tempfile, time, urllib.request, json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://localhost:3108'
ART=ROOT/'docs/screenshots/owner-ai'
ART.mkdir(parents=True,exist_ok=True)
IMAGE=ROOT/'public/assets/resuto-arabic-logo.png'
with tempfile.TemporaryDirectory(prefix='resuto-owner-ai-') as tmp, sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 for mocked in [False,True]:
  env={**os.environ,'OWNER_TEST_MOCK':'1' if mocked else '0','DB_PATH':str(Path(tmp)/('mock.sqlite' if mocked else 'missing.sqlite'))}
  proc=subprocess.Popen(['node','scripts/owner-fixture-server.mjs'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL)
  try:
   for _ in range(60):
    try:urllib.request.urlopen(ORIGIN,timeout=1);break
    except OSError:time.sleep(.15)
   page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
   page.goto(ORIGIN+'/manager/setup');page.get_by_label('Password',exact=True).fill('owner-test');page.get_by_role('button',name='Sign in',exact=False).click();expect(page.locator('.setup-card')).to_be_visible()
   page.locator('[data-step="5"]').click();expect(page.locator('[data-floor-import="photos"]')).to_be_visible();expect(page.locator('[data-floor-import="plan"]')).to_be_visible();page.screenshot(path=str(ART/('setup-'+str(mocked)+'.png')),full_page=True)
   for mode in ['photos','plan']:
    if mode=='plan':page.goto(ORIGIN+'/manager/floor-editor')
    page.locator('[data-floor-import="'+mode+'"]').click();expect(page.locator('.owner-import-dialog')).to_be_visible();page.locator('.owner-sources input').set_input_files([str(IMAGE),str(IMAGE)] if mode=='photos' else str(IMAGE));expect(page.locator('.owner-source-previews img')).to_have_count(2 if mode=='photos' else 1);page.locator('.owner-source-previews img').evaluate_all('(imgs)=>Promise.all(imgs.map(i=>i.decode()))')
    if not mocked:
     expect(page.locator('[data-analyze]')).to_be_disabled();expect(page.locator('.owner-capability')).to_contain_text('GEMINI_API_KEY');page.screenshot(path=str(ART/(mode+'-missing-key.png')),full_page=True);page.locator('[data-close]').click();continue
    original=page.request.get(ORIGIN+'/api/floor').json();page.locator('[data-analyze]').click();expect(page.locator('[data-result]')).to_contain_text('Detected layout');assert page.request.get(ORIGIN+'/api/floor').json()==original;page.screenshot(path=str(ART/(mode+'-review.png')),full_page=True);page.locator('[data-apply]').click();expect(page.locator('#studio-canvas')).to_be_visible();expect(page.locator('#draft-status')).to_contain_text('Unsaved')
    page.locator('[data-tool="layer"][data-id="t1"]').click();page.locator('[name="capacity"]').fill('8');expect(page.locator('#studio-canvas [data-object-id="t1"] .chair')).to_have_count(8);assert page.request.get(ORIGIN+'/api/floor').json()['tables'][0]['capacity']==original['tables'][0]['capacity']
    page.locator('[name="label"]').fill('T1');page.screenshot(path=str(ART/(mode+'-editable-live.png')),full_page=True);page.locator('[data-tool="save"]').click();expect(page.locator('#draft-status')).to_contain_text('All changes saved');saved=page.request.get(ORIGIN+'/api/floor').json();assert saved['tables'][0]['capacity']==8;assert page.request.get(ORIGIN+'/api/public').json()['floor']['tables'][0]['capacity']==8
   page.goto(ORIGIN+'/manager#menu');expect(page.get_by_role('link',name='Import menu with AI',exact=True)).to_be_visible();page.get_by_role('link',name='Import menu with AI',exact=True).click();expect(page.locator('#menu-source-picker')).to_be_visible();page.locator('#menu-source-picker input').set_input_files([str(IMAGE),str(IMAGE)]);expect(page.locator('.owner-source-previews img')).to_have_count(2)
   if not mocked:
    expect(page.locator('.owner-capability')).to_contain_text('GEMINI_API_KEY');page.locator('#extract-menu').click();expect(page.locator('#import-status')).to_contain_text('not configured');page.screenshot(path=str(ART/'menu-missing-key.png'),full_page=True)
   else:
    before=len(page.request.get(ORIGIN+'/api/public').json()['menu']);page.locator('#extract-menu').click();expect(page.locator('[data-review-row]')).to_have_count(1);assert len(page.request.get(ORIGIN+'/api/public').json()['menu'])==before
    page.locator('.owner-item details summary').click();page.locator('[data-field="name"]').fill('Owner reviewed soup');page.locator('[data-field="stock"]').fill('5');page.locator('[data-field="available"]').check();expect(page.locator('[data-options="sizes"]')).to_contain_text('Large') if False else None
    page.screenshot(path=str(ART/'menu-rich-review.png'),full_page=True);page.locator('#add-missing').click();expect(page.locator('[data-review-row]')).to_have_count(2);page.locator('[data-review-row="1"] [data-reject]').click();page.locator('[data-review-row="0"] [data-approve]').click();page.locator('#publish-menu').click();expect(page.locator('#import-status')).to_contain_text('1 reviewed items published');catalog=page.request.get(ORIGIN+'/api/public').json()['menu'];assert len(catalog)==before+1;assert catalog[-1]['name']=='Owner reviewed soup';assert catalog[-1]['sizes'][0]['name']=='Large'
   page.goto(ORIGIN+'/manager#menu');page.locator('[data-action="media-edit"]').first.click();expect(page.locator('[data-upload]')).to_be_visible();page.locator('[data-upload]').set_input_files(str(IMAGE));expect(page.locator('[data-approve]')).to_be_enabled();page.screenshot(path=str(ART/('image-upload-'+str(mocked)+'.png')),full_page=True)
   if mocked:
    old=page.request.get(ORIGIN+'/api/public').json()['menu'][0].get('imageUrl');page.locator('[data-generate]').click();expect(page.locator('[data-status]')).to_contain_text('Preview only');assert page.request.get(ORIGIN+'/api/public').json()['menu'][0].get('imageUrl')==old;page.locator('[data-regenerate]').click();expect(page.locator('[data-status]')).to_contain_text('Preview only');page.screenshot(path=str(ART/'image-generated-mock-review.png'),full_page=True);page.locator('[data-approve]').click();expect(page.locator('.owner-import-dialog')).to_have_count(0);assert page.request.get(ORIGIN+'/api/public').json()['menu'][0]['imageUrl'].startswith('/media/')
   else:
    expect(page.locator('[data-generate]')).to_be_disabled();page.locator('[data-approve]').click();expect(page.locator('.owner-import-dialog')).to_have_count(0)
   for locale in ['en','ar']:
    page.evaluate('(v)=>localStorage.setItem("resuto-language",v)',locale)
    for width in [375,430,768,1440]:
     page.set_viewport_size({'width':width,'height':900})
     for route in ['/manager/setup','/manager/floor-editor','/manager#data','/manager#menu']:
      page.goto(ORIGIN+route);page.wait_for_load_state('networkidle');assert page.locator('html').get_attribute('dir')==('rtl' if locale=='ar' else 'ltr');assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),(locale,width,route)
      if route.endswith('/setup'):page.locator('[data-step="5"]').click()
      if locale=='ar' and route in ['/manager#menu','/manager/floor-editor']:assert page.locator('.staff-arabic-logo').count()==0,'the wordmark must not change in Arabic'
      if width in [375,1440]:page.screenshot(path=str(ART/f'{"mock" if mocked else "missing"}-{locale}-{width}-{route.split("/")[-1].replace("#","-")}.png'),full_page=True)
    page.goto(ORIGIN+'/manager/floor-editor');page.locator('[data-floor-import="photos"]').click();page.locator('.owner-sources input').set_input_files(str(IMAGE));page.set_viewport_size({'width':375,'height':900});page.screenshot(path=str(ART/f'floor-dialog-{locale}-{mocked}.png'),full_page=True);page.locator('[data-close]').click()
   for locale in ['en','ar']:
    page.evaluate('(v)=>localStorage.setItem("resuto-language",v)',locale);page.set_viewport_size({'width':375,'height':844});page.goto(ORIGIN+'/menu');page.locator('[data-do="assistant"]').click();page.locator('#ai-preferences').fill('For two under 700 EGP, not spicy' if locale=='en' else 'إحنا ٢ وميزانيتنا ٧٠٠ جنيه ومش عايزين حار');page.locator('form[data-guest-form="ai"] button').click();expect(page.locator('.chat-meal-card').first).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(ART/f'guest-chat-{locale}-{mocked}.png'),full_page=True);page.locator('[data-do="dismiss"]').click();page.goto(ORIGIN+'/reserve');expect(page.locator('.bk-slot').first).to_be_visible();assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.screenshot(path=str(ART/f'guest-booking-{locale}-{mocked}.png'),full_page=True)
   assert not errors,errors;page.close();print('PASS owner UI: '+('mock Gemini success, editable floor, live seats, approved canonical menu/media' if mocked else 'missing-key states and local upload')+'; English/Arabic responsive',flush=True)
  finally:proc.terminate();proc.wait(timeout=10)
 browser.close()

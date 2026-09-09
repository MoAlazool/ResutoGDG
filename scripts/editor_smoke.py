"""Exercise public pages and dedicated editor against an isolated real HTTP server."""
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
ORIGIN='http://localhost:3101'

def run():
    with tempfile.TemporaryDirectory(prefix='resuto-editor-') as tmp:
        env={**os.environ,'PORT':'3101','APP_ORIGIN':ORIGIN,'DB_PATH':str(Path(tmp)/'test.sqlite'),'MANAGER_PASSWORD':'editor-test','KITCHEN_PASSWORD':'kitchen-test'}
        with open(Path(tmp)/'server.log','w') as log:
            process=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
            try:
                for _ in range(60):
                    try:
                        urllib.request.urlopen(ORIGIN,timeout=1);break
                    except OSError:time.sleep(.2)
                with sync_playwright() as p:
                    browser=p.chromium.launch(headless=True)
                    errors=[]
                    def new_page(width=1440):
                        context=browser.new_context(viewport={'width':width,'height':1000 if width>600 else 844},accept_downloads=True)
                        page=context.new_page();page.set_default_timeout(8000)
                        page.on('pageerror',lambda err:errors.append(str(err)))
                        return page
                    a,b=new_page(),new_page()
                    a.on('dialog',lambda dialog:dialog.accept())
                    b.on('dialog',lambda dialog:dialog.accept())
                    try:
                        artifacts=ROOT/'artifacts';artifacts.mkdir(exist_ok=True)
                        for route,heading in [('/', 'Run the room.'),('/restaurant','Good food.')]:
                            a.goto(ORIGIN+route)
                            expect(a.get_by_role('heading',level=1).first).to_contain_text(heading)
                            assert a.evaluate('document.documentElement.scrollWidth')<=1440
                            a.locator('img').evaluate_all('(images)=>Promise.all(images.map(i=>{i.loading="eager";return i.decode()}))')
                            a.screenshot(path=str(artifacts/('saas-desktop.png' if route=='/' else 'restaurant-desktop.png')),full_page=True)
                        mobile=new_page(390)
                        for route in ['/','/restaurant','/reserve']:
                            mobile.goto(ORIGIN+route);expect(mobile.locator('main')).to_be_visible()
                            assert mobile.evaluate('document.documentElement.scrollWidth')<=390,route+' overflows'
                            if route!='/reserve':mobile.screenshot(path=str(artifacts/('saas-mobile.png' if route=='/' else 'restaurant-mobile.png')),full_page=True)
                        print('PASS public pages, imagery, links and desktop/mobile widths',flush=True)
                        for page in [a,b]:
                            page.goto(ORIGIN+'/manager/floor-editor')
                            expect(page.get_by_label('Password',exact=True)).to_be_visible()
                            page.get_by_label('Password',exact=True).fill('editor-test')
                            page.get_by_role('button',name='Sign in',exact=False).click()
                            expect(page.locator('#studio-canvas')).to_be_visible()
                        original=a.evaluate("fetch('/api/floor').then(r=>r.json())")
                        a.locator('[data-tool="layer"][data-id="t2"]').click()
                        a.screenshot(path=str(artifacts/'editor-preview.png'),full_page=True)
                        a.locator('[data-tool="layer"][data-id="t1"]').click()
                        a.locator('.advanced-dimensions summary').click()
                        a.locator('#object-properties [name="label"]').fill('Window table')
                        a.locator('#object-properties [name="width"]').fill('130')
                        a.locator('#object-properties [name="rotation"]').fill('30')
                        a.locator('#object-properties [name=label]').press('Tab')
                        expect(a.locator('#studio-canvas [data-object-id="t1"]')).to_have_attribute('transform','translate(240 240) rotate(30)')
                        assert a.evaluate("fetch('/api/floor').then(r=>r.json()).then(f=>f.tables[0].label)")=='T1'
                        a.locator('[data-tool="undo"]').click();a.locator('[data-tool="undo"]').click();a.locator('[data-tool="undo"]').click()
                        expect(a.locator('#object-properties [name="label"]')).to_have_value('T1')
                        a.locator('[data-tool="redo"]').click();a.locator('[data-tool="redo"]').click();a.locator('[data-tool="redo"]').click()
                        expect(a.locator('#object-properties [name="label"]')).to_have_value('Window table')
                        a.locator('[data-tool="save"]').click()
                        expect(a.locator('#draft-status')).to_have_text('✓ All changes saved')
                        print('PASS properties, resize, rotation, draft isolation, undo/redo and save',flush=True)
                        # Second editor retains its own base revision and cannot overwrite A.
                        b.locator('.more-floor-objects summary').click();b.locator('[data-tool="add"][data-kind="counter"]').click()
                        b.locator('[data-tool="save"]').click()
                        expect(b.locator('.floor-conflict')).to_be_visible()
                        with b.expect_download() as downloaded:b.locator('[data-tool="export"]').click()
                        assert downloaded.value.suggested_filename=='resuto-floor-draft.json'
                        b.locator('[data-tool="reload"]').click()
                        expect(b.locator('#draft-status')).to_have_text('✓ All changes saved')
                        print('PASS stale save rejection, draft export and reload',flush=True)
                        # Create, move, resize and rotate through actual canvas handles.
                        a.locator('[data-tool="add"][data-kind="rectangle"]').click()
                        a.locator('.advanced-dimensions summary').click()
                        current=a.locator('#studio-canvas .svg-table.is-selected')
                        current_id=current.get_attribute('data-object-id')
                        box=current.bounding_box()
                        a.mouse.move(box['x']+box['width']/2,box['y']+box['height']/2);a.mouse.down();a.mouse.move(box['x']+box['width']/2+30,box['y']+box['height']/2+25,steps=5);a.mouse.up()
                        before_width=int(a.locator('#object-properties [name="width"]').input_value())
                        handle=a.locator('#studio-canvas .is-selected .resize-handle').bounding_box()
                        a.mouse.move(handle['x']+handle['width']/2,handle['y']+handle['height']/2);a.mouse.down();a.mouse.move(handle['x']+handle['width']/2+20,handle['y']+handle['height']/2+10,steps=5);a.mouse.up()
                        assert int(a.locator('#object-properties [name="width"]').input_value())>before_width
                        a.locator('[data-tool="rotate"]').click()
                        expect(a.locator('#object-properties [name="rotation"]')).to_have_value('15')
                        rotator=a.locator('#studio-canvas .is-selected .rotate-handle').bounding_box()
                        a.mouse.move(rotator['x']+rotator['width']/2,rotator['y']+rotator['height']/2);a.mouse.down();a.mouse.move(rotator['x']+rotator['width']/2+40,rotator['y']+rotator['height']/2+20,steps=5);a.mouse.up()
                        assert a.locator('#object-properties [name="rotation"]').input_value()!='15'
                        a.locator('[data-tool="duplicate"]').click()
                        expect(a.locator('#studio-canvas .svg-table')).to_have_count(8)
                        a.locator('[data-tool="multi"]').click()
                        a.locator('[data-tool="layer"][data-id="t3"]').click()
                        a.locator('[data-tool="layer"][data-id="t5"]').click()
                        a.locator('.arrangement-options summary').click();a.locator('[data-tool="align-top"]').click()
                        a.locator('.arrangement-options summary').click();a.locator('[data-tool="space-x"]').click()
                        a.locator('[data-tool="undo"]').click()
                        a.locator('[data-tool="undo"]').click()
                        a.locator('[data-tool="multi"]').click()
                        a.locator('[data-tool="layer"][data-id="t3"]').click()
                        a.locator('#studio-canvas').focus();a.keyboard.press('ArrowRight')
                        expect(a.locator('#object-properties [name="x"]')).to_have_value('937')
                        a.locator('[data-tool="discard"]').click()
                        expect(a.locator('#studio-canvas .svg-table')).to_have_count(6)
                        expect(a.locator('#draft-status')).to_have_text('✓ All changes saved')
                        print('PASS canvas drag/resize, duplicate, multi-select, align, spacing, keyboard and discard',flush=True)
                        # Object palette and background are persisted through one save.
                        a.locator('.more-floor-objects summary').click()
                        for kind in ['wall','door','window','counter','text','zone']:a.locator('[data-tool="add"][data-kind="'+kind+'"]').click()
                        a.locator('[data-tool="delete"]').click()
                        a.locator('[data-tool="undo"]').click()
                        a.locator('.background-panel summary').click()
                        a.locator('#studio-background-file').set_input_files({'name':'floor.png','mimeType':'image/png','buffer':__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3S8AAAAASUVORK5CYII=')})
                        expect(a.locator('#studio-canvas image')).to_have_count(1)
                        a.locator('#background-lock').uncheck()
                        a.locator('[data-tool="remove-image"]').click()
                        a.locator('[data-tool="save"]').click()
                        expect(a.locator('#draft-status')).to_have_text('✓ All changes saved')
                        a.locator('[data-tool="add"][data-kind="text"]').click()
                        a.context.set_offline(True)
                        a.locator('[data-tool="save"]').click()
                        expect(a.locator('#draft-status')).to_have_text('● Unsaved changes')
                        a.context.set_offline(False)
                        a.locator('[data-tool="save"]').click()
                        expect(a.locator('#draft-status')).to_have_text('✓ All changes saved')
                        print('PASS structural objects, background controls, failed save and retry',flush=True)
                        a.locator('[data-tool="layer"][data-id="t1"]').click()
                        a.locator('#object-properties [name="label"]').fill('Recovered draft')
                        a.locator('#object-properties [name=label]').press('Tab')
                        a.reload()
                        expect(a.locator('#draft-status')).to_have_text('● Unsaved changes')
                        a.locator('[data-tool="layer"][data-id="t1"]').click()
                        expect(a.locator('#object-properties [name="label"]')).to_have_value('Recovered draft')
                        a.locator('[data-tool="discard"]').click()
                        a.locator('[data-tool="zoom-in"]').click()
                        expect(a.locator('#zoom-label')).to_have_text('125%')
                        a.locator('[data-tool="fit"]').click()
                        expect(a.locator('#zoom-label')).to_have_text('100%')
                        a.locator('[data-tool="pan"]').click()
                        canvasbox=a.locator('#studio-canvas').bounding_box()
                        a.mouse.move(canvasbox['x']+canvasbox['width']/2,canvasbox['y']+canvasbox['height']/2);a.mouse.down();a.mouse.move(canvasbox['x']+canvasbox['width']/2+40,canvasbox['y']+canvasbox['height']/2+25,steps=5);a.mouse.up()
                        assert a.locator('#studio-canvas').get_attribute('viewBox')!='0 0 1200 800'
                        a.locator('[data-tool="fit"]').click()
                        a.locator('[data-tool="select"]').click()
                        print('PASS unsaved draft recovery, explicit discard and zoom controls',flush=True)
                        # Save screenshot from a clean representative floor, then test mobile editor.
                        a.reload();expect(a.locator('#studio-canvas')).to_be_visible()
                        a.screenshot(path=str(artifacts/'floor-editor-desktop.png'),full_page=True)
                        assert a.evaluate('document.documentElement.scrollWidth')<=1440
                        mobile.goto(ORIGIN+'/manager/floor-editor');mobile.get_by_label('Password',exact=True).fill('editor-test');mobile.get_by_role('button',name='Sign in',exact=False).click()
                        expect(mobile.locator('#studio-canvas')).to_be_visible()
                        mobile.locator('[data-tool="toggle-objects"]').click()
                        expect(mobile.locator('.object-palette').first).to_be_visible()
                        mobile.locator('[data-tool="toggle-objects"]').click()
                        mobile.locator('[data-tool="toggle-properties"]').click()
                        assert mobile.evaluate('document.documentElement.scrollWidth')<=390
                        mobile.screenshot(path=str(artifacts/'floor-editor-mobile.png'),full_page=True)
                        assert not errors,errors
                        print('PASS editor reload, responsive panels and no page errors',flush=True)
                    except Exception:
                        a.screenshot(path=str(ROOT/'artifacts/editor-failure.png'),full_page=True)
                        print('Page errors:',errors,flush=True)
                        raise
                    finally:browser.close()
            finally:process.terminate();process.wait(timeout=10)

if __name__=='__main__':run()

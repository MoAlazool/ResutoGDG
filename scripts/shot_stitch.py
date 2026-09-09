"""Capture the landing page as viewport tiles and stitch them, avoiding the
blank-tile artefacts Chromium's full-page capture produces with backdrop blur."""
import sys, io
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
ORIGIN,LANG,W,TAG=sys.argv[1],sys.argv[2],int(sys.argv[3]),sys.argv[4]
H=900 if W>700 else 844
OUT=ROOT/'artifacts'/'shots'; OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':W,'height':H},is_mobile=W<700,has_touch=W<700)
    pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.add_init_script("localStorage.setItem('resuto-language','%s')"%LANG)
    pg.goto(ORIGIN,wait_until='networkidle'); pg.wait_for_timeout(900)
    total=pg.evaluate("document.body.scrollHeight")
    y=0
    while y<total:
        pg.evaluate("window.scrollTo(0,%d)"%y); pg.wait_for_timeout(160); y+=int(H*0.8)
    pg.add_style_tag(content='.lp-nav{position:static!important}')
    pg.wait_for_timeout(200)
    total=pg.evaluate("document.body.scrollHeight")
    sheet=Image.new('RGB',(W,total),'#FCF9F3')
    y=0
    while y<total:
        pos=min(y,total-H)
        pg.evaluate("window.scrollTo(0,%d)"%pos); pg.wait_for_timeout(420)
        tile=Image.open(io.BytesIO(pg.screenshot()))
        sheet.paste(tile,(0,pos))
        y+=H
    f=OUT/f'{TAG}-{LANG}-{W}.png'
    sheet.save(f)
    print(f.name, sheet.size, 'errors', errs[:3])
    b.close()

import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
ORIGIN=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:3000'
LANG=sys.argv[2] if len(sys.argv)>2 else 'en'
W=int(sys.argv[3]) if len(sys.argv)>3 else 1440
TAG=sys.argv[4] if len(sys.argv)>4 else 'sec'
OUT=ROOT/'artifacts'/'shots'; OUT.mkdir(parents=True,exist_ok=True)
H=900 if W>700 else 844
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':W,'height':H},is_mobile=W<700,has_touch=W<700)
    pg=ctx.new_page(); errs=[]
    pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.on('console',lambda m:errs.append('console '+m.text) if m.type=='error' else None)
    pg.add_init_script("localStorage.setItem('resuto-language','%s')"%LANG)
    pg.goto(ORIGIN,wait_until='networkidle'); pg.wait_for_timeout(900)
    doc=pg.evaluate("document.body.scrollHeight")
    y=0
    while y<doc:
        pg.evaluate("window.scrollTo(0,%d)"%y); pg.wait_for_timeout(140); y+=int(H*0.75)
    pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(600)
    n=pg.evaluate("document.querySelectorAll('.lp-main > section').length")
    for i in range(n):
        el=pg.locator('.lp-main > section').nth(i)
        cls=el.get_attribute('class').split()[-1].replace('lp-','')
        el.scroll_into_view_if_needed(); pg.wait_for_timeout(700)
        try:
            el.screenshot(path=str(OUT/f'{TAG}-{i:02d}-{cls}-{LANG}-{W}.png'))
        except Exception as ex:
            print(i,cls,'skip',ex)
    pg.locator('.lp-nav').screenshot(path=str(OUT/f'{TAG}-nav-{LANG}-{W}.png'))
    pg.locator('.lp-foot').scroll_into_view_if_needed(); pg.wait_for_timeout(300)
    pg.locator('.lp-foot').screenshot(path=str(OUT/f'{TAG}-foot-{LANG}-{W}.png'))
    print('errors',errs[:8])
    b.close()

import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
ORIGIN=sys.argv[1] if len(sys.argv)>1 else 'http://localhost:3000'
TAG=sys.argv[2] if len(sys.argv)>2 else 'now'
OUT=ROOT/'artifacts'/'shots'; OUT.mkdir(parents=True,exist_ok=True)
CONF=[('desktop',1440,900,'en'),('desktop',1440,900,'ar'),('mobile',390,844,'en'),('mobile',390,844,'ar')]
with sync_playwright() as p:
    b=p.chromium.launch()
    for name,w,h,lang in CONF:
        ctx=b.new_context(viewport={'width':w,'height':h},device_scale_factor=2 if name=='mobile' else 1,is_mobile=name=='mobile',has_touch=name=='mobile')
        pg=ctx.new_page(); errs=[]
        pg.on('pageerror',lambda e:errs.append(str(e)))
        pg.on('console',lambda m:errs.append('console:'+m.type+':'+m.text) if m.type=='error' else None)
        pg.add_init_script("localStorage.setItem('resuto-language','%s')"%lang)
        pg.goto(ORIGIN,wait_until='networkidle')
        pg.wait_for_timeout(1200)
        # scroll through to trigger reveals
        H=pg.evaluate("document.body.scrollHeight")
        y=0
        while y<H:
            pg.evaluate("window.scrollTo(0,%d)"%y); pg.wait_for_timeout(180); y+=int(h*0.8)
        pg.evaluate("window.scrollTo(0,0)"); pg.wait_for_timeout(700)
        f=OUT/f'{TAG}-{name}-{lang}.png'
        pg.screenshot(path=str(f),full_page=True)
        ow=pg.evaluate("(()=>{const bad=[];document.querySelectorAll('body *').forEach(el=>{const r=el.getBoundingClientRect();if(r.width&&(r.right>window.innerWidth+2||r.left<-2))bad.push(el.tagName+'.'+(el.className&&el.className.baseVal===undefined?String(el.className).slice(0,40):''))});return [...new Set(bad)].slice(0,15)})()")
        print(f'{name}/{lang}: {f.name} height={pg.evaluate("document.body.scrollHeight")} overflow={ow} errors={errs[:6]}',flush=True)
        ctx.close()
    b.close()

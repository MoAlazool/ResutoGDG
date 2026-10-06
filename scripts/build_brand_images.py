"""Build the site icon and the social sharing image.

  public/assets/resuto-icon.png   512px app icon / favicon
  public/assets/og-resuto.png     1200x630 link preview

Needs: pip install playwright && playwright install chromium
Run:   python scripts/build_brand_images.py
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
FONT = (ROOT / 'public' / 'fonts' / 'manrope.ttf').as_uri()
BASE = f'''<meta charset="utf-8"><style>@font-face{{font-family:M;font-weight:200 800;src:url("{FONT}")}}
*{{margin:0;box-sizing:border-box}}body{{font-family:M,sans-serif;-webkit-font-smoothing:antialiased}}</style>'''
ICON = BASE + '''<body style="width:512px;height:512px;background:#0C2620;display:grid;place-items:center">
<div style="font-size:380px;font-weight:700;color:#FCF8EF;line-height:1;margin-top:-56px">r<span style="color:#E8875A">.</span></div></body>'''
OG = BASE + '''<body style="width:1200px;height:630px;background:#FCF9F3;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between">
<div style="display:flex;align-items:center;gap:16px"><span style="width:60px;height:60px;border-radius:16px;background:#0C2620;color:#FCF8EF;display:grid;place-items:center;font-size:38px;font-weight:700">r</span><span style="font-size:38px;font-weight:650;letter-spacing:-.03em;color:#0C2620">resuto<span style="color:#C85E33">.</span></span></div>
<div><div style="font-size:92px;font-weight:600;letter-spacing:-.05em;line-height:.98;color:#0C2620">Run the room.</div>
<div style="font-size:50px;font-weight:500;letter-spacing:-.035em;color:#57685F;margin-top:10px">Resuto runs everything else.</div></div>
<div style="display:flex;gap:12px;font-size:24px;font-weight:600;color:#0C2620">''' + ''.join(f'<span style="padding:11px 22px;border-radius:99px;background:#fff;box-shadow:0 0 0 1.5px #0c26201f">{x}</span>' for x in ['Reservations', 'QR ordering', 'Kitchen board', 'Split bills']) + '</div></body>'

with sync_playwright() as p:
    b = p.chromium.launch()
    for html, size, name in ((ICON, (512, 512), 'resuto-icon.png'), (OG, (1200, 630), 'og-resuto.png')):
        page = b.new_page(viewport={'width': size[0], 'height': size[1]})
        page.set_content(html); page.evaluate('document.fonts.ready'); page.wait_for_timeout(200)
        page.screenshot(path=str(ROOT / 'public' / 'assets' / name))
        print('wrote', name)
    b.close()

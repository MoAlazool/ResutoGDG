"""Build the sample menu used by the landing page's menu-import demo.

One dish list drives everything, so the printed page, the photograph, the
highlight regions and the extracted rows cannot drift apart:

  public/assets/menu-sample-page.webp   the printed page (PDF source)
  public/assets/menu-sample-photo.webp  that page photographed on a table
  public/assets/menu-sample-scan.webp   the page cropped and straightened out of the photo
  public/landing-import-data.js         dishes + measured text regions

Needs: pip install playwright pillow numpy && playwright install chromium
Run:   python scripts/build_menu_sample.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'public' / 'assets'
FONTS = ROOT / 'public' / 'fonts'
PAGE_W, PAGE_H = 1000, 1400

# Prices are in piastres, as everywhere else in Resuto. `was` is an older price
# left struck through on the printed menu: the one deliberately ambiguous field.
DISHES = [
    dict(id='burrata', name='Burrata & heirloom tomato', nameAr='بوراتا مع الطماطم', category='Starters', price=14500, note='Creamy burrata, ripe tomatoes, fresh basil'),
    dict(id='soup', name='Roasted pumpkin soup', nameAr='شوربة القرع المشوي', category='Starters', price=9500, was=8500, note='Silky roasted pumpkin, gently seasoned'),
    dict(id='chicken', name='Grilled chicken supreme', nameAr='دجاج مشوي مع الخضروات', category='Mains', price=28500, note='With seasonal vegetables'),
    dict(id='risotto', name='Wild mushroom risotto', nameAr='ريزوتو الفطر', category='Mains', price=24500, note='Creamy rice, wild mushrooms'),
    dict(id='seabass', name='Seabass with lemon butter', nameAr='قاروص بزبدة الليمون', category='Mains', price=34500, note='With lemon butter and greens'),
    dict(id='bowl', name='Garden harvest bowl', nameAr='سلطة الحديقة', category='Mains', price=18500, note='Seasonal vegetables'),
    dict(id='fondant', name='Chocolate fondant', nameAr='فون دان الشوكولاتة', category='Desserts', price=12500, note='Warm, with a soft centre'),
    dict(id='hibiscus', name='Hibiscus cooler', nameAr='كركديه مثلج', category='Drinks', price=6500, note='Chilled, served over ice'),
]
CATEGORY_AR = {'Starters': 'المقبلات', 'Mains': 'الأطباق الرئيسية', 'Desserts': 'الحلويات', 'Drinks': 'المشروبات'}


def page_html():
    sections, seen = [], []
    for d in DISHES:
        if d['category'] not in seen:
            seen.append(d['category'])
            sections.append(f'''<h2 data-cat="{d['category']}"><span>{d['category']}</span><i></i><span class="ar" lang="ar" dir="rtl">{CATEGORY_AR[d['category']]}</span></h2>''')
        was = f'''<s>{d['was'] // 100}</s>''' if d.get('was') else ''
        sections.append(f'''<article data-dish="{d['id']}">
 <div class="line"><b data-f="name">{d['name'].replace('&', '&amp;')}</b><i></i><span class="price" data-f="price">{was}{d['price'] // 100}</span></div>
 <div class="sub"><em>{d['note']}</em><span class="ar" lang="ar" dir="rtl" data-f="nameAr">{d['nameAr']}</span></div>
</article>''')
    return f'''<!doctype html><meta charset="utf-8"><style>
@font-face{{font-family:PlexAr;font-weight:400;src:url("{(FONTS / 'plex-arabic.ttf').as_uri()}")}}
@font-face{{font-family:PlexAr;font-weight:600;src:url("{(FONTS / 'plex-arabic-semibold.ttf').as_uri()}")}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:{PAGE_W}px;height:{PAGE_H}px}}
body{{background:#F6EFDF;color:#1F2A24;font-family:Baskerville,'Hoefler Text',Georgia,serif;padding:74px 92px 0;position:relative}}
body::before{{content:'';position:absolute;inset:30px;border:1.5px solid #1f2a2440}}
body::after{{content:'';position:absolute;inset:38px;border:.75px solid #1f2a2426}}
header{{text-align:center;margin-bottom:40px}}
header svg{{width:56px;height:34px;margin-bottom:12px}}
h1{{font-family:Didot,'Bodoni 72',serif;font-weight:400;font-size:50px;letter-spacing:.2em;text-indent:.2em;text-transform:uppercase}}
header p{{margin-top:12px;font-size:17px;letter-spacing:.3em;text-transform:uppercase;color:#6F6A5C}}
h2{{display:flex;align-items:center;gap:18px;margin:36px 0 18px;font-family:Didot,'Bodoni 72',serif;font-weight:400;font-size:21px;letter-spacing:.3em;text-transform:uppercase;color:#A4532B}}
h2 i{{flex:1;border-top:1px solid #a4532b55}}
h2 .ar{{font-family:PlexAr;font-weight:600;font-size:22px;letter-spacing:0}}
article{{margin-bottom:21px}}
.line{{display:flex;align-items:baseline;gap:12px}}
.line b{{font-weight:600;font-size:31px;letter-spacing:-.005em}}
.line i{{flex:1;border-bottom:2px dotted #1f2a2455;transform:translateY(-6px)}}
.price{{font-size:31px;font-variant-numeric:lining-nums tabular-nums}}
.price s{{color:#8C8674;margin-right:14px;text-decoration-thickness:2px}}
.sub{{display:flex;justify-content:space-between;align-items:baseline;gap:20px;margin-top:3px}}
.sub em{{font-size:20px;color:#6F6A5C}}
.sub .ar{{font-family:PlexAr;font-size:23px;color:#35423B}}
footer{{position:absolute;inset-inline:92px;bottom:66px;display:flex;justify-content:space-between;font-size:16px;letter-spacing:.14em;text-transform:uppercase;color:#8C8674;border-top:1px solid #1f2a2433;padding-top:16px}}
footer .ar{{font-family:PlexAr;font-size:17px;letter-spacing:0}}
</style>
<header>
 <svg viewBox="0 0 56 34" fill="none" stroke="#6C7F4A" stroke-width="1.6" stroke-linecap="round"><path d="M4 30C18 26 36 16 52 4"/><path d="M16 26c-3-6-1-11 3-13 3 5 2 10-3 13Z" fill="#6C7F4A22"/><path d="M27 20c-2-6 1-11 5-12 2 5 0 10-5 12Z" fill="#6C7F4A22"/><path d="M38 13c-1-5 2-9 6-9 1 4-1 8-6 9Z" fill="#6C7F4A22"/><path d="M21 24c5 2 10 1 13-3-5-3-10-2-13 3Z" fill="#6C7F4A22"/></svg>
 <h1>The Olive Room</h1>
 <p>Zamalek · Cairo</p>
</header>
{''.join(sections)}
<footer><span>Prices in Egyptian pounds</span><span class="ar" lang="ar" dir="rtl">الأسعار بالجنيه المصري</span></footer>'''


MEASURE = '''() => {
 const box = el => { const r = el.getBoundingClientRect(); return [r.x / innerWidth, r.y / innerHeight, r.width / innerWidth, r.height / innerHeight].map(n => +n.toFixed(4)); };
 const out = {dishes: {}, categories: {}};
 document.querySelectorAll('[data-dish]').forEach(a => { out.dishes[a.dataset.dish] = Object.fromEntries([...a.querySelectorAll('[data-f]')].map(f => [f.dataset.f, box(f)])); });
 document.querySelectorAll('[data-cat]').forEach(h => { out.categories[h.dataset.cat] = box(h.firstElementChild); });
 return out;
}'''


def render_page(tmp):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={'width': PAGE_W, 'height': PAGE_H}, device_scale_factor=2)
        page.set_content(page_html())
        page.evaluate('document.fonts.ready')
        regions = page.evaluate(MEASURE)
        page.screenshot(path=str(tmp))
        browser.close()
    return Image.open(tmp).convert('RGB'), regions


def noise(rng, w, h, cell):
    """Smooth value noise: a small random grid scaled up."""
    grid = rng.random((max(2, h // cell), max(2, w // cell)))
    img = Image.fromarray((grid * 255).astype('uint8')).resize((w, h), Image.BICUBIC)
    return np.asarray(img, dtype='float32') / 255 - .5


def coeffs(dst, src):
    """Perspective coefficients for Image.transform mapping output dst -> input src."""
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    return np.linalg.solve(np.array(a, dtype='float64'), np.array(b, dtype='float64')).tolist()


def photograph(page):
    """Composite the printed page into a believable phone photo of a stone table."""
    rng = np.random.default_rng(7)
    W, H = 1200, 1600
    # Travertine tabletop, matched to the stone in the existing dish photography.
    stone = np.zeros((H, W), 'float32')
    for cell, amount in ((260, .10), (90, .07), (28, .045), (7, .03)):
        stone += noise(rng, W, H, cell) * amount
    veins = np.abs(noise(rng, W, H, 180) + noise(rng, W, H, 60) * .35)
    stone -= np.clip(.035 - veins, 0, 1) * 1.6
    base = np.array([226, 214, 195], 'float32')
    table = np.clip(base * (1 + stone[..., None] * np.array([1, 1.04, 1.12])), 0, 255)
    scene = Image.fromarray(table.astype('uint8')).filter(ImageFilter.GaussianBlur(1.1))

    # A dish at the edge of the frame, as it would be on a real table.
    sprite = Image.open(ASSETS / 'menu-photography.png').convert('RGB')
    cx, cy, r = 767, 193, 176
    bowl = sprite.crop((cx - r, cy - r, cx + r, cy + r)).resize((620, 620), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.6))
    mask = Image.new('L', (620, 620), 0)
    ImageDraw.Draw(mask).ellipse((22, 22, 598, 598), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(9))
    scene.paste(bowl, (880, -330), mask)

    # The page: a soft centre fold and uneven paper before it is laid down.
    pw, ph = page.size
    paper = np.asarray(page, 'float32')
    yy = np.linspace(0, 1, ph, dtype='float32')[:, None]
    fold = 1 - .05 * np.exp(-((yy - .5) / .012) ** 2) + .03 * np.exp(-((yy - .515) / .03) ** 2)
    paper = paper * fold[..., None] * (1 + noise(rng, pw, ph, 300)[..., None] * .05)
    paper = paper * (1 + rng.normal(0, .012, (ph, pw, 1)).astype('float32'))
    page = Image.fromarray(np.clip(paper, 0, 255).astype('uint8'))

    quad = [(196, 138), (1012, 96), (1086, 1452), (118, 1492)]  # TL TR BR BL, shot from slightly below
    corners = [(0, 0), (pw, 0), (pw, ph), (0, ph)]
    warped = page.transform((W, H), Image.PERSPECTIVE, coeffs(quad, corners), Image.BICUBIC)
    qmask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(qmask).polygon(quad, fill=255)
    for blur, offset, strength in ((34, (20, 30), .34), (7, (5, 8), .32)):
        shadow = ImageChops.offset(qmask, *offset).filter(ImageFilter.GaussianBlur(blur))
        dark = Image.new('RGB', (W, H), (52, 40, 28))
        scene = Image.composite(dark, scene, shadow.point(lambda v: int(v * strength)))
    scene.paste(warped, (0, 0), qmask.filter(ImageFilter.GaussianBlur(.8)))

    # Light: a window up and to the left, the photographer's shadow low in frame.
    img = np.asarray(scene, 'float32')
    gy, gx = np.mgrid[0:H, 0:W].astype('float32')
    light = 1.08 - .26 * ((gx / W) * .55 + (gy / H) * .75)
    vignette = 1 - .2 * (((gx - W / 2) / W) ** 2 + ((gy - H / 2) / H) ** 2) * 2
    hand = 1 - .2 * np.exp(-(((gx - W * .2) / (W * .34)) ** 2 + ((gy - H * 1.04) / (H * .2)) ** 2))
    img = img * (light * vignette * hand)[..., None] * np.array([1.03, 1.0, .94])
    img = Image.fromarray(np.clip(img, 0, 255).astype('uint8')).filter(ImageFilter.GaussianBlur(.7))
    img = np.asarray(img, 'float32') + rng.normal(0, 3.4, (H, W, 1)) + rng.normal(0, 1.6, (H, W, 3))
    photo = Image.fromarray(np.clip(img, 0, 255).astype('uint8'))

    # What the app would keep after crop + straighten: the page pulled back out of the photo.
    scan = photo.transform((PAGE_W, PAGE_H), Image.PERSPECTIVE, coeffs([(0, 0), (PAGE_W, 0), (PAGE_W, PAGE_H), (0, PAGE_H)], quad), Image.BICUBIC)
    return photo, scan, [[round(x / W, 4), round(y / H, 4)] for x, y in quad]


def main():
    tmp = Path(__file__).with_name('.menu-sample-page.png')
    page, regions = render_page(tmp)
    tmp.unlink()
    photo, scan, quad = photograph(page)
    page.resize((1200, 1680), Image.LANCZOS).save(ASSETS / 'menu-sample-page.webp', quality=88, method=6)
    photo.save(ASSETS / 'menu-sample-photo.webp', quality=80, method=6)
    scan.save(ASSETS / 'menu-sample-scan.webp', quality=82, method=6)
    data = {
        'page': {'w': PAGE_W, 'h': PAGE_H},
        'photo': {'w': photo.width, 'h': photo.height, 'quad': quad},
        'categories': regions['categories'],
        'dishes': [{**d, 'regions': regions['dishes'][d['id']]} for d in DISHES],
    }
    out = ROOT / 'public' / 'landing-import-data.js'
    out.write_text('// Generated by scripts/build_menu_sample.py. Edit the dish list there, not here.\nexport default ' + json.dumps(data, ensure_ascii=False, indent=1) + ';\n', encoding='utf-8')
    print('wrote', out.name, 'and 3 assets')


if __name__ == '__main__':
    main()

# Resuto visual assets

Company logos identify configurable services; they do not imply a partnership or a live connection. Original proportions are retained. Logos and trademarks belong to their owners.

| Local asset | Official source |
|---|---|
| `public/assets/logo-foodics.svg` | https://www.foodics.com/wp-content/uploads/2021/12/foodics-logo.svg |
| `public/assets/logo-odoo.svg` | https://odoocdn.com/openerp_website/static/src/img/assets/svg/odoo_logo.svg |
| `public/assets/logo-paymob.png` | https://paymob.com/images/paymobLogo.png |
| `public/assets/logo-stripe.svg` | Stripe logo SVG on https://stripe.com/newsroom/information |
| `public/assets/logo-whatsapp.svg` | Header logo SVG on https://www.whatsapp.com/ |

`public/company-logos.js` embeds the SVG files as image data URLs, so they render without a third-party request. The PNG is served locally. Review brand guidelines before public commercial launch.

Manrope and IBM Plex Sans Arabic are locally hosted from Google Fonts' official repository, under the accompanying OFL licenses in `public/fonts`. Arabic now uses actual Medium (500), SemiBold (600) and Bold (700) faces; headings and controls are heavier than body copy.

`public/assets/menu-photography.png` is original generated imagery, created with the built-in image-generation tool. Generation brief: eight equal photographic tiles in a two-column/four-row contact sheet, with burrata, pumpkin soup, grilled chicken, mushroom risotto, sea bass, garden salad, chocolate fondant and hibiscus drink; warm stone backgrounds; no text or logos. The image illustrates the example catalog and is not a photograph of dishes sold by a real restaurant.

The `/burger` storefront concept and its nine product photographs are also original generated imagery created with the built-in image-generation tool. The source concept is retained at `public/assets/smash/design-concept.png`. Individual WebP assets in `public/assets/smash/` depict the Classic Smash, Double Smash, Crispy Chicken, Veggie Smash, loaded fries, classic fries, onion rings, chocolate shake and cola. The generation brief called for polished fast-food product photography on warm cream seamless backgrounds, consistent lighting, no text, no logos and no watermarks. These files are served as static application assets and are not stored in Firebase or Firestore.

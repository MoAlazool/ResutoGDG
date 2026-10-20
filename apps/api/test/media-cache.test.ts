// Media and HTTP caching (PCL-14, PS-18, CR-12, PCL-15, PCL-24, PCL-25):
// - signed URLs are stable within their expiry window, so repeat visits reuse downloads;
// - Supabase signing is one batched call per response, cached per window;
// - uploads to guest-facing folders get WebP derivatives and dimensions; the public menu serves a derivative + srcset;
// - the media route sends cache headers until the URL expires (public for guest images, private for documents);
// - public menus carry a versioned ETag (304 on If-None-Match) that changes exactly when the menu changes;
// - JSON responses are compressed; in-memory caches are bounded.
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BoundedCache } from '../src/common/cache/bounded-cache';
import { MediaDerivativeJobs } from '../src/common/storage/media-derivatives.jobs';
import { pickVariant } from '../src/common/storage/image-variants';
import { StorageService, stableExpiry } from '../src/common/storage/storage.service';
import { auth, bootTestApp, createTenant, seedMenu, sql, type SeededMenu, type TestApp, type TestTenant } from './helpers';

let t: TestApp;
let tenant: TestTenant;
let menu: SeededMenu;

beforeAll(async () => {
  t = await bootTestApp();
  tenant = await createTenant(t, { country: 'EG' });
  menu = await seedMenu(tenant);
});
afterAll(async () => { await t.close(); });

const photo = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 180, g: 90, b: 40 } } }).jpeg({ quality: 90 }).toBuffer();
const local = (url: string) => url.replace('http://api.test', '');
const version = async () => Number((await sql(`select version from menu_versions where org_id = $1`, [tenant.orgId]))[0]?.version ?? 0);

describe('bounded caches (PCL-25)', () => {
  it('evicts the least recently used entry at the cap and expires entries', () => {
    let now = 0;
    const c = new BoundedCache<number>(2, 1000, () => now);
    c.set('a', 1); c.set('b', 2);
    expect(c.get('a')).toBe(1); // a is now the most recent
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect([c.get('a'), c.get('c'), c.size]).toEqual([1, 3, 2]);
    now = 1000;
    expect(c.get('a')).toBeUndefined();
    c.set('d', 4, 5000);
    now = 5999;
    expect(c.get('d')).toBe(4);
    expect(c.get('c')).toBeUndefined(); // expired at 1000
    c.deleteWhere((k) => k === 'd');
    expect(c.size).toBe(0);
  });
});

describe('stable signed URLs (PCL-14) and batch signing (PS-18)', () => {
  it('rounds the expiry to a window: identical within it, valid for at least the TTL', () => {
    const day = 86_400;
    const t0 = Date.UTC(2026, 9, 20, 0, 0, 1);
    const e1 = stableExpiry(day, t0);
    expect(stableExpiry(day, t0 + 23 * 3600_000)).toBe(e1);
    expect(stableExpiry(day, t0 + 24 * 3600_000)).toBe(e1 + day);
    for (const at of [t0, t0 + 12 * 3600_000, t0 + day * 1000 - 2000]) {
      const left = stableExpiry(day, at) - at / 1000;
      expect(left).toBeGreaterThanOrEqual(day);
      expect(left).toBeLessThanOrEqual(2 * day);
    }
  });

  it('signs many Supabase objects in one request and reuses the URLs within the window', async () => {
    const storage = new StorageService({ NODE_ENV: 'test', STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://proj.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', API_ORIGIN: 'http://api.test', STORAGE_LOCAL_DIR: '/nonexistent' } as any);
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const { paths, expiresIn } = JSON.parse(init.body);
      expect(expiresIn).toBeGreaterThanOrEqual(3600);
      return new Response(JSON.stringify(paths.map((p: string) => ({ path: p, signedURL: `/object/sign/tenant-media/${p}?token=t-${p}`, error: null }))), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const paths = ['o/menu/a.jpg', 'o/menu/b.jpg', 'o/menu/a.jpg', 'o/menu/c.jpg'];
      const first = await storage.signedUrls(paths, 3600);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe('https://proj.supabase.co/storage/v1/object/sign/tenant-media');
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).paths).toEqual(['o/menu/a.jpg', 'o/menu/b.jpg', 'o/menu/c.jpg']);
      expect(first.get('o/menu/b.jpg')).toBe('https://proj.supabase.co/storage/v1/object/sign/tenant-media/o/menu/b.jpg?token=t-o/menu/b.jpg');
      const again = await storage.signedUrls(['o/menu/a.jpg', 'o/menu/c.jpg'], 3600);
      expect(fetchMock).toHaveBeenCalledTimes(1); // cached for the window
      expect(again.get('o/menu/a.jpg')).toBe(first.get('o/menu/a.jpg'));
      // A collector fills objects after the fact, with the derivative and a srcset.
      const urls = storage.urls(3600);
      const item = urls.set({ imageUrl: null as string | null, imageSrcSet: null as string | null }, 'imageUrl', 'o/menu/d.jpg', {
        variants: [{ w: 320, h: 240, path: 'o/menu/d.w320.webp', bytes: 1 }, { w: 640, h: 480, path: 'o/menu/d.w640.webp', bytes: 1 }],
        minWidth: 640, srcSetKey: 'imageSrcSet' });
      expect(item.imageUrl).toBeNull();
      await urls.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(item.imageUrl).toContain('d.w640.webp');
      expect(item.imageSrcSet).toMatch(/d\.w320\.webp\?token=\S+ 320w, \S+d\.w640\.webp\?token=\S+ 640w$/);
      // A failed batch leaves the images out instead of failing the page.
      fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 500 }));
      expect((await storage.signedUrls(['o/menu/e.jpg'], 3600)).size).toBe(0);
      // ...and the collector reports it, so the caller can refuse to cache that response.
      fetchMock.mockImplementationOnce(async () => new Response('nope', { status: 503 }));
      const partial = storage.urls(3600);
      const lost = partial.set({ imageUrl: null as string | null }, 'imageUrl', 'o/menu/f.jpg');
      expect(await partial.resolve()).toBe(false);
      expect(lost.imageUrl).toBeNull();
      const whole = storage.urls(3600);
      whole.set({ imageUrl: null as string | null }, 'imageUrl', 'o/menu/a.jpg');
      expect(await whole.resolve()).toBe(true);
      expect(await storage.urls(3600).resolve()).toBe(true); // nothing to sign
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('picks the smallest derivative wide enough, else the original', () => {
    const v = [{ w: 1280, h: 1, path: 'x.w1280.webp', bytes: 1 }, { w: 320, h: 1, path: 'x.w320.webp', bytes: 1 }, { w: 640, h: 1, path: 'x.w640.webp', bytes: 1 }];
    expect(pickVariant('x.jpg', v, 600)).toBe('x.w640.webp');
    expect(pickVariant('x.jpg', v, 2000)).toBe('x.jpg'); // the original is wider than every copy
    expect(pickVariant('y.webp', [{ w: 320, h: 1, path: 'y.w320.webp', bytes: 1 }], 640)).toBe('y.webp'); // a 512 px original
    expect(pickVariant('x.jpg', [], 600)).toBe('x.jpg');
  });
});

describe('image derivatives (CR-12) and the public menu', () => {
  let productId: string;
  let firstMenu: any;

  it('stores WebP derivatives and dimensions on upload; the guest menu serves the 640 px copy with a srcset', async () => {
    productId = menu.products.burger;
    const up = await t.http.post(`/v1/o/${tenant.orgId}/menu/products/${productId}/image`).set(auth(tenant.owner))
      .attach('file', await photo(2000, 1500), { filename: 'phone.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    const [m] = await sql(`select width, height, variants, variants_checked_at from media_assets where id = $1`, [up.body.imageMediaId]);
    expect(m).toMatchObject({ width: 2000, height: 1500 });
    expect(m.variants_checked_at).toBeTruthy();
    expect(m.variants.map((v: any) => [v.w, v.h])).toEqual([[320, 240], [640, 480], [1280, 960]]);

    const res = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    expect(res.status).toBe(200);
    firstMenu = res.body;
    const item = res.body.categories.flatMap((c: any) => c.products).find((p: any) => p.id === productId);
    expect(item.imageUrl).toMatch(/\.w640\.webp\?exp=\d+&sig=/);
    expect(item.imageSrcSet.split(', ').map((s: string) => s.split(' ')[1])).toEqual(['320w', '640w', '1280w']);
    expect([item.imageWidth, item.imageHeight]).toEqual([2000, 1500]);

    const img = await t.http.get(local(item.imageUrl));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.body).metadata()).width).toBe(640);
    const cc = img.headers['cache-control'];
    expect(cc).toMatch(/^public, max-age=\d+, immutable$/);
    expect(Number(/max-age=(\d+)/.exec(cc)![1])).toBeGreaterThanOrEqual(86_400 - 5);
  });

  it('returns the same image URLs on every request in the window (browsers and CDNs reuse them)', async () => {
    await new Promise((r) => setTimeout(r, 1100)); // the old URLs changed every second
    const again = (await t.http.get(`/v1/public/menu/${tenant.slug}`)).body;
    const urls = (m: any) => m.categories.flatMap((c: any) => c.products).map((p: any) => [p.imageUrl, p.imageSrcSet]);
    expect(urls(again)).toEqual(urls(firstMenu));
    expect(JSON.stringify(again)).toBe(JSON.stringify(firstMenu));
  });

  it('serves private documents with private cache headers', async () => {
    const storage = t.app.get(StorageService);
    const ctx = { orgId: tenant.orgId } as any;
    const doc = await storage.store(ctx, { bytes: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf', folder: 'expense-receipts' });
    expect(doc.variants).toEqual([]);
    const res = await t.http.get(local(await storage.signedUrl(doc.path, 600)));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+, immutable$/);
  });

  it('backfills derivatives for media recorded without them', async () => {
    const storage = t.app.get(StorageService);
    // An old upload: a menu object recorded without derivatives (written straight to storage, as the demo seed does).
    const path = `${tenant.orgId}/menu/${crypto.randomUUID()}.jpg`;
    await (storage as any).write(path, await photo(900, 600), 'image/jpeg');
    const [row] = await sql(`insert into media_assets(org_id, path, content_type, byte_size) values ($1, $2, 'image/jpeg', 1000) returning id`, [tenant.orgId, path]);
    await sql(`update products set image_media_id = $2 where id = $1`, [menu.products.fries, row.id]);
    const before = await version();
    const out = await t.app.get(MediaDerivativeJobs).backfill(500);
    expect(out.derived).toBeGreaterThanOrEqual(1);
    const [after] = await sql(`select width, height, variants, variants_checked_at from media_assets where id = $1`, [row.id]);
    expect(after).toMatchObject({ width: 900, height: 600 });
    expect(after.variants.map((v: any) => v.w)).toEqual([320, 640]);
    expect(await version()).toBeGreaterThan(before); // new image URLs: cached menus are invalidated
    const again = await t.app.get(MediaDerivativeJobs).backfill(500);
    expect(again.derived).toBe(0);
  });
});

describe('public menu HTTP caching (PCL-15)', () => {
  it('answers with a versioned ETag and public Cache-Control, and 304 to If-None-Match', async () => {
    const a = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    expect(a.headers['cache-control']).toBe('public, max-age=15, s-maxage=30, stale-while-revalidate=60, stale-if-error=600');
    expect(a.headers.etag).toMatch(/^W\/"pm\d+-\d+-\d+-[\w-]{12}"$/);
    const b = await t.http.get(`/v1/public/menu/${tenant.slug}`).set('If-None-Match', a.headers.etag);
    expect(b.status).toBe(304);
    expect(b.text ?? '').toBe('');
    const web = await t.http.get(`/v1/public/order/${tenant.slug}`);
    expect(web.status).toBe(200);
    expect(web.headers.etag).toMatch(/^W\/"po\d+-.*-[01]"$/);
    expect(web.headers['cache-control']).toContain('public, max-age=15');
    expect((await t.http.get(`/v1/public/order/${tenant.slug}`).set('If-None-Match', web.headers.etag)).status).toBe(304);
    // Another branch code is another cache entry (and an unknown one is still a 404).
    expect((await t.http.get(`/v1/public/menu/${tenant.slug}?branch=nope`)).status).toBe(404);
  });

  it('changes the ETag exactly when guests would see a change', async () => {
    const etag = async () => (await t.http.get(`/v1/public/menu/${tenant.slug}`)).headers.etag as string;
    const e0 = await etag();
    // Price change: new version, new body.
    await t.http.patch(`/v1/o/${tenant.orgId}/menu/products/${menu.products.soda}`).set(auth(tenant.owner))
      .send({ version: (await sql(`select version from products where id = $1`, [menu.products.soda]))[0].version, priceMinor: 2700 })
      .expect(200);
    const e1 = await etag();
    expect(e1).not.toBe(e0);
    const soda = (await t.http.get(`/v1/public/menu/${tenant.slug}`)).body.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.products.soda);
    expect(soda.priceMinor).toBe(2700);
    // A stock decrement that keeps the item available does not change what guests see: same version.
    const v1 = await version();
    await sql(`update product_branch_settings set stock_qty = 1 where product_id = $1`, [menu.products.limited]);
    expect(await version()).toBe(v1);
    expect(await etag()).toBe(e1);
    // Selling out does.
    await sql(`update product_branch_settings set stock_qty = 0 where product_id = $1`, [menu.products.limited]);
    expect(await version()).toBe(v1 + 1);
    const e2 = await etag();
    expect(e2).not.toBe(e1);
    const limited = (await t.http.get(`/v1/public/menu/${tenant.slug}`)).body.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.products.limited);
    expect(limited.available).toBe(false);
    // Organization fields guests see bump it; internal ones do not.
    await sql(`update organizations set name = name || ' ' where id = $1`, [tenant.orgId]);
    expect(await version()).toBe(v1 + 2);
    await sql(`update organizations set updated_at = now() where id = $1`, [tenant.orgId]);
    expect(await version()).toBe(v1 + 2);
  });

  it('never caches or validates a menu whose image URLs could not be signed (transient storage failure)', async () => {
    const storage = t.app.get(StorageService);
    await sql(`update organizations set name = name || '.' where id = $1`, [tenant.orgId]); // a new version: nothing cached yet
    const productImage = (body: any) => body.categories.flatMap((c: any) => c.products).find((p: any) => p.id === menu.products.burger).imageUrl;
    const spy = vi.spyOn(storage, 'signedUrls').mockResolvedValueOnce(new Map()).mockResolvedValueOnce(new Map());
    try {
      const broken = await t.http.get(`/v1/public/menu/${tenant.slug}`);
      expect(broken.status).toBe(200);
      expect(productImage(broken.body)).toBeNull();
      expect(broken.headers['cache-control']).toBe('no-store');
      expect(broken.headers.etag ?? '').not.toMatch(/"pm/); // no versioned validator a correct menu would share
      const web = await t.http.get(`/v1/public/order/${tenant.slug}`);
      expect(web.headers['cache-control']).toBe('no-store');
      expect(web.headers.etag ?? '').not.toMatch(/"po/);
    } finally {
      spy.mockRestore();
    }
    // Storage is back: the next request rebuilds (the broken menu was not cached) and gets the versioned ETag.
    const ok = await t.http.get(`/v1/public/menu/${tenant.slug}`);
    expect(productImage(ok.body)).toMatch(/\.w640\.webp\?exp=/);
    expect(ok.headers.etag).toMatch(/^W\/"pm/);
    expect(ok.headers['cache-control']).toContain('public, max-age=15');
  });

  it('never caches staff responses publicly', async () => {
    const r = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(tenant.owner));
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
});

describe('response compression (PCL-24)', () => {
  it('compresses JSON of 1 kB or more with brotli or gzip, and leaves small bodies alone', async () => {
    const raw = (path: string, enc: string) => t.http.get(path).set('Accept-Encoding', enc).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const br = await raw(`/v1/o/${tenant.orgId}/menu`, 'gzip, deflate, br').set(auth(tenant.owner));
    expect(br.headers['content-encoding']).toBe('br');
    expect(br.headers.vary).toMatch(/Accept-Encoding/i);
    const plain = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(tenant.owner)).set('Accept-Encoding', 'identity');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(Number(br.headers['content-length'])).toBeLessThan(Buffer.byteLength(JSON.stringify(plain.body)) / 2);
    const gz = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(tenant.owner)).set('Accept-Encoding', 'gzip');
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.body).toEqual(plain.body); // decoded by the client: same JSON
    const health = await t.http.get('/v1/health').set('Accept-Encoding', 'br');
    expect(health.headers['content-encoding']).toBeUndefined();
    // Conditional GET still works on compressed responses.
    const again = await t.http.get(`/v1/o/${tenant.orgId}/menu`).set(auth(tenant.owner)).set('Accept-Encoding', 'gzip').set('If-None-Match', gz.headers.etag);
    expect(again.status).toBe(304);
  });
});

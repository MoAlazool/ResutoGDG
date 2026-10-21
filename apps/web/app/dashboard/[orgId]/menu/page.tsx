'use client';
import Link from 'next/link';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { parseMajor, type MenuEditorView, type MenuImportPreview, type ModifierGroup, type Product } from '@resuto/contracts';
import { Badge, EmptyState, Field, Modal, Notice, PageHeader, SelectField, Skeleton, Tabs, TextareaField, initialOf, useConfirm, usePrompt } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { allergenLabel, stationLabel } from '@/lib/vocab';

type Tab = 'items' | 'modifiers' | 'import';
const list = (s: FormDataEntryValue | null) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

export default function MenuPage() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const [tab, setTab] = useState<Tab>('items');
  const [branchId, setBranchId] = useState(org.branches[0]?.id ?? '');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  const write = can('menu:write');
  const m = menu.data;
  const [confirm, confirmDialog] = useConfirm(locale);
  const [prompt, promptDialog] = usePrompt(locale);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await menu.reload(); } catch (e) { setError((e as Error).message); }
  };
  const available = (p: Product) => p.branchSettings.find((s) => s.branchId === branchId)?.isAvailable ?? true;

  return (
    <ModuleGate module="core" permission="menu:read">
      <PageHeader title={t('nav.menu')} subtitle={t('core.menu.subtitle')}
        actions={write && tab === 'items' && <>
          <button className="btn" onClick={async () => {
            const name = await prompt({ title: t('core.menu.category'), label: t('core.menu.categoryName'), maxLength: 120, confirmLabel: t('action.create') });
            if (name) void run(() => call(`/o/${org.id}/menu/categories`, { body: { name } }));
          }}>+ {t('core.menu.category')}</button>
          <button className="btn btn-primary" disabled={!m?.categories.length} onClick={() => setEditing('new')}>+ {t('core.menu.item')}</button>
        </>} />
      {confirmDialog}{promptDialog}
      {write && <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ key: 'items', label: t('core.menu.items') }, { key: 'modifiers', label: t('core.menu.modifiers') }, { key: 'import', label: t('core.menu.import') }]} />}
      {error && <Notice tone="danger">{error}</Notice>}
      {menu.error && <Notice tone="danger">{menu.error.message}</Notice>}
      {!m ? <Skeleton lines={8} /> : tab === 'items' ? (
        <>
          {org.branches.length > 1 && (
            <div style={{ maxWidth: 260 }}>
              <SelectField label={t('core.menu.availabilityAt')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
              </SelectField>
            </div>
          )}
          {!m.categories.filter((c) => c.isActive).length && (
            <div className="card"><EmptyState title={t('core.menu.empty')}>{t('core.menu.emptyHint')}</EmptyState></div>
          )}
          {m.categories.filter((c) => c.isActive).map((c, idx, arr) => {
            const items = m.products.filter((p) => p.categoryId === c.id && p.isActive);
            return (
              <section key={c.id} className="card">
                <div className="spread" style={{ marginBottom: 10 }}>
                  <h2 style={{ margin: 0 }}>{pick(locale, c.name, c.nameAr)} <span className="fine">· {items.length}</span></h2>
                  {write && (
                    <div className="row">
                      <button className="btn btn-sm btn-ghost" disabled={idx === 0} aria-label={t('core.menu.moveUp')} onClick={() => {
                        const ids = arr.map((x) => x.id); [ids[idx - 1], ids[idx]] = [ids[idx]!, ids[idx - 1]!];
                        void run(() => call(`/o/${org.id}/menu/categories/reorder`, { body: { ids } }));
                      }}>↑</button>
                      <button className="btn btn-sm btn-ghost" disabled={idx === arr.length - 1} aria-label={t('core.menu.moveDown')} onClick={() => {
                        const ids = arr.map((x) => x.id); [ids[idx + 1], ids[idx]] = [ids[idx]!, ids[idx + 1]!];
                        void run(() => call(`/o/${org.id}/menu/categories/reorder`, { body: { ids } }));
                      }}>↓</button>
                      <button className="btn btn-sm" onClick={async () => {
                        const name = await prompt({ title: t('action.edit'), label: t('core.menu.categoryName'), defaultValue: c.name, maxLength: 120, confirmLabel: t('action.save') });
                        if (name && name !== c.name) void run(() => call(`/o/${org.id}/menu/categories/${c.id}`, { method: 'PATCH', body: { name } }));
                      }}>{t('action.edit')}</button>
                      <button className="btn btn-sm btn-danger" onClick={async () => {
                        if (await confirm({ title: t('core.menu.archiveCategory'), tone: 'danger', confirmLabel: t('core.menu.archive') })) void run(() => call(`/o/${org.id}/menu/categories/${c.id}`, { method: 'DELETE' }));
                      }}>{t('core.menu.archive')}</button>
                    </div>
                  )}
                </div>
                {!items.length ? <p className="fine">{t('core.menu.noItems')}</p> : (
                  <div className="table-wrap">
                    <table className="data">
                      <tbody>
                        {items.map((p) => (
                          <tr key={p.id}>
                            <td style={{ width: 56 }}>{p.imageUrl ? <img src={p.imageUrl} alt="" width={44} height={44} style={{ borderRadius: 8, objectFit: 'cover' }} /> : <span className="item-initial" aria-hidden>{initialOf(pick(locale, p.name, p.nameAr))}</span>}</td>
                            <td><strong>{pick(locale, p.name, p.nameAr)}</strong><div className="fine">{stationLabel(t, p.station)}{p.prepMinutes ? ` · ${p.prepMinutes}′` : ''}{p.allergens.length ? ` · ${p.allergens.map((a) => allergenLabel(t, a)).join(locale === 'ar' ? '، ' : ', ')}` : ''}</div></td>
                            <td className="num">{money(p.priceMinor, p.currency, locale)}</td>
                            <td>
                              {can('menu:availability') ? (
                                <label className="check">
                                  <input type="checkbox" checked={available(p)} onChange={(e) => void run(() => call(`/o/${org.id}/menu/products/${p.id}/availability`, { body: { branchId, available: e.target.checked } }))} />
                                  {available(p) ? t('core.menu.available') : t('core.menu.soldOut')}
                                </label>
                              ) : <Badge tone={available(p) ? 'ok' : 'danger'}>{available(p) ? t('core.menu.available') : t('core.menu.soldOut')}</Badge>}
                            </td>
                            <td style={{ textAlign: 'end' }}>{write && <button className="btn btn-sm" onClick={() => setEditing(p)}>{t('action.edit')}</button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}
        </>
      ) : tab === 'modifiers' ? <ModifiersTab menu={m} reload={() => menu.reload()} /> : <ImportTab onDone={() => menu.reload()} />}
      {editing && m && <ProductModal menu={m} product={editing === 'new' ? null : editing} branchId={branchId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void menu.reload(); }} />}
    </ModuleGate>
  );
}

function ProductModal({ menu, product, branchId, onClose, onSaved }: { menu: MenuEditorView; product: Product | null; branchId: string; onClose: () => void; onSaved: () => void }) {
  const { t, locale } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const { org, can, hasModule } = useOrg();
  const { call } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [groupIds, setGroupIds] = useState<string[]>(product?.modifierGroupIds ?? []);
  const fileRef = useRef<HTMLInputElement>(null);
  const currency = menu.currency as 'EGP' | 'SAR';
  const branch = product?.branchSettings.find((s) => s.branchId === branchId);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true); setError(null);
    try {
      const body = {
        categoryId: String(f.get('categoryId')), name: String(f.get('name')), nameAr: (f.get('nameAr') as string) || null,
        description: (f.get('description') as string) || null, descriptionAr: (f.get('descriptionAr') as string) || null,
        priceMinor: parseMajor(String(f.get('price')), currency), costMinor: f.get('cost') ? parseMajor(String(f.get('cost')), currency) : null,
        station: (f.get('station') as string) || undefined, prepMinutes: f.get('prep') ? Number(f.get('prep')) : null, spiceLevel: Number(f.get('spice') ?? 0),
        allergens: list(f.get('allergens')), dietary: list(f.get('dietary')), ingredients: list(f.get('ingredients')),
      };
      let saved: Product = product
        ? await call<Product>(`/o/${org.id}/menu/products/${product.id}`, { method: 'PATCH', body: { ...body, version: product.version } })
        : await call<Product>(`/o/${org.id}/menu/products`, { body });
      if (JSON.stringify([...groupIds].sort()) !== JSON.stringify([...(product?.modifierGroupIds ?? [])].sort())) {
        saved = await call<Product>(`/o/${org.id}/menu/products/${saved.id}/modifier-groups`, { method: 'PUT', body: { groupIds } });
      }
      const priceOverride = f.get('override') ? parseMajor(String(f.get('override')), currency) : null;
      const stock = f.get('stock') !== '' && f.get('stock') !== null ? Number(f.get('stock')) : null;
      if (branchId && (priceOverride !== (branch?.priceOverrideMinor ?? null) || stock !== (branch?.stockQty ?? null))) {
        await call(`/o/${org.id}/menu/products/${saved.id}/branches/${branchId}`, { method: 'PUT', body: { priceOverrideMinor: priceOverride, stockQty: stock } });
      }
      const file = fileRef.current?.files?.[0];
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await call(`/o/${org.id}/menu/products/${saved.id}/image`, { body: fd });
      }
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setPending(false); }
  }
  const major = (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2));

  return (
    <Modal open onClose={onClose} title={product ? t('core.menu.editItem') : t('core.menu.newItem')}>
      {confirmDialog}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label={t('core.menu.name')} name="name" required maxLength={120} defaultValue={product?.name} />
          <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={120} defaultValue={product?.nameAr ?? ''} />
        </div>
        <SelectField label={t('core.menu.category')} name="categoryId" defaultValue={product?.categoryId ?? menu.categories.find((c) => c.isActive)?.id}>
          {menu.categories.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <TextareaField label={t('core.menu.description')} name="description" maxLength={1000} defaultValue={product?.description ?? ''} />
        <TextareaField label={t('core.menu.descriptionAr')} name="descriptionAr" dir="rtl" maxLength={1000} defaultValue={product?.descriptionAr ?? ''} />
        <div className="form-row">
          <Field label={t('core.menu.price', { currency })} name="price" required inputMode="decimal" pattern="\d+(\.\d{1,2})?" defaultValue={major(product?.priceMinor)} />
          <Field label={t('core.menu.cost', { currency })} name="cost" inputMode="decimal" pattern="\d+(\.\d{1,2})?" defaultValue={major(product?.costMinor)} hint={t('core.menu.costHint')} />
        </div>
        <div className="form-row">
          <Field label={t('core.menu.station')} name="station" list="stations" maxLength={40} defaultValue={product?.station ?? ''} />
          <Field label={t('core.menu.prep')} name="prep" type="number" min={0} max={600} defaultValue={product?.prepMinutes ?? ''} />
          <SelectField label={t('core.menu.spice')} name="spice" defaultValue={String(product?.spiceLevel ?? 0)}>
            {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? '—' : '•'.repeat(n)}</option>)}
          </SelectField>
        </div>
        <datalist id="stations">{menu.stations.map((s) => <option key={s} value={s} />)}</datalist>
        <Field label={t('core.menu.allergens')} name="allergens" defaultValue={product?.allergens.join(', ')} hint={t('core.menu.listHint')} />
        <Field label={t('core.menu.dietary')} name="dietary" defaultValue={product?.dietary.join(', ')} hint="vegetarian, vegan, halal, gluten_free" />
        <Field label={t('core.menu.ingredients')} name="ingredients" defaultValue={product?.ingredients.join(', ')} />
        {menu.modifierGroups.filter((g) => g.isActive).length > 0 && (
          <fieldset style={{ border: 0, padding: 0, margin: '0 0 14px' }}>
            <legend className="fine" style={{ fontWeight: 650 }}>{t('core.menu.modifiers')}</legend>
            <div className="row">
              {menu.modifierGroups.filter((g) => g.isActive).map((g) => (
                <label key={g.id} className="check"><input type="checkbox" checked={groupIds.includes(g.id)}
                  onChange={(e) => setGroupIds(e.target.checked ? [...groupIds, g.id] : groupIds.filter((x) => x !== g.id))} /> {g.name}</label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="form-row">
          <Field label={t('core.menu.branchPrice', { currency })} name="override" inputMode="decimal" defaultValue={major(branch?.priceOverrideMinor)} hint={t('core.menu.branchPriceHint')} />
          <Field label={t('core.menu.stock')} name="stock" type="number" min={0} defaultValue={branch?.stockQty ?? ''} hint={t('core.menu.stockHint')} />
        </div>
        <label className="field"><span>{t('core.menu.image')}</span><input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" /></label>
        {product && can('studio:write') && hasModule('studio') && (
          <p className="fine" style={{ marginTop: -6 }}>
            <Link href={`/dashboard/${org.id}/studio-media?product=${product.id}`}>{t('studio.ai.photo.enhanceFromMenu')}</Link>
            {' · '}{t('studio.ai.photo.enhanceFromMenuHint')}
          </p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          {product ? <button type="button" className="btn btn-danger" onClick={async () => {
            if (!(await confirm({ title: t('core.menu.archiveItem'), tone: 'danger', confirmLabel: t('core.menu.archive') }))) return;
            try { await call(`/o/${org.id}/menu/products/${product.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { setError((e as Error).message); }
          }}>{t('core.menu.archive')}</button> : <span />}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
            <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : t('action.save')}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function ModifiersTab({ menu, reload }: { menu: MenuEditorView; reload: () => Promise<void> }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } };
  const currency = menu.currency as 'EGP' | 'SAR';

  async function addGroup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    await run(() => call(`/o/${org.id}/menu/modifier-groups`, { body: { name: String(f.get('name')), nameAr: (f.get('nameAr') as string) || null, minSelect: Number(f.get('min')), maxSelect: Number(f.get('max')) } }));
    form.reset();
  }
  const addOption = async (g: ModifierGroup, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    await run(() => call(`/o/${org.id}/menu/modifier-groups/${g.id}/options`, { body: { name: String(f.get('name')), nameAr: (f.get('nameAr') as string) || null, priceDeltaMinor: f.get('delta') ? parseMajor(String(f.get('delta')), currency) : 0 } }));
    form.reset();
  };

  return (
    <div className="stack">
      {error && <Notice tone="danger">{error}</Notice>}
      <form className="card" onSubmit={addGroup}>
        <h2>{t('core.menu.newGroup')}</h2>
        <div className="form-row">
          <Field label={t('core.menu.name')} name="name" required maxLength={80} placeholder={t('core.menu.groupExample')} />
          <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={80} />
          <Field label={t('core.menu.min')} name="min" type="number" min={0} max={20} defaultValue={0} />
          <Field label={t('core.menu.max')} name="max" type="number" min={1} max={20} defaultValue={1} />
        </div>
        <button className="btn btn-primary">{t('action.add')}</button>
      </form>
      {!menu.modifierGroups.length && <div className="card"><EmptyState title={t('core.menu.noGroups')} /></div>}
      {menu.modifierGroups.map((g) => (
        <section key={g.id} className="card" style={{ opacity: g.isActive ? 1 : 0.55 }}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{pick(locale, g.name, g.nameAr)} <span className="fine">{t('core.menu.selectRange', { min: g.minSelect, max: g.maxSelect })}</span></h2>
            {g.isActive && <button className="btn btn-sm btn-danger" onClick={() => void run(() => call(`/o/${org.id}/menu/modifier-groups/${g.id}`, { method: 'DELETE' }))}>{t('core.menu.archive')}</button>}
          </div>
          {g.options.map((o) => (
            <div key={o.id} className="spread" style={{ borderBottom: '1px solid var(--line-soft)', padding: '8px 0' }}>
              <span>{pick(locale, o.name, o.nameAr)} {o.priceDeltaMinor ? <span className="fine">+{money(o.priceDeltaMinor, currency, locale)}</span> : null}</span>
              <span className="row">
                <label className="check"><input type="checkbox" checked={o.isAvailable} onChange={(e) => void run(() => call(`/o/${org.id}/menu/modifier-options/${o.id}`, { method: 'PATCH', body: { isAvailable: e.target.checked } }))} /> {t('core.menu.available')}</label>
                <button className="btn btn-sm btn-ghost" aria-label={t('action.delete')} onClick={() => void run(() => call(`/o/${org.id}/menu/modifier-options/${o.id}`, { method: 'DELETE' }))}>✕</button>
              </span>
            </div>
          ))}
          {g.isActive && (
            <form className="form-row" style={{ marginTop: 10, alignItems: 'end' }} onSubmit={(e) => void addOption(g, e)}>
              <Field label={t('core.menu.option')} name="name" required maxLength={80} />
              <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={80} />
              <Field label={t('core.menu.delta', { currency })} name="delta" inputMode="decimal" pattern="\d+(\.\d{1,2})?" />
              <div className="field"><button className="btn">{t('action.add')}</button></div>
            </form>
          )}
        </section>
      ))}
    </div>
  );
}

function ImportTab({ onDone }: { onDone: () => Promise<void> }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newIdempotencyKey());
  const errors = useMemo(() => preview?.summary.errors ?? 0, [preview]);

  const doPreview = async () => {
    setError(null); setDone(null); setPending(true);
    try { setPreview(await call<MenuImportPreview>(`/o/${org.id}/menu/import/preview`, { body: { csv, source: 'csv' } })); key.current = newIdempotencyKey(); }
    catch (e) { setError((e as Error).message); setPreview(null); } finally { setPending(false); }
  };
  const commit = async () => {
    setError(null); setPending(true);
    try {
      const r = await call<{ created: number; updated: number }>(`/o/${org.id}/menu/import/commit`, { body: { csv, source: 'csv', key: key.current } });
      setDone(t('core.menu.imported', { created: r.created, updated: r.updated }));
      setPreview(null); setCsv('');
      await onDone();
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };
  const exportCsv = async () => {
    const r = await call<{ csv: string }>(`/o/${org.id}/menu/export`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'menu.csv';
    a.click();
  };

  return (
    <div className="stack">
      <section className="card">
        <div className="spread"><h2 style={{ margin: 0 }}>{t('core.menu.importTitle')}</h2><button className="btn btn-sm" onClick={() => void exportCsv()}>{t('action.export')}</button></div>
        <p className="fine">{t('core.menu.importHint')}</p>
        <code className="fine" style={{ display: 'block', marginBottom: 10 }}>externalId,name,nameAr,category,description,price,station,allergens,available</code>
        <input type="file" accept=".csv,text/csv" aria-label={t('core.menu.chooseCsv')} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
        <TextareaField label={t('core.menu.pasteCsv')} value={csv} onChange={(e) => setCsv(e.target.value)} rows={8} style={{ fontFamily: 'monospace', fontSize: 13 }} />
        <button className="btn btn-primary" disabled={!csv.trim() || pending} onClick={() => void doPreview()}>{t('core.menu.review')}</button>
      </section>
      {error && <Notice tone="danger">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
      {preview && (
        <section className="card">
          <div className="spread">
            <h2 style={{ margin: 0 }}>{t('core.menu.previewTitle', { n: preview.summary.total })}</h2>
            <span className="row">
              <Badge tone="info">{t('core.menu.toCreate', { n: preview.summary.create })}</Badge>
              <Badge tone="pay">{t('core.menu.toUpdate', { n: preview.summary.update })}</Badge>
              {errors > 0 && <Badge tone="danger">{t('core.menu.withErrors', { n: errors })}</Badge>}
            </span>
          </div>
          {preview.summary.newCategories.length > 0 && <p className="fine">{t('core.menu.newCategories', { list: preview.summary.newCategories.join(', ') })}</p>}
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="data">
              <thead><tr><th>#</th><th>{t('core.menu.name')}</th><th>{t('core.menu.category')}</th><th>{t('core.menu.price', { currency: '' })}</th><th>{t('core.menu.review')}</th></tr></thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.row} style={r.errors.length ? { background: 'var(--danger-bg)' } : undefined}>
                    <td>{r.row}</td><td>{r.item.name}<div className="fine">{r.action === 'update' ? t('core.menu.willUpdate') : t('core.menu.willCreate')}</div></td>
                    <td>{r.item.category}</td><td className="num">{(r.item.priceMinor / 100).toFixed(2)}</td>
                    <td>{r.errors.map((e) => <div key={e} className="field-error">{e}</div>)}{r.warnings.map((w) => <div key={w} className="fine">{w}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={errors > 0 || pending} onClick={() => void commit()}>{t('core.menu.commit')}</button>
          {errors > 0 && <p className="fine">{t('core.menu.fixErrors')}</p>}
        </section>
      )}
    </div>
  );
}

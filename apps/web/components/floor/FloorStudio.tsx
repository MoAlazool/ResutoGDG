'use client';
// React + SVG port of legacy/public/floor-editor.js (Floor Studio). Geometry and
// behaviour follow the legacy editor; persistence uses the floor API contract
// (MODULE_CONTRACTS.md §8): GET/PUT /o/:orgId/floor/:branchId with baseRevision.
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type PointerEvent as RPointerEvent } from 'react';
import { Notice, Skeleton, useConfirm, useToast } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { useSession } from '@/lib/session';
import { FloorPreview } from './FloorPreview';
import { FloorSceneContent } from './FloorScene';
import { checkpoint, clearDraft, draftKey, emptyHistory, loadDraft, redo as redoHistory, rememberDraft, undo as undoHistory, type History } from './draft-store';
import {
  allItems, arrange, autoNumber, BACKGROUND_MAX_BYTES, BACKGROUND_TYPES, bounds, createItem, demoFloor, duplicateItems, getX, getY, isTable,
  keepsSquare, LAYOUT_HEIGHT, LAYOUT_WIDTH, layoutErrors, normalizeLayout, normalizeRotation, overlaps, put, quantize, resizeFromPointer,
  rotationFromPointer, sameLayout, TABLE_FEATURES, toSaveBody, type AddKind, type ArrangeAction, type FloorItem, type FloorLayout,
  type FloorObject, type FloorTable, type LayoutError,
} from './model';
import { useFloorLabels } from './use-floor-labels';
import './floor.css';

type Gesture =
  | { type: 'pan'; start: { x: number; y: number }; client: { x: number; y: number }; view: Viewport }
  | { type: 'background'; start: { x: number; y: number }; before: FloorLayout }
  | { type: 'move' | 'resize' | 'rotate'; start: { x: number; y: number }; ids: string[]; before: FloorLayout }
  | { type: 'marquee'; start: { x: number; y: number }; old: string[] };
interface Viewport { x: number; y: number; w: number; h: number }
const FULL_VIEW: Viewport = { x: 0, y: 0, w: LAYOUT_WIDTH, h: LAYOUT_HEIGHT };
const PRIMARY_KINDS: Array<[AddKind, string]> = [['round', '◯'], ['square', '□'], ['rect', '▭'], ['wall', '━'], ['door', '⌜'], ['zone', '▧']];
const MORE_KINDS: Array<[AddKind, string]> = [['booth', '▬'], ['window', '═'], ['counter', '▰'], ['text', 'T'], ['chair', '▱'], ['plant', '♧'], ['divider', '━'], ['entrance', '⌜'], ['kitchen', '▧'], ['bar', '▰'], ['terrace', '☀'], ['outdoor', '♧']];

const localStore = () => { try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; } };

export function FloorStudio({ orgId, branchId, branchName, currency, canWrite, backHref, choices }: {
  orgId: string; branchId: string; branchName: string; currency: string; canWrite: boolean;
  /** Full-bleed editor (VS-23): "Back to service" link to the live floor. */
  backHref?: string;
  /** Show the legacy choice row: build manually, upload a floor plan, create from photos with AI. */
  choices?: boolean;
}) {
  const L = useFloorLabels();
  const { t } = L;
  const session = useSession();
  const toast = useToast();
  const [confirm, confirmDialog] = useConfirm(L.locale);
  const storageKey = draftKey(orgId, branchId);

  const [loadError, setLoadError] = useState<ApiRequestError | null>(null);
  const [base, setBase] = useState<FloorLayout | null>(null);
  const [draft, setDraftState] = useState<FloorLayout | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [view, setView] = useState<Viewport>(FULL_VIEW);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [snap, setSnap] = useState(true);
  const [multi, setMulti] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ currentRevision: number | null } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [overlay, setOverlay] = useState<{ marquee?: { x: number; y: number; w: number; h: number }; guides?: { x: number | null; y: number | null } }>({});
  const [panels, setPanels] = useState({ objects: false, properties: false });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [storageFull, setStorageFull] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const space = useRef(false);
  const pending = useRef<{ key: string; json: string } | null>(null);
  const liveField = useRef<string | null>(null);
  const previewRef = useRef<HTMLDialogElement>(null);

  // ---- Loading ------------------------------------------------------------------
  const load = useCallback(async (opts: { ignoreStored?: boolean } = {}) => {
    setLoadError(null);
    try {
      const saved = normalizeLayout(await session.call(`/o/${orgId}/floor/${branchId}`));
      const stored = opts.ignoreStored ? null : loadDraft(localStore(), storageKey);
      setBase(saved);
      if (stored && !sameLayout(stored.draft, stored.base)) {
        setDraftState(stored.draft);
        setRecovered(true);
        // The draft was made on an older saved floor: never overwrite, offer reload/export.
        if (stored.base.revision !== saved.revision) {
          setBase(stored.base);
          setConflict({ currentRevision: saved.revision });
        }
      } else {
        setDraftState(saved);
      }
      setSelection([]);
      setHistory(emptyHistory());
      setView(FULL_VIEW);
    } catch (e) {
      setLoadError(e instanceof ApiRequestError ? e : new ApiRequestError(0, 'unknown', String(e)));
    }
  }, [session, orgId, branchId, storageKey]);

  useEffect(() => { if (session.ready && session.token) void load(); }, [load, session.ready, session.token]);

  // ---- Derived --------------------------------------------------------------------
  const dirty = !!draft && !!base && !sameLayout(draft, base);
  const errors = useMemo(() => (draft ? layoutErrors(draft) : []), [draft]);
  const warnings = useMemo(() => (draft ? overlaps(draft) : []), [draft]);
  const selected = useMemo(() => (draft ? allItems(draft).filter((o) => selection.includes(o.id)) : []), [draft, selection]);
  const editable = canWrite && !saving;

  // Latest values for document-level handlers.
  const latest = useRef({ draft, base, selection, history, saving, dirty, editable, errors });
  latest.current = { draft, base, selection, history, saving, dirty, editable, errors };

  const setDraft = useCallback((next: FloorLayout, base0?: FloorLayout) => {
    setDraftState(next);
    const ok = rememberDraft(localStore(), storageKey, next, base0 ?? latest.current.base ?? next);
    setStorageFull(!ok && !!localStore());
  }, [storageKey]);

  /** Applies a change as one undoable step. */
  const mutate = useCallback((fn: (d: FloorLayout) => void) => {
    const cur = latest.current.draft;
    if (!cur || !latest.current.editable) return;
    const next = structuredClone(cur);
    fn(next);
    setHistory((h) => checkpoint(h, cur));
    liveField.current = null;
    setDraft(next);
  }, [setDraft]);

  /** Live property edits: one undo step per field focus (legacy behaviour). */
  const liveEdit = useCallback((field: string, fn: (o: FloorItem, d: FloorLayout) => void) => {
    const cur = latest.current.draft;
    const id = latest.current.selection[0];
    if (!cur || !id || !latest.current.editable) return;
    const next = structuredClone(cur);
    const o = allItems(next).find((x) => x.id === id);
    if (!o || o.locked) return;
    fn(o, next);
    const tag = `${id}:${field}`;
    if (liveField.current !== tag) { setHistory((h) => checkpoint(h, cur)); liveField.current = tag; }
    setDraft(next);
  }, [setDraft]);

  // ---- Actions ----------------------------------------------------------------------
  const add = (kind: AddKind) => mutate((d) => {
    const { item, list } = createItem(d, kind, L.labelOf);
    (d[list] as FloorItem[]).push(item);
    setSelection([item.id]);
  });
  const movableIds = () => selected.filter((o) => !o.locked).map((o) => o.id);
  const duplicate = () => {
    if (!selection.length) return;
    mutate((d) => {
      const copies = duplicateItems(allItems(d).filter((o) => selection.includes(o.id) && !o.locked), L.locale === 'ar' ? ' نسخة' : ' copy');
      for (const c of copies) (isTable(c) ? d.tables : (c as FloorObject).type === 'zone' ? d.zones : d.objects).push(c as never);
      setSelection(copies.map((c) => c.id));
    });
  };
  const remove = () => {
    if (!selection.length) return;
    mutate((d) => {
      const drop = (o: FloorItem) => !selection.includes(o.id) || !!o.locked;
      d.tables = d.tables.filter(drop);
      d.objects = d.objects.filter(drop);
      d.zones = d.zones.filter(drop);
    });
    setSelection([]);
  };
  const doArrange = (action: ArrangeAction) => {
    const ids = movableIds();
    if (ids.length < 2) { toast.show({ message: t('studio.floor.alignNeedTwo'), tone: 'warn' }); return; }
    if (action.startsWith('space-') && ids.length < 3) { toast.show({ message: t('studio.floor.spaceNeedThree'), tone: 'warn' }); return; }
    mutate((d) => { arrange(allItems(d).filter((o) => ids.includes(o.id)), action); });
  };
  const nudge = (dx: number, dy: number) => {
    const ids = latest.current.selection;
    if (!ids.length) return;
    mutate((d) => allItems(d).filter((o) => ids.includes(o.id) && !o.locked).forEach((o) => put(o, getX(o) + dx, getY(o) + dy)));
  };
  const rotate15 = () => mutate((d) => allItems(d).filter((o) => selection.includes(o.id) && !o.locked).forEach((o) => { o.rotation = normalizeRotation(o.rotation + 15); }));
  const toggleLock = () => mutate((d) => {
    const items = allItems(d).filter((o) => selection.includes(o.id));
    const lock = !items.some((o) => o.locked);
    items.forEach((o) => { o.locked = lock; });
  });
  const toggleHidden = () => mutate((d) => d.zones.filter((z) => selection.includes(z.id)).forEach((z) => { z.hidden = !z.hidden; }));
  const undo = useCallback(() => {
    const { draft: cur, history: h, editable: ok } = latest.current;
    if (!cur || !ok) return;
    const r = undoHistory(h, cur);
    if (!r) return;
    setHistory(r.history);
    liveField.current = null;
    setDraft(r.draft);
  }, [setDraft]);
  const redo = useCallback(() => {
    const { draft: cur, history: h, editable: ok } = latest.current;
    if (!cur || !ok) return;
    const r = redoHistory(h, cur);
    if (!r) return;
    setHistory(r.history);
    liveField.current = null;
    setDraft(r.draft);
  }, [setDraft]);

  const exportDraft = () => {
    if (!draft) return;
    const blob = new Blob([JSON.stringify({ baseRevision: base?.revision ?? draft.revision, layout: draft }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `resuto-floor-draft-${branchId.slice(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const save = useCallback(async () => {
    const { draft: cur, saving: busy, dirty: changed, errors: errs } = latest.current;
    if (!cur || busy || !changed || !canWrite) return;
    if (errs.length) { toast.show({ message: describeError(errs[0]!, t), tone: 'danger' }); return; }
    const json = JSON.stringify(cur);
    // Same draft → same idempotency key, so a retried save cannot double-apply.
    if (!pending.current || pending.current.json !== json) pending.current = { key: newIdempotencyKey(), json };
    setSaving(true);
    setSaveError(null);
    try {
      const result = normalizeLayout(await session.call(`/o/${orgId}/floor/${branchId}`, { method: 'PUT', body: toSaveBody(cur, pending.current.key) }));
      pending.current = null;
      setBase(result);
      setDraftState(result);
      clearDraft(localStore(), storageKey);
      setSelection([]);
      setHistory(emptyHistory());
      setConflict(null);
      setRecovered(false);
      toast.show({ message: t('studio.floor.saved'), tone: 'ok' });
    } catch (e) {
      const err = e as ApiRequestError;
      const details = (err.details ?? {}) as Record<string, any>;
      let message = err.message;
      if (err.status === 409 && err.code === 'stale_layout') {
        setConflict({ currentRevision: typeof details.currentRevision === 'number' ? details.currentRevision : null });
        message = t('studio.floor.conflict');
      } else if (err.status === 409 && err.code === 'table_in_use') {
        const label = latest.current.base?.tables.find((x) => x.id === details.tableId)?.label ?? '';
        message = t('studio.floor.tableInUse', { label });
      } else if (err.status === 422 && err.code === 'invalid_geometry') {
        message = t('studio.floor.invalidGeometry', { path: String(details.path ?? '') });
      } else if (err.status === 0) {
        message = t('studio.floor.offline');
      }
      setSaveError(message);
      toast.show({ message, tone: 'danger' });
    } finally {
      setSaving(false);
    }
  }, [canWrite, session, orgId, branchId, storageKey, t, toast]);

  const discard = async () => {
    if (!base || !dirty) return;
    if (!(await confirm({ title: t('studio.floor.discardTitle'), body: t('studio.floor.discardBody'), confirmLabel: t('studio.floor.discard'), tone: 'danger' }))) return;
    setDraftState(base);
    clearDraft(localStore(), storageKey);
    setSelection([]);
    setHistory(emptyHistory());
    pending.current = null;
    setRecovered(false);
    setSaveError(null);
  };
  const reloadSaved = async () => {
    if (dirty && !(await confirm({ title: t('studio.floor.reloadTitle'), body: t('studio.floor.reloadBody'), confirmLabel: t('studio.floor.reload'), tone: 'danger' }))) return;
    clearDraft(localStore(), storageKey);
    setConflict(null);
    setRecovered(false);
    setSaveError(null);
    pending.current = null;
    await load({ ignoreStored: true });
  };
  const applyTemplate = async () => {
    if (!(await confirm({ title: t('studio.floor.templateTitle'), body: t('studio.floor.templateBody'), confirmLabel: t('studio.floor.template') }))) return;
    mutate((d) => {
      const demo = demoFloor(d.revision);
      d.zones = demo.zones.map((z) => ({ ...z, label: L.labelOf(z.label) }));
      d.objects = demo.objects.map((o) => ({ ...o, label: L.labelOf(o.label) }));
      d.tables = demo.tables.map((x) => ({ ...x, zone: x.zone ? L.labelOf(x.zone) : null }));
    });
    setSelection([]);
  };
  const blank = async () => {
    if (!(await confirm({ title: t('studio.floor.blankTitle'), body: t('studio.floor.blankBody'), confirmLabel: t('studio.floor.blank'), tone: 'danger' }))) return;
    mutate((d) => { d.tables = []; d.objects = []; d.zones = []; d.background.image = null; });
    setSelection([]);
  };

  const onBackgroundFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!BACKGROUND_TYPES.includes(file.type) || file.size > BACKGROUND_MAX_BYTES) { toast.show({ message: t('studio.floor.bgInvalid'), tone: 'danger' }); return; }
    const reader = new FileReader();
    reader.onload = () => mutate((d) => { d.background.image = String(reader.result); });
    reader.onerror = () => toast.show({ message: t('studio.floor.bgUnreadable'), tone: 'danger' });
    reader.readAsDataURL(file);
  };

  // ---- Canvas gestures ------------------------------------------------------------------
  const toLayout = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (!draft || saving) return;
    const p = toLayout(e.clientX, e.clientY);
    const target = e.target as Element;
    const el = target.closest('[data-object-id]');
    const handle = target.getAttribute('data-handle') as 'resize' | 'rotate' | null;
    svgRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (tool === 'pan' || space.current || e.button === 1 || !canWrite) {
      gesture.current = { type: 'pan', start: p, client: { x: e.clientX, y: e.clientY }, view };
      return;
    }
    if (target.getAttribute('data-background') && !draft.background.locked) {
      gesture.current = { type: 'background', start: p, before: draft };
      return;
    }
    if (el) {
      const id = el.getAttribute('data-object-id')!;
      let sel = selection;
      if (!selection.includes(id)) sel = e.shiftKey || multi ? [...selection, id] : [id];
      else if ((e.shiftKey || multi) && !handle) { setSelection(selection.filter((x) => x !== id)); return; }
      setSelection(sel);
      liveField.current = null;
      const ids = allItems(draft).filter((o) => sel.includes(o.id) && !o.locked).map((o) => o.id);
      gesture.current = { type: handle ?? 'move', start: p, ids: handle ? [id] : ids, before: draft };
    } else {
      gesture.current = { type: 'marquee', start: p, old: e.shiftKey ? selection : [] };
      if (!e.shiftKey) setSelection([]);
    }
  };

  const onPointerMove = (e: RPointerEvent<SVGSVGElement>) => {
    const g = gesture.current;
    if (!g || !draft) return;
    if (g.type === 'pan') {
      const svg = svgRef.current!;
      const scale = g.view.w / svg.getBoundingClientRect().width;
      setView({ ...g.view, x: g.view.x - (e.clientX - g.client.x) * scale, y: g.view.y - (e.clientY - g.client.y) * scale });
      return;
    }
    const p = toLayout(e.clientX, e.clientY);
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    if (g.type === 'marquee') {
      const left = Math.min(g.start.x, p.x), top = Math.min(g.start.y, p.y), right = Math.max(g.start.x, p.x), bottom = Math.max(g.start.y, p.y);
      const inside = allItems(draft).filter((o) => (o as FloorObject).type !== 'zone').filter((o) => {
        const b = bounds(o);
        return b.left >= left && b.right <= right && b.top >= top && b.bottom <= bottom;
      }).map((o) => o.id);
      setSelection([...new Set([...g.old, ...inside])]);
      setOverlay({ marquee: { x: left, y: top, w: right - left, h: bottom - top } });
      return;
    }
    const next = structuredClone(g.before);
    if (g.type === 'background') {
      const bg = next.background;
      bg.x = Math.max(0, Math.min(next.width - bg.width, quantize(g.before.background.x + dx, snap)));
      bg.y = Math.max(0, Math.min(next.height - bg.height, quantize(g.before.background.y + dy, snap)));
      setDraftState(next);
      return;
    }
    const items = allItems(next);
    const beforeItems = allItems(g.before);
    let guides: { x: number | null; y: number | null } | undefined;
    for (const id of g.ids) {
      const o = items.find((x) => x.id === id);
      const before = beforeItems.find((x) => x.id === id);
      if (!o || !before) continue;
      if (g.type === 'move') {
        let nx = quantize(getX(before) + dx, snap), ny = quantize(getY(before) + dy, snap);
        if (snap) {
          const others = beforeItems.filter((i) => !g.ids.includes(i.id) && (i as FloorObject).type !== 'zone');
          const gx = others.find((i) => Math.abs(getX(i) - nx) < 8), gy = others.find((i) => Math.abs(getY(i) - ny) < 8);
          if (gx) nx = getX(gx);
          if (gy) ny = getY(gy);
          guides = { x: gx ? nx : null, y: gy ? ny : null };
        }
        put(o, nx, ny);
      } else if (g.type === 'resize') {
        resizeFromPointer(o, before, p, snap);
      } else {
        o.rotation = rotationFromPointer(before, p, snap);
      }
    }
    setOverlay({ guides });
    setDraftState(next);
  };

  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    setOverlay({});
    if (!g || g.type === 'pan' || g.type === 'marquee') return;
    const cur = latest.current.draft;
    if (cur && !sameLayout(cur, g.before)) {
      setHistory((h) => checkpoint(h, g.before));
      setDraft(cur);
    }
  };

  const zoomBy = useCallback((factor: number, point?: { x: number; y: number }) => {
    setView((v) => {
      const c = point ?? { x: v.x + v.w / 2, y: v.y + v.h / 2 };
      const w = Math.max(300, Math.min(2400, v.w * factor));
      const ratio = w / v.w;
      return { x: c.x - (c.x - v.x) * ratio, y: c.y - (c.y - v.y) * ratio, w, h: (w * 2) / 3 };
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const m = svg.getScreenCTM();
      const p = m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : undefined;
      zoomBy(e.deltaY > 0 ? 1.1 : 1 / 1.1, p ? { x: p.x, y: p.y } : undefined);
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [zoomBy, draft === null]);

  // ---- Keyboard shortcuts (legacy set) ------------------------------------------------------
  useEffect(() => {
    const down = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement;
      if (el.closest('input, select, textarea, [contenteditable=true]') || document.querySelector('dialog[open]')) return;
      if (!el.closest('.floor-studio') && el !== document.body) return;
      if (latest.current.saving || !latest.current.draft) return;
      const ctrl = ev.ctrlKey || ev.metaKey;
      const key = ev.key.toLowerCase();
      if (ev.code === 'Space' && el.closest('.studio-canvas, .canvas-container')) { space.current = true; ev.preventDefault(); return; }
      if (ctrl && key === 's') { ev.preventDefault(); void save(); }
      else if (ctrl && key === 'z') { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
      else if (ctrl && key === 'y') { ev.preventDefault(); redo(); }
      else if (ctrl && key === 'd') { ev.preventDefault(); duplicateRef.current(); }
      else if ((ev.key === 'Delete' || ev.key === 'Backspace') && latest.current.selection.length) { ev.preventDefault(); removeRef.current(); }
      else if (ev.key === 'Escape') setSelection([]);
      else if (ev.key.startsWith('Arrow') && latest.current.selection.length) {
        ev.preventDefault();
        const step = ev.shiftKey ? 10 : 1;
        nudgeRef.current(ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0, ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0);
      } else if ((ev.key === 'Enter' || ev.key === ' ') && el.getAttribute('data-object-id')) {
        ev.preventDefault();
        setSelection([el.getAttribute('data-object-id')!]);
      }
    };
    const up = (ev: KeyboardEvent) => { if (ev.code === 'Space') space.current = false; };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, [save, undo, redo]);
  const duplicateRef = useRef(duplicate); duplicateRef.current = duplicate;
  const removeRef = useRef(remove); removeRef.current = remove;
  const nudgeRef = useRef(nudge); nudgeRef.current = nudge;

  useEffect(() => {
    const before = (ev: BeforeUnloadEvent) => { if (latest.current.dirty) { ev.preventDefault(); ev.returnValue = ''; } };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);

  useEffect(() => {
    const d = previewRef.current;
    if (!d) return;
    if (previewOpen && !d.open) d.showModal();
    if (!previewOpen && d.open) d.close();
  }, [previewOpen]);

  // ---- Render ---------------------------------------------------------------------------------
  if (loadError) {
    return (
      <div className="card">
        <Notice tone="danger">{loadError.status === 404 ? t('studio.floor.notFound') : `${t('state.error')}: ${loadError.message}`}</Notice>
        <button className="btn" style={{ marginBlockStart: 12 }} onClick={() => void load()}>{t('action.retry')}</button>
      </div>
    );
  }
  if (!draft || !base) return <div className="card"><Skeleton lines={6} /></div>;

  const seats = draft.tables.reduce((n, x) => n + x.capacity, 0);
  const zoomPct = Math.round((LAYOUT_WIDTH / view.w) * 100);
  const single = selected.length === 1 ? selected[0]! : null;
  const status = saving ? t('studio.floor.saving') : dirty ? t('studio.floor.unsaved') : t('studio.floor.allSaved');

  return (
    <div className="floor-studio" dir={L.locale === 'ar' ? 'rtl' : 'ltr'}>
      {confirmDialog}
      <header className="studio-header">
        <div className="studio-brand">
          <span className="brand-mark" aria-hidden>r</span>
          <span className="studio-divider" />
          <div><h1>{t('studio.floor.title')}</h1><span>{t('studio.floor.tagline')}</span></div>
        </div>
        <div className="studio-save">
          <span className="draft-status" role="status" data-dirty={dirty}>{dirty ? '● ' : '✓ '}{status}</span>
          {canWrite && <button type="button" onClick={() => void discard()} disabled={!dirty || saving}>{t('studio.floor.discard')}</button>}
          {backHref && <a className="studio-back" href={backHref}>← {t('ops.studio.back')}</a>}
          {canWrite && (
            <button type="button" className="save-layout" onClick={() => void save()} disabled={saving || !dirty || errors.length > 0} aria-keyshortcuts="Control+S">
              {saving ? t('studio.floor.saving') : t('studio.floor.save')}
            </button>
          )}
        </div>
      </header>
      {choices && canWrite && (
        <div className="studio-choices" role="group" aria-label={t('ops.studio.choices')}>
          <button type="button" className="is-on" onClick={() => svgRef.current?.focus()}>▦ {t('ops.studio.manual')}</button>
          <label className="studio-choice-upload">⤒ {t('ops.studio.upload')}<input type="file" accept="image/png,image/jpeg" onChange={onBackgroundFile} disabled={saving} /></label>
          <button type="button" disabled title={t('ops.studio.aiSoon')}>✦ {t('ops.studio.ai')} <small>{t('ops.studio.aiSoon')}</small></button>
        </div>
      )}
      <div className="studio-context">
        <span>{branchName} <b>{t('studio.floor.units')}</b></span>
        <div>
          <button type="button" onClick={() => setPreviewOpen(true)}>{t('studio.floor.preview')}</button>
          {canWrite && <button type="button" onClick={() => void applyTemplate()} disabled={saving}>{t('studio.floor.template')}</button>}
          {canWrite && <button type="button" onClick={() => mutate((d) => autoNumber(d.tables))} disabled={saving}>{t('studio.floor.autoNumber')}</button>}
          {canWrite && <button type="button" onClick={() => void blank()} disabled={saving}>{t('studio.floor.blank')}</button>}
          <button type="button" className="mobile-panel-toggle" aria-expanded={panels.objects} onClick={() => setPanels((p) => ({ ...p, objects: !p.objects }))}>{t('studio.floor.objects')}</button>
          <button type="button" className="mobile-panel-toggle" aria-expanded={panels.properties} onClick={() => setPanels((p) => ({ ...p, properties: !p.properties }))}>{t('studio.floor.properties')}</button>
        </div>
      </div>
      <div className={`studio-body${panels.objects ? ' show-objects' : ''}${panels.properties ? ' show-properties' : ''}`}>
        <aside className="studio-left" aria-label={t('studio.floor.objects')}>
          {canWrite && (
            <>
              <h2>{t('studio.floor.addTitle')}</h2>
              <p>{t('studio.floor.addHint')}</p>
              <div className="object-palette">
                {PRIMARY_KINDS.map(([kind, icon]) => (
                  <button key={kind} type="button" onClick={() => add(kind)} disabled={saving} data-kind={kind}><span aria-hidden>{icon}</span>{t(`studio.floor.kind.${kind}`)}</button>
                ))}
              </div>
              <details className="more-floor-objects">
                <summary>{t('studio.floor.moreObjects')}</summary>
                <div className="object-palette">
                  {MORE_KINDS.map(([kind, icon]) => (
                    <button key={kind} type="button" onClick={() => add(kind)} disabled={saving} data-kind={kind}><span aria-hidden>{icon}</span>{t(`studio.floor.kind.${kind}`)}</button>
                  ))}
                </div>
              </details>
            </>
          )}
          <div className="layer-heading"><h2>{t('studio.floor.layers')}</h2><span>{L.nf.format(allItems(draft).length)}</span></div>
          <div className="floor-layers" role="listbox" aria-multiselectable="true" aria-label={t('studio.floor.layers')}>
            {allItems(draft).map((o) => (
              <button key={o.id} type="button" role="option" aria-selected={selection.includes(o.id)} className={`layer${selection.includes(o.id) ? ' active' : ''}`}
                onClick={(e) => setSelection(multi || e.shiftKey ? (selection.includes(o.id) ? selection.filter((x) => x !== o.id) : [...selection, o.id]) : [o.id])}>
                <span aria-hidden>{isTable(o) ? '▦' : o.type === 'zone' ? '▧' : '◇'}</span>
                <span>{o.locked ? '🔒 ' : ''}{(o as FloorObject).hidden ? '◌ ' : ''}{isTable(o) ? o.label : L.labelOf(o.label)}</span>
                <small>{isTable(o) ? L.seatsLabel(o.capacity) : t(`studio.floor.kind.${o.type}`) === `studio.floor.kind.${o.type}` ? o.type : t(`studio.floor.kind.${o.type}`)}</small>
              </button>
            ))}
          </div>
          {canWrite && (
            <details className="background-panel">
              <summary>{t('studio.floor.background')}</summary>
              <label>{t('studio.floor.bgHint')}<input type="file" accept="image/png,image/jpeg" onChange={onBackgroundFile} disabled={saving} /></label>
              {draft.background.image && (
                <>
                  <label className="check"><input type="checkbox" checked={draft.background.locked} onChange={(e) => mutate((d) => { d.background.locked = e.target.checked; })} /> {t('studio.floor.bgLock')}</label>
                  <label>{t('studio.floor.bgOpacity')}<input type="range" min="0" max="1" step="0.05" value={draft.background.opacity}
                    onChange={(e) => mutate((d) => { d.background.opacity = Number(e.target.value); })} /></label>
                  <BackgroundGeometry layout={draft} t={t} onApply={(g) => mutate((d) => { Object.assign(d.background, g); })} />
                  <button type="button" onClick={() => mutate((d) => { d.background.image = null; })}>{t('studio.floor.bgRemove')}</button>
                </>
              )}
            </details>
          )}
          <p className="studio-note">{t('studio.floor.illustrative')}</p>
        </aside>

        <main className="studio-center">
          <div className="canvas-toolbar">
            <div>
              <button type="button" aria-pressed={tool === 'select'} onClick={() => setTool('select')} title={t('studio.floor.selectHint')}>↖ {t('studio.floor.select')}</button>
              <button type="button" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')} title={t('studio.floor.panHint')}>✥ {t('studio.floor.pan')}</button>
              {canWrite && <button type="button" aria-pressed={multi} onClick={() => setMulti(!multi)} title={t('studio.floor.multiHint')}>{t('studio.floor.multi')}</button>}
            </div>
            <div>
              {canWrite && <button type="button" onClick={undo} disabled={saving || !history.past.length} aria-label={t('studio.floor.undo')} title={`${t('studio.floor.undo')} (Ctrl+Z)`}>↶</button>}
              {canWrite && <button type="button" onClick={redo} disabled={saving || !history.future.length} aria-label={t('studio.floor.redo')} title={`${t('studio.floor.redo')} (Ctrl+Shift+Z)`}>↷</button>}
              <label className="snap-label"><input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> {t('studio.floor.snap')}</label>
            </div>
          </div>
          <div className="canvas-container">
            <svg ref={svgRef} className="studio-canvas" data-tool={tool} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} tabIndex={0}
              role="application" aria-label={t('studio.floor.canvasLabel')} aria-roledescription={t('studio.floor.canvasRole')}
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
              <FloorSceneContent layout={draft} selected={selection} editor grid={snap} mode="editor" seatsLabel={L.seatsLabel} labelOf={L.labelOf} selectAria={L.selectAria} />
              {overlay.marquee && <rect className="marquee-box" x={overlay.marquee.x} y={overlay.marquee.y} width={overlay.marquee.w} height={overlay.marquee.h} />}
              {overlay.guides?.x != null && <path className="snap-guide" d={`M ${overlay.guides.x} 0 V ${LAYOUT_HEIGHT}`} />}
              {overlay.guides?.y != null && <path className="snap-guide" d={`M 0 ${overlay.guides.y} H ${LAYOUT_WIDTH}`} />}
            </svg>
            <div className="zoom-toolbar">
              <button type="button" onClick={() => zoomBy(1.25)} aria-label={t('studio.floor.zoomOut')}>−</button>
              <span aria-live="polite">{L.nf.format(zoomPct)}%</span>
              <button type="button" onClick={() => zoomBy(0.8)} aria-label={t('studio.floor.zoomIn')}>+</button>
              <button type="button" onClick={() => setView(FULL_VIEW)} aria-label={t('studio.floor.fitLabel')}>{t('studio.floor.fit')}</button>
            </div>
          </div>
          <div className="floor-feedback" role="status" aria-live="polite">
            {recovered && !conflict && <div className="floor-recovered">{t('studio.floor.recovered')}</div>}
            {storageFull && <p className="layout-warning">{t('studio.floor.storageFull')}</p>}
            {conflict && (
              <div className="floor-conflict" role="alert">
                <strong>{t('studio.floor.conflict')}</strong> {conflict.currentRevision !== null && t('studio.floor.conflictRevision', { n: conflict.currentRevision })}
                <div className="row">
                  <button type="button" onClick={() => void reloadSaved()}>{t('studio.floor.reload')}</button>
                  <button type="button" onClick={exportDraft}>{t('studio.floor.export')}</button>
                </div>
              </div>
            )}
            {saveError && !conflict && <p className="layout-error">{saveError}</p>}
            {errors.length ? <p className="layout-error">{describeError(errors[0]!, t)}</p>
              : warnings.length ? <p className="layout-warning">{t('studio.floor.overlaps', { list: warnings.slice(0, 3).join(', ') })}</p>
                : <p className="layout-ok">{t('studio.floor.noOverlaps')}</p>}
          </div>
          <div className="canvas-foot">
            <span>{t('studio.floor.footHint')}</span>
            <span>{selected.length ? t('studio.floor.selectedCount', { n: L.nf.format(selected.length) }) : t('studio.floor.summary', { tables: L.nf.format(draft.tables.length), seats: L.nf.format(seats) })}</span>
          </div>
        </main>

        <aside className="studio-right" aria-label={t('studio.floor.properties')}>
          {!selected.length ? (
            <>
              <div className="properties-empty"><span aria-hidden>↖</span><h2>{t('studio.floor.emptyTitle')}</h2><p>{t('studio.floor.emptyBody')}</p></div>
              <div className="editor-tips">
                <h3>{t('studio.floor.shortcuts')}</h3>
                <p><kbd>Shift</kbd> {t('studio.floor.tipShift')}</p>
                <p><kbd>↑ ↓ ← →</kbd> {t('studio.floor.tipArrows')}</p>
                <p><kbd>Ctrl D</kbd> {t('studio.floor.tipDuplicate')}</p>
                <p><kbd>Ctrl Z</kbd> {t('studio.floor.tipUndo')}</p>
                <p><kbd>Ctrl S</kbd> {t('studio.floor.tipSave')}</p>
                <p><kbd>Space</kbd> {t('studio.floor.tipSpace')}</p>
              </div>
            </>
          ) : (
            <>
              <div className="properties-heading">
                <span>{single ? (isTable(single) ? t('studio.floor.kind.table') : t(`studio.floor.kind.${single.type}`)) : t('studio.floor.multiple')}</span>
                <h2>{single ? (isTable(single) ? single.label : L.labelOf(single.label)) : t('studio.floor.selectedCount', { n: L.nf.format(selected.length) })}</h2>
              </div>
              {single && canWrite && (
                <PropertiesForm key={single.id} o={single} layout={draft} currency={currency} t={t} disabled={saving || !!single.locked} liveEdit={liveEdit}
                  onZoneRename={(oldLabel, newLabel) => mutate((d) => {
                    const z = d.zones.find((x) => x.id === single.id);
                    if (z) z.label = newLabel;
                    d.tables.filter((x) => x.zone === oldLabel).forEach((x) => { x.zone = newLabel; });
                  })} />
              )}
              {canWrite && (
                <>
                  <div className="row" style={{ gap: 8, marginBlockStart: 12 }}>
                    <button type="button" onClick={toggleLock} disabled={saving}>{selected.some((o) => o.locked) ? t('studio.floor.unlock') : t('studio.floor.lock')}</button>
                    {single && !isTable(single) && single.type === 'zone' && (
                      <button type="button" onClick={toggleHidden} disabled={saving}>{single.hidden ? t('studio.floor.showZone') : t('studio.floor.hideZone')}</button>
                    )}
                  </div>
                  <details>
                    <summary>{t('studio.floor.arrange')}</summary>
                    <div className="arrange-buttons">
                      {(['align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom', 'space-x', 'space-y'] as ArrangeAction[]).map((a) => (
                        <button key={a} type="button" onClick={() => doArrange(a)} disabled={saving}>{t(`studio.floor.${a}`)}</button>
                      ))}
                    </div>
                  </details>
                  <div className="nudge-buttons">
                    <button type="button" onClick={() => nudge(-10, 0)} aria-label={t('studio.floor.moveLeft')}>←</button>
                    <button type="button" onClick={() => nudge(0, -10)} aria-label={t('studio.floor.moveUp')}>↑</button>
                    <button type="button" onClick={() => nudge(0, 10)} aria-label={t('studio.floor.moveDown')}>↓</button>
                    <button type="button" onClick={() => nudge(10, 0)} aria-label={t('studio.floor.moveRight')}>→</button>
                    <button type="button" onClick={rotate15}>↻ 15°</button>
                  </div>
                  <div className="object-actions">
                    <button type="button" onClick={duplicate} disabled={saving}>{t('studio.floor.duplicate')}</button>
                    <button type="button" className="delete-object" onClick={remove} disabled={saving}>{t('action.delete')}</button>
                  </div>
                </>
              )}
              <p className="studio-note">{t('studio.floor.positionNote')}</p>
            </>
          )}
        </aside>
      </div>

      <dialog ref={previewRef} className="card" onClose={() => setPreviewOpen(false)} aria-labelledby="floor-preview-title"
        style={{ width: 'min(980px, calc(100% - 24px))', border: 0, padding: 20, boxShadow: 'var(--shadow-sheet)' }}>
        <div className="spread" style={{ marginBlockEnd: 12 }}>
          <h2 id="floor-preview-title" style={{ margin: 0 }}>{t('studio.floor.previewTitle')}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewOpen(false)} aria-label={t('action.close')}>✕</button>
        </div>
        {previewOpen && (
          <div style={{ height: 'min(70vh, 560px)' }}>
            <FloorPreview layout={draft} mode="reservation" seatsLabel={L.seatsLabel} labelOf={L.labelOf}
              labels={{ region: t('studio.floor.previewTitle'), zoomIn: t('studio.floor.zoomIn'), zoomOut: t('studio.floor.zoomOut'), fit: t('studio.floor.fitLabel'), view2d: t('studio.floor.view2d'), view3d: t('studio.floor.view3d') }} />
          </div>
        )}
        <p className="fine" style={{ marginBlockStart: 10 }}>{t('studio.floor.illustrative')}</p>
      </dialog>
    </div>
  );
}

function describeError(e: LayoutError, t: (k: string, v?: Record<string, string | number>) => string) {
  return t(`studio.floor.err.${e.code}`, { label: e.label });
}

function NumberInput({ label, value, onValue, min, max, step = 1, disabled }: {
  label: string; value: number; onValue: (n: number) => void; min?: number; max?: number; step?: number; disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((cur) => (Number(cur) === value ? cur : String(value))); }, [value]);
  return (
    <label>{label}
      <input type="number" inputMode="decimal" value={text} min={min} max={max} step={step} disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === '' || !e.target.checkValidity()) return;
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onValue(n);
        }} />
    </label>
  );
}

function PropertiesForm({ o, layout, currency, t, disabled, liveEdit, onZoneRename }: {
  o: FloorItem; layout: FloorLayout; currency: string; disabled: boolean;
  t: (k: string, v?: Record<string, string | number>) => string;
  liveEdit: (field: string, fn: (o: FloorItem, d: FloorLayout) => void) => void;
  onZoneRename: (oldLabel: string, newLabel: string) => void;
}) {
  const table = isTable(o) ? o : null;
  const zoneLabel = useRef(o.label);
  const setXY = (k: 'x' | 'y', n: number) => liveEdit(k, (x) => put(x, k === 'x' ? n : getX(x), k === 'y' ? n : getY(x)));
  const setSize = (k: 'width' | 'height', n: number) => liveEdit(k, (x) => {
    x[k] = n;
    if (isTable(x) && keepsSquare(x)) { x.height = x.width; }
  });
  return (
    <form className="object-properties" onSubmit={(e) => e.preventDefault()}>
      <label>{t('studio.floor.name')}
        <input value={o.label} maxLength={table ? 20 : 80} required disabled={disabled}
          onChange={(e) => liveEdit('label', (x) => { x.label = e.target.value; })}
          onFocus={() => { zoneLabel.current = o.label; }}
          onBlur={(e) => { if (!table && (o as FloorObject).type === 'zone' && zoneLabel.current !== e.target.value) onZoneRename(zoneLabel.current, e.target.value); }} />
      </label>
      {table && (
        <>
          <div className="property-grid">
            <NumberInput label={t('studio.floor.seatsField')} value={table.capacity} min={1} max={50} disabled={disabled}
              onValue={(n) => liveEdit('capacity', (x) => { if (isTable(x) && Number.isInteger(n)) x.capacity = n; })} />
            <label>{t('studio.floor.shape')}
              <select value={table.shape} disabled={disabled} onChange={(e) => liveEdit('shape', (x) => {
                if (!isTable(x)) return;
                x.shape = e.target.value as FloorTable['shape'];
                if (keepsSquare(x)) x.height = x.width;
              })}>
                {(['round', 'square', 'rect', 'booth', 'bar'] as const).map((s) => <option key={s} value={s}>{t(`studio.floor.shape.${s}`)}</option>)}
              </select>
            </label>
          </div>
          <label>{t('studio.floor.zone')}
            <input value={table.zone ?? ''} list="floor-zone-options" maxLength={40} disabled={disabled}
              onChange={(e) => liveEdit('zone', (x) => { if (isTable(x)) x.zone = e.target.value || null; })} />
            <datalist id="floor-zone-options">{layout.zones.map((z) => <option key={z.id} value={z.label} />)}</datalist>
          </label>
          <details>
            <summary>{t('studio.floor.reservationOptions')}</summary>
            <NumberInput label={t('studio.floor.minSpend', { currency })} value={(table.minSpendMinor ?? 0) / 100} min={0} max={1000000} step={0.01} disabled={disabled}
              onValue={(n) => liveEdit('minSpend', (x) => { if (isTable(x)) x.minSpendMinor = n > 0 ? Math.round(n * 100) : null; })} />
            <label className="check"><input type="checkbox" checked={table.premium} disabled={disabled} onChange={(e) => liveEdit('premium', (x) => { if (isTable(x)) x.premium = e.target.checked; })} />{t('studio.floor.premium')}</label>
            <label className="check"><input type="checkbox" checked={table.reservable} disabled={disabled} onChange={(e) => liveEdit('reservable', (x) => { if (isTable(x)) x.reservable = e.target.checked; })} />{t('studio.floor.reservable')}</label>
            <fieldset style={{ border: 0, padding: 0, margin: '8px 0' }}>
              <legend style={{ fontSize: 12, color: '#6e7f67', marginBlockEnd: 8 }}>{t('studio.floor.features')}</legend>
              {TABLE_FEATURES.map((f) => (
                <label key={f} className="check">
                  <input type="checkbox" checked={table.features.includes(f)} disabled={disabled}
                    onChange={(e) => liveEdit('features', (x) => { if (isTable(x)) x.features = e.target.checked ? [...x.features, f] : x.features.filter((y) => y !== f); })} />
                  {t(`studio.floor.feature.${f}`)}
                </label>
              ))}
            </fieldset>
            <label>{t('studio.floor.notes')}
              <textarea maxLength={5000} rows={4} value={table.internalNotes ?? ''} placeholder={t('studio.floor.notesPlaceholder')} disabled={disabled}
                onChange={(e) => liveEdit('notes', (x) => { if (isTable(x)) x.internalNotes = e.target.value || null; })} />
            </label>
          </details>
        </>
      )}
      <details>
        <summary>{t('studio.floor.dimensions')}</summary>
        <p>{t('studio.floor.dimensionsNote')}</p>
        <div className="property-grid">
          <NumberInput label="X" value={getX(o)} disabled={disabled} onValue={(n) => setXY('x', n)} />
          <NumberInput label="Y" value={getY(o)} disabled={disabled} onValue={(n) => setXY('y', n)} />
          <NumberInput label={t('studio.floor.width')} value={o.width} min={table ? 40 : 4} disabled={disabled} onValue={(n) => setSize('width', n)} />
          <NumberInput label={t('studio.floor.height')} value={o.height} min={table ? 40 : 4} disabled={disabled || (!!table && keepsSquare(table))} onValue={(n) => setSize('height', n)} />
          <NumberInput label={t('studio.floor.rotation')} value={o.rotation} min={0} max={359} disabled={disabled} onValue={(n) => liveEdit('rotation', (x) => { x.rotation = normalizeRotation(n); })} />
          {!table && (o as FloorObject).type === 'zone' && (
            <>
              <label>{t('studio.floor.zoneColor')}<input type="color" value={(o as FloorObject).color ?? '#e7efdc'} disabled={disabled} onChange={(e) => liveEdit('color', (x) => { (x as FloorObject).color = e.target.value; })} /></label>
              <label>{t('studio.floor.material')}
                <select value={(o as FloorObject).material ?? 'stone'} disabled={disabled} onChange={(e) => liveEdit('material', (x) => { (x as FloorObject).material = e.target.value as FloorObject['material']; })}>
                  {(['stone', 'wood', 'garden'] as const).map((m) => <option key={m} value={m}>{t(`studio.floor.material.${m}`)}</option>)}
                </select>
              </label>
            </>
          )}
        </div>
      </details>
      <p className="live-property-note">{t('studio.floor.liveNote')}</p>
    </form>
  );
}

function BackgroundGeometry({ layout, t, onApply }: { layout: FloorLayout; t: (k: string) => string; onApply: (g: { x: number; y: number; width: number; height: number }) => void }) {
  const bg = layout.background;
  const [g, setG] = useState({ x: bg.x, y: bg.y, width: bg.width, height: bg.height });
  useEffect(() => { setG({ x: bg.x, y: bg.y, width: bg.width, height: bg.height }); }, [bg.x, bg.y, bg.width, bg.height]);
  return (
    <form className="property-grid" onSubmit={(e) => { e.preventDefault(); onApply(g); }}>
      {(['x', 'y', 'width', 'height'] as const).map((k) => (
        <label key={k}>{k === 'x' ? 'X' : k === 'y' ? 'Y' : t(`studio.floor.${k}`)}
          <input type="number" value={g[k]} onChange={(e) => setG({ ...g, [k]: Number(e.target.value) })} />
        </label>
      ))}
      <button type="submit" style={{ gridColumn: '1 / -1' }}>{t('studio.floor.bgApply')}</button>
    </form>
  );
}

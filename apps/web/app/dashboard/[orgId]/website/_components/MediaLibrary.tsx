'use client';
import { useRef, useState } from 'react';
import { Badge, EmptyState, Modal, Notice, Skeleton, useConfirm, useToast } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import type { MediaItem } from './types';

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function useUpload(orgId: string) {
  const session = useSession();
  const { t } = useT();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File): Promise<MediaItem | null> => {
    if (!TYPES.includes(file.type) || file.size > MAX_BYTES) { toast.show({ message: t('studio.media.invalid'), tone: 'danger' }); return null; }
    const form = new FormData();
    form.append('file', file);
    form.append('alt', file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').slice(0, 120));
    setUploading(true);
    try {
      const item = await session.call<MediaItem>(`/o/${orgId}/studio/media`, { method: 'POST', body: form });
      toast.show({ message: t('studio.media.uploaded'), tone: 'ok' });
      return item;
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
      return null;
    } finally {
      setUploading(false);
    }
  };
  return { upload, uploading };
}

export function UploadButton({ orgId, onUploaded, label }: { orgId: string; onUploaded: (m: MediaItem) => void; label?: string }) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const { upload, uploading } = useUpload(orgId);
  return (
    <>
      <input ref={input} type="file" accept={TYPES.join(',')} hidden aria-hidden tabIndex={-1}
        onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { const m = await upload(f); if (m) onUploaded(m); } }} />
      <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => input.current?.click()}>
        {uploading ? t('studio.media.uploading') : label ?? t('studio.media.upload')}
      </button>
    </>
  );
}

/** Full media library: upload, alt text, delete (blocked while an image is in use). */
export function MediaLibrary({ orgId, canWrite, compact = false }: { orgId: string; canWrite: boolean; compact?: boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const media = useApi<{ items: MediaItem[] }>(`/o/${orgId}/studio/media`);
  const remove = async (m: MediaItem) => {
    if (!(await confirm({ title: t('studio.media.deleteTitle'), body: t('studio.media.deleteBody'), confirmLabel: t('action.delete'), tone: 'danger' }))) return;
    try {
      await session.call(`/o/${orgId}/studio/media/${m.id}`, { method: 'DELETE' });
      await media.reload();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    }
  };
  const saveAlt = async (m: MediaItem, patch: { alt?: string; altAr?: string }) => {
    try {
      await session.call(`/o/${orgId}/studio/media/${m.id}`, { method: 'PATCH', body: patch });
      await media.reload();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    }
  };
  return (
    <section className={compact ? 'ws-media-compact' : 'card'}>
      {dialog}
      <div className="spread mbe-14">
        <div><h2 className="m-0">{t('studio.media.title')}</h2><p className="fine">{t('studio.media.hint')}</p></div>
        {canWrite && <UploadButton orgId={orgId} onUploaded={() => void media.reload()} />}
      </div>
      {media.error ? <Notice tone="danger">{media.error.message}</Notice>
        : !media.data ? <Skeleton lines={4} />
          : !media.data.items.length ? <EmptyState title={t('studio.media.emptyTitle')}>{t('studio.media.emptyBody')}</EmptyState>
            : (
              <div className="ws-media-grid">
                {media.data.items.map((m) => (
                  <figure key={m.id} className="ws-media">
                    <img src={m.url} alt={m.alt ?? ''} loading="lazy" />
                    <figcaption>
                      <div className="spread"><span className="fine">{Math.round(m.byteSize / 1024)} KB</span>{m.inUse && <Badge tone="info">{t('studio.media.inUse')}</Badge>}</div>
                      {canWrite && (
                        <>
                          <label className="field mbe-6"><span>{t('studio.media.alt')}</span>
                            <input className="input" defaultValue={m.alt ?? ''} maxLength={200} onBlur={(e) => { if (e.target.value !== (m.alt ?? '')) void saveAlt(m, { alt: e.target.value }); }} />
                          </label>
                          <label className="field mbe-6"><span>{t('studio.media.altAr')}</span>
                            <input className="input" dir="rtl" defaultValue={m.altAr ?? ''} maxLength={200} onBlur={(e) => { if (e.target.value !== (m.altAr ?? '')) void saveAlt(m, { altAr: e.target.value }); }} />
                          </label>
                          <button type="button" className="btn btn-sm btn-danger" disabled={m.inUse} title={m.inUse ? t('studio.media.inUseHint') : undefined} onClick={() => void remove(m)}>{t('action.delete')}</button>
                        </>
                      )}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
    </section>
  );
}

/** Choose one image (or several) from the library, with inline upload. */
export function MediaPicker({ orgId, open, onClose, onPick, multiple = false, selected = [] }: {
  orgId: string; open: boolean; onClose: () => void; onPick: (ids: string[], items: MediaItem[]) => void; multiple?: boolean; selected?: string[];
}) {
  const { t } = useT();
  const media = useApi<{ items: MediaItem[] }>(open ? `/o/${orgId}/studio/media` : null);
  const [chosen, setChosen] = useState<string[]>(selected);
  const toggle = (id: string) => setChosen((c) => (multiple ? (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]) : [id]));
  return (
    <Modal open={open} onClose={onClose} title={t('studio.media.pick')}
      footer={<>
        <UploadButton orgId={orgId} onUploaded={(m) => { void media.reload(); setChosen((c) => (multiple ? [...c, m.id] : [m.id])); }} />
        <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!chosen.length && !multiple}
          onClick={() => { onPick(chosen, (media.data?.items ?? []).filter((m) => chosen.includes(m.id))); onClose(); }}>{t('studio.media.use')}</button>
      </>}>
      {!media.data ? <Skeleton lines={3} /> : !media.data.items.length ? <EmptyState title={t('studio.media.emptyTitle')}>{t('studio.media.emptyBody')}</EmptyState> : (
        <div className="ws-media-grid ws-media-pick" role="listbox" aria-multiselectable={multiple}>
          {media.data.items.map((m) => (
            <button key={m.id} type="button" role="option" aria-selected={chosen.includes(m.id)} className="ws-media-option" onClick={() => toggle(m.id)}>
              <img src={m.url} alt={m.alt ?? ''} />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

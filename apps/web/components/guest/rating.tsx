'use client';
// "How was your experience?" (legacy guest.js rating()): five stars, optional food / service / speed / value scores and
// a comment, after the guest has paid. One rating per bill, share or order; the server refuses before payment.
import { useState, type FormEvent } from 'react';
import type { GuestRatingResult } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { Sheet } from './shell';

const DETAILS = ['food', 'service', 'speed', 'value'] as const;

export function RatingSheet({ endpoint, headers, onClose, onDone }: {
  endpoint: string; headers?: Record<string, string>; onClose: () => void; onDone: (r: GuestRatingResult) => void;
}) {
  const { t } = useT();
  const [overall, setOverall] = useState(0);
  const [hover, setHover] = useState(0);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!overall) { setError(t('core.guest.rate.pick')); return; }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { overall, comment: comment.trim() || null };
      for (const k of DETAILS) if (scores[k]) body[k] = Number(scores[k]);
      onDone(await api<GuestRatingResult>(endpoint, { body, headers }));
    } catch (err) {
      setError((err as ApiRequestError).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = hover || overall;
  return (
    <Sheet title={t('core.guest.rate.title')} onClose={onClose}>
      <form onSubmit={submit}>
        <fieldset className="gx-stars" onMouseLeave={() => setHover(0)}>
          <legend>{t('core.guest.rate.overall')}</legend>
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} onMouseEnter={() => setHover(n)}>
              <input type="radio" name="overall" value={n} checked={overall === n} onChange={() => setOverall(n)} aria-label={t('core.guest.rate.star', { score: n })} />
              <span className={n <= shown ? 'is-on' : ''} aria-hidden>★</span>
            </label>
          ))}
        </fieldset>
        <details>
          <summary className="gx-fine" style={{ cursor: 'pointer', fontWeight: 650 }}>{t('core.guest.rate.details')}</summary>
          <div className="gx-scores">
            {DETAILS.map((k) => (
              <label key={k} className="gx-field">
                <span>{t(`core.guest.rate.${k}`)}</span>
                <select value={scores[k] ?? ''} onChange={(e) => setScores((s) => ({ ...s, [k]: e.target.value }))}>
                  <option value="">—</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} ★</option>)}
                </select>
              </label>
            ))}
          </div>
          <label className="gx-field"><span>{t('core.guest.rate.comment')}</span>
            <textarea maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} dir="auto" /></label>
        </details>
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          <button className="gx-btn is-primary is-block" disabled={busy}>{t('core.guest.rate.send')}</button>
          <button type="button" className="gx-btn is-block" onClick={onClose}>{t('core.guest.rate.skip')}</button>
        </div>
      </form>
    </Sheet>
  );
}

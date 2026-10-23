'use client';
// Branded loading shell for guest pages (VP-10): the Resuto mark and "Loading…" where the restaurant name goes, the
// cover and dish-card shapes at their final sizes, so the page never flashes a bare grey skeleton and nothing jumps
// when the content arrives (legacy guest.js showed the "r" mark with "Loading…").
import { useT } from '@/lib/i18n/client';
import { MenuSkeleton } from './skeleton';
import './consumer.css';

export function GuestLoading({ variant = 'menu' }: { variant?: 'menu' | 'booking' | 'card' }) {
  const { t } = useT();
  return (
    <div className={`gx gx-loading${variant === 'booking' ? ' is-booking' : ''}`} aria-busy="true">
      <header className="gx-header">
        <div className="gx-loading-brand"><span className="gx-mark" aria-hidden>r</span><p role="status">{t('core.guest.shell.loading')}</p></div>
        <span className="gx-sk" style={{ width: 120, height: 34, borderRadius: 99 }} aria-hidden />
      </header>
      {variant === 'menu' && (
        <>
          <div className="gx-cover" aria-hidden>
            <div style={{ position: 'static', width: '100%' }}>
              <span className="gx-sk" style={{ width: 110, height: 10, opacity: .4 }} />
              <span className="gx-sk" style={{ width: 'min(520px, 80%)', height: 40, margin: '16px 0', opacity: .35 }} />
              <span className="gx-sk" style={{ width: 'min(360px, 70%)', height: 14, opacity: .3 }} />
            </div>
          </div>
          <main className="gx-main" aria-hidden><MenuSkeleton /></main>
        </>
      )}
      {variant === 'booking' && (
        <main className="bk-page" aria-hidden>
          <span className="gx-sk" style={{ width: 'min(380px, 80%)', height: 42, marginBlockEnd: 16 }} />
          <span className="gx-sk" style={{ width: 'min(520px, 90%)', height: 16, marginBlockEnd: 28 }} />
          {[260, 72, 72].map((h, i) => <span key={i} className="gx-sk" style={{ height: h, borderRadius: 20, marginBlockEnd: 20 }} />)}
        </main>
      )}
      {variant === 'card' && (
        <main className="gx-main" aria-hidden>
          <div className="gx-invitation"><span className="gx-sk" style={{ width: 68, height: 68, borderRadius: '50%', margin: '0 auto 25px' }} />
            <span className="gx-sk" style={{ height: 34, marginBlockEnd: 20 }} /><span className="gx-sk" style={{ height: 120 }} /></div>
        </main>
      )}
    </div>
  );
}


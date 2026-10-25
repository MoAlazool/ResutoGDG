'use client';
// "Customise": show, hide and reorder the overview's sections. Each change is saved at once to the member's own
// preferences (PUT /o/:orgId/preferences/overview); loaded only when the sheet is opened.
import { defaultOverviewPreferences, setOverviewSectionVisible, type OverviewPreferences, type OverviewSectionId } from '@/lib/contracts-home';
import { Sheet, Switch } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { moveAmong, sectionAvailable, type HomeAccess } from './model';
import s from './home.module.css';

export default function CustomiseSheet({ open, onClose, prefs, onChange, status, access }: {
  open: boolean; onClose: () => void; prefs: OverviewPreferences; onChange: (next: OverviewPreferences) => void;
  status: 'idle' | 'saving' | 'saved' | 'error'; access: HomeAccess;
}) {
  const { t } = useT();
  const rows = prefs.sections.filter((x) => sectionAvailable(x.id, access));
  const name = (id: OverviewSectionId) => t(`home.section.${id}`);
  return (
    <Sheet open={open} onClose={onClose} title={t('home.customise.title')} description={t('home.customise.body')} size="sm"
      footer={<div className="spread">
        <span className="fine" role="status" aria-live="polite">
          {status === 'saving' ? t('home.customise.saving') : status === 'saved' ? t('home.customise.saved') : status === 'error' ? t('state.error') : ''}
        </span>
        <div className="row gap-8">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(defaultOverviewPreferences())}>{t('home.customise.reset')}</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>{t('home.customise.done')}</button>
        </div>
      </div>}>
      <ol className={s.customise} aria-label={t('home.customise.title')}>
        {rows.map((row, i) => (
          <li key={row.id} className={s.customiseRow} data-section={row.id}>
            <Switch checked={row.visible} label={name(row.id)} onChange={(v) => onChange(setOverviewSectionVisible(prefs, row.id, v))} />
            <span className={s.moveButtons}>
              <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} aria-label={t('home.customise.up', { name: name(row.id) })}
                onClick={() => onChange(moveAmong(prefs, row.id, -1, access))}><span aria-hidden="true">↑</span></button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={i === rows.length - 1} aria-label={t('home.customise.down', { name: name(row.id) })}
                onClick={() => onChange(moveAmong(prefs, row.id, 1, access))}><span aria-hidden="true">↓</span></button>
            </span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

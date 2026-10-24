'use client';
import { useId, type ReactNode } from 'react';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';

const L = {
  en: { benefits: 'What you get', upgrade: 'See plans', locked: 'Not included in your plan' },
  ar: { benefits: 'ما ستحصل عليه', upgrade: 'عرض الباقات', locked: 'غير مشمول في باقتك' },
};

export interface LockedAction { label: ReactNode; href?: string; onClick?: () => void }

/**
 * A module the restaurant's plan does not include, shown as a tasteful preview instead of raw permission text:
 * a dimmed, inert preview of the real screen, what the module does, its benefits and the upgrade action. Nothing in
 * the preview is interactive or announced (it is `inert` and aria-hidden).
 */
export function LockedFeature({ title, description, benefits, preview, plan, cta, secondary, labels, locale }: {
  title: ReactNode; description?: ReactNode; benefits?: ReactNode[]; preview?: ReactNode;
  /** The plan that includes it ("Growth"). */
  plan?: ReactNode;
  cta?: LockedAction; secondary?: LockedAction; labels?: Partial<typeof L.en>; locale?: UiLocale;
}) {
  const ctx = useUiLocale();
  const t = { ...L[locale ?? ctx], ...labels };
  const id = useId();
  const action = (a: LockedAction, cls: string) => (a.href
    ? <a className={cls} href={a.href} onClick={a.onClick}>{a.label}</a>
    : <button type="button" className={cls} onClick={a.onClick}>{a.label}</button>);
  return (
    <section className="rui-locked" aria-labelledby={`${id}-t`}>
      {preview && <div className="rui-locked-preview" aria-hidden="true" inert>{preview}</div>}
      <div className="rui-locked-card motion-slide-up">
        <span className="rui-locked-badge">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          {plan ?? t.locked}
        </span>
        <h2 id={`${id}-t`}>{title}</h2>
        {description && <p className="rui-locked-desc">{description}</p>}
        {benefits && benefits.length > 0 && (
          <>
            <h3 className="rui-locked-benefits-title">{t.benefits}</h3>
            <ul className="rui-locked-benefits">
              {benefits.map((b, i) => (
                <li key={i}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5" /></svg><span>{b}</span></li>
              ))}
            </ul>
          </>
        )}
        <div className="rui-locked-actions">
          {action(cta ?? { label: t.upgrade }, 'btn btn-primary')}
          {secondary && action(secondary, 'btn btn-ghost')}
        </div>
      </div>
    </section>
  );
}

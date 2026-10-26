'use client';
import type { KeyboardEvent, ReactNode } from 'react';

// SegmentedControl and the RTL-aware arrow-key helpers, in their own module so DataTableV2 (density switch) does not
// pull the rest of controls.tsx (Combobox, MoneyInput, PhoneInput …) into every route with a table. controls.tsx
// re-exports them, so imports from '@resuto/ui' are unchanged.

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
/** Reading direction of an element (the computed `direction`, so it follows dir="" on any ancestor). */
export const isRtl = (el: Element) => getComputedStyle(el).direction === 'rtl';

/** Arrow-key step for a horizontal group: ArrowRight moves forward in LTR and backward in RTL. */
export function horizontalStep(key: string, rtl: boolean): -1 | 0 | 1 {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  if (key === 'ArrowDown') return 1;
  if (key === 'ArrowUp') return -1;
  return 0;
}

// --- SegmentedControl ------------------------------------------------------------------------------------------------
export interface SegmentOption<V extends string> { value: V; label: ReactNode; icon?: ReactNode; disabled?: boolean }

/**
 * One choice among 2-5 options shown side by side (view modes, periods, density). A radio group: Tab enters on the
 * selected option, the arrow keys (mirrored in RTL), Home and End select and move.
 */
export function SegmentedControl<V extends string>({ options, value, onChange, label, size = 'md', className }: {
  options: Array<SegmentOption<V>>; value: V; onChange: (v: V) => void; label: string; size?: 'sm' | 'md'; className?: string;
}) {
  const enabled = options.filter((o) => !o.disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: SegmentOption<V> | undefined;
    const i = enabled.findIndex((o) => o.value === value);
    if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    else {
      const step = horizontalStep(e.key, isRtl(e.currentTarget));
      if (!step) return;
      next = enabled[(i + step + enabled.length) % enabled.length];
    }
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={cx('rui-seg', className)} data-size={size} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1}
          data-value={o.value} disabled={o.disabled} className="rui-seg-item" onClick={() => onChange(o.value)}>
          {o.icon && <span className="rui-seg-icon" aria-hidden="true">{o.icon}</span>}{o.label}
        </button>
      ))}
    </div>
  );
}

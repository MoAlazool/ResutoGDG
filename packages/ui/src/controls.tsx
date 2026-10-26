'use client';
import {
  INTL_LOCALE, PHONE_DIAL, PHONE_EXAMPLE, normalizeNumericInput, normalizePhone, parseMajor, toWesternDigits,
  type Currency, type PhoneCountry,
} from '@resuto/contracts/lite';
import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
export { horizontalStep, isRtl, SegmentedControl, type SegmentOption } from './segmented';

// --- Switch ----------------------------------------------------------------------------------------------------------
/** On/off setting that applies immediately (a native checkbox with role="switch": Space toggles, forms submit it). */
export function Switch({ checked, onChange, label, description, disabled, name, className }: {
  checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; name?: string; className?: string;
}) {
  const id = useId();
  return (
    <label className={cx('rui-switch', className)} data-disabled={disabled || undefined}>
      <input type="checkbox" role="switch" name={name} checked={checked} disabled={disabled} aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)} />
      <span className="rui-switch-track" aria-hidden="true"><span className="rui-switch-thumb" /></span>
      <span className="rui-switch-text">
        <span className="rui-switch-label">{label}</span>
        {description && <small id={`${id}-d`}>{description}</small>}
      </span>
    </label>
  );
}

// --- Combobox --------------------------------------------------------------------------------------------------------
export interface ComboOption { value: string; label: string; hint?: ReactNode; keywords?: string }
const CL = { en: { empty: 'No matches', clear: 'Clear' }, ar: { empty: 'لا نتائج مطابقة', clear: 'مسح' } };
/** Case-, digit- and diacritic-insensitive text for matching ("Café" ~ "cafe", "١٢" ~ "12", "أحمد" ~ "احمد"). */
export const matchText = (s: string) => toWesternDigits(s).normalize('NFKD').replace(/[̀-ًͯ-ٰٟ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLocaleLowerCase().trim();

/**
 * Text input with a filtered list of options (WAI-ARIA 1.2 combobox). Typing filters; ArrowDown/Up move the active
 * option (aria-activedescendant), Enter picks it, Escape closes the list (a second Escape clears the text); Alt+Down
 * opens without moving. `value` is the selected option's value (or null).
 */
export function Combobox({ label, options, value, onChange, placeholder, hint, error, labels, locale, disabled, name, hideLabel, className }: {
  label: ReactNode; options: ComboOption[]; value: string | null; onChange: (value: string | null) => void; placeholder?: string;
  hint?: ReactNode; error?: string | null; labels?: Partial<typeof CL.en>; locale?: UiLocale; disabled?: boolean; name?: string;
  hideLabel?: boolean; className?: string;
}) {
  const ctx = useUiLocale();
  const t = { ...CL[locale ?? ctx], ...labels };
  const id = useId();
  const selected = options.find((o) => o.value === value) ?? null;
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    if (query === null || query === '') return options;
    const q = matchText(query);
    return options.filter((o) => matchText(`${o.label} ${o.keywords ?? ''}`).includes(q));
  }, [options, query]);
  useEffect(() => { if (active >= shown.length) setActive(shown.length - 1); }, [shown.length, active]);
  useEffect(() => {
    if (open && active >= 0) listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);
  const pick = (o: ComboOption | null) => { onChange(o ? o.value : null); setQuery(null); setOpen(false); setActive(-1); };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); if (!e.altKey) setActive(Math.max(0, shown.findIndex((o) => o.value === value))); return; }
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(shown.length - 1); return; }
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && shown[active]) { e.preventDefault(); pick(shown[active]!); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setActive(-1); } else if (query || value) { e.preventDefault(); pick(null); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };
  const text = query ?? selected?.label ?? '';
  const activeId = open && active >= 0 && shown[active] ? `${id}-opt-${active}` : undefined;
  return (
    <div className={cx('field rui-combo', className)}>
      <label id={`${id}-label`} htmlFor={`${id}-input`} className={hideLabel ? 'sr-only' : undefined}>{label}</label>
      <div className="rui-combo-box">
        <input id={`${id}-input`} className="input" role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list"
          aria-activedescendant={activeId} aria-invalid={!!error || undefined} autoComplete="off" name={name} disabled={disabled}
          value={text} placeholder={placeholder}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
          onKeyDown={onKeyDown}
          onBlur={() => { setOpen(false); setQuery(null); setActive(-1); }} />
        <span className="rui-combo-caret" aria-hidden="true" />
      </div>
      <ul id={`${id}-list`} ref={listRef} role="listbox" aria-labelledby={`${id}-label`} className="rui-combo-list motion-fade-in" hidden={!open}>
        {open && shown.map((o, i) => (
          <li key={o.value} id={`${id}-opt-${i}`} role="option" aria-selected={o.value === value} data-index={i} data-active={i === active || undefined}
            className="rui-combo-option" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
            <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
          </li>
        ))}
        {open && !shown.length && <li className="rui-combo-empty" role="presentation">{t.empty}</li>}
      </ul>
      {hint && <small>{hint}</small>}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

// --- MoneyInput ------------------------------------------------------------------------------------------------------
const CURRENCY_LABEL: Record<UiLocale, Record<string, string>> = {
  en: { EGP: 'EGP', SAR: 'SAR', USD: 'USD' },
  ar: { EGP: 'ج.م.', SAR: 'ر.س.', USD: 'دولار' },
};
const ML = {
  en: { invalid: 'Enter an amount such as 125 or 125.50.', negative: 'The amount cannot be negative.' },
  ar: { invalid: 'أدخل مبلغًا مثل 125 أو 125.50.', negative: 'لا يمكن أن يكون المبلغ سالبًا.' },
};

/**
 * Typed text → integer minor units, or null for an empty field; 'invalid' when it is not an amount in `currency`.
 * Arabic-Indic digits, the Arabic decimal and thousands separators and grouping commas are accepted.
 */
export function parseMoneyInput(text: string, currency: Currency): number | null | 'invalid' {
  const s = normalizeNumericInput(text).replace(/[,\s  ]/g, '');
  if (!s) return null;
  try { return parseMajor(s, currency); } catch { return 'invalid'; }
}

/** Minor units → the text a money field shows at rest ("1,250.50", Western digits, no currency). */
export function formatMoneyInput(minor: number, locale: UiLocale = 'en'): string {
  const whole = minor % 100 === 0;
  return new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(minor / 100);
}

/**
 * Amount field in integer minor units. The currency sits at the reading start; the value is reformatted with
 * grouping when the field loses focus. `onChange` receives minor units (null when empty); invalid text keeps the last
 * valid value and shows the message.
 */
export function MoneyInput({ label, valueMinor, onChange, currency, locale, hint, error, allowNegative = false, labels, currencyLabel, ...input }: {
  label: ReactNode; valueMinor: number | null; onChange: (minor: number | null) => void; currency: Currency; locale?: UiLocale;
  hint?: ReactNode; error?: string | null; allowNegative?: boolean; labels?: Partial<typeof ML.en>; currencyLabel?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'>) {
  const ctx = useUiLocale();
  const loc = locale ?? ctx;
  const t = { ...ML[loc], ...labels };
  const [text, setText] = useState(valueMinor === null ? '' : formatMoneyInput(valueMinor, loc));
  const [problem, setProblem] = useState<string | null>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(valueMinor === null ? '' : formatMoneyInput(valueMinor, loc));
  }, [valueMinor, loc]);
  const id = useId();
  const shownError = error ?? problem;
  return (
    <div className="field rui-money">
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="rui-affix" data-invalid={shownError ? '' : undefined}>
        <span className="rui-affix-text" aria-hidden="true">{currencyLabel ?? CURRENCY_LABEL[loc][currency] ?? currency}</span>
        <input {...input} id={`${id}-input`} className="input num" inputMode="decimal" autoComplete="off" value={text} aria-invalid={!!shownError || undefined}
          aria-describedby={shownError ? `${id}-err` : undefined}
          onFocus={(e) => { focused.current = true; input.onFocus?.(e); }}
          onChange={(e) => {
            const next = normalizeNumericInput(e.target.value);
            setText(next);
            const v = parseMoneyInput(next, currency);
            if (v === 'invalid') { setProblem(t.invalid); return; }
            if (v !== null && v < 0 && !allowNegative) { setProblem(t.negative); return; }
            setProblem(null);
            onChange(v);
          }}
          onBlur={(e) => {
            focused.current = false;
            const v = parseMoneyInput(text, currency);
            if (typeof v === 'number' && (allowNegative || v >= 0)) setText(formatMoneyInput(v, loc));
            input.onBlur?.(e);
          }} />
      </div>
      {hint && <small>{hint}</small>}
      {shownError && <span id={`${id}-err`} className="field-error">{shownError}</span>}
    </div>
  );
}

// --- PhoneInput ------------------------------------------------------------------------------------------------------
const PL = {
  en: { invalid: 'Enter a mobile number such as {example}.', example: 'For example {example}' },
  ar: { invalid: 'أدخل رقم جوال مثل {example}.', example: 'مثال: {example}' },
};

/**
 * Phone field for a restaurant's country: left-to-right in both languages, the dialling code shown at the start,
 * Arabic-Indic digits accepted. `onChange` gets the typed text and its E.164 form (null until it is a valid number);
 * the message appears once the field is left with an invalid number.
 */
export function PhoneInput({ label, value, onChange, country, locale, hint, error, labels, ...input }: {
  label: ReactNode; value: string; onChange: (text: string, e164: string | null) => void; country: PhoneCountry; locale?: UiLocale;
  hint?: ReactNode; error?: string | null; labels?: Partial<typeof PL.en>;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'>) {
  const ctx = useUiLocale();
  const t = { ...PL[locale ?? ctx], ...labels };
  const [touched, setTouched] = useState(false);
  const id = useId();
  const example = PHONE_EXAMPLE[country];
  const invalid = touched && value.trim() !== '' && normalizePhone(value, country) === null;
  const shownError = error ?? (invalid ? t.invalid.replace('{example}', example) : null);
  return (
    <div className="field rui-phone">
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className="rui-affix" dir="ltr" data-invalid={shownError ? '' : undefined}>
        <span className="rui-affix-text num">+{PHONE_DIAL[country]}</span>
        <input {...input} id={`${id}-input`} className="input num" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={value}
          placeholder={input.placeholder ?? example} aria-invalid={!!shownError || undefined}
          aria-describedby={[shownError ? `${id}-err` : '', `${id}-hint`].filter(Boolean).join(' ')}
          onChange={(e) => { const next = normalizeNumericInput(e.target.value); onChange(next, normalizePhone(next, country)); }}
          onBlur={(e) => { setTouched(true); input.onBlur?.(e); }} />
      </div>
      <small id={`${id}-hint`}>{hint ?? t.example.replace('{example}', example)}</small>
      {shownError && <span id={`${id}-err`} className="field-error">{shownError}</span>}
    </div>
  );
}

// --- Kbd -------------------------------------------------------------------------------------------------------------
/**
 * Keyboard shortcut hint: <Kbd keys={['Ctrl', 'K']} /> or <Kbd>?</Kbd>. Key names are Latin and laid out left to
 * right in both languages.
 */
export function Kbd({ keys, children, label }: { keys?: string[]; children?: ReactNode; label?: string }) {
  if (keys?.length) {
    return (
      <span className="rui-kbd-combo" dir="ltr" aria-label={label}>
        {keys.map((k, i) => <span key={`${k}${i}`}>{i > 0 && <span className="rui-kbd-plus" aria-hidden="true">+</span>}<kbd className="rui-kbd">{k}</kbd></span>)}
      </span>
    );
  }
  return <kbd className="rui-kbd" dir="ltr" aria-label={label}>{children}</kbd>;
}

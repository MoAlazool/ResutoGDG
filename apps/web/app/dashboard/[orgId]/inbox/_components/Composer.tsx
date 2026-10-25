'use client';
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Badge, Field, Kbd, Notice, SegmentedControl, SelectField } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { insertReply, insertSnippet, matchSavedReplies, replyBody, slashQuery } from '@/lib/inbox';
import { InboxIcon } from './icons';
import type { Detail, SavedReply, Template } from './types';

export type ComposerMode = 'reply' | 'note';
export interface ComposerHandle { focus(mode?: ComposerMode): void }

export interface QuickActions {
  /** The restaurant's online ordering link for the shell's branch (public page), when it takes online orders. */
  orderUrl: string | null;
  /** The booking page, when the branch takes table reservations. */
  reserveUrl: string | null;
  /** Creates a payment link for the conversation's unpaid order (payments:collect), or null when there is none. */
  paymentLink: null | (() => Promise<string>);
}

export interface ComposerProps {
  d: Detail;
  mode: ComposerMode;
  onMode(mode: ComposerMode): void;
  canReply: boolean;
  templates: Template[];
  savedReplies: SavedReply[];
  quick: QuickActions;
  onReply(body: { text: string } | { templateName: string; variables: string[] }): Promise<void>;
  onNote(body: string): Promise<void>;
}

const NOTE_MAX = 4000;

/**
 * Reply or internal note. Notes are staff-only and never sent (POST .../notes); replies follow the channel's window
 * rules (WhatsApp templates after 24 hours; Messenger and Instagram human-agent replies for 7 days). "/" opens the
 * saved replies; the quick actions put a link into the draft, and a person always sends it.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const { d, mode, onMode, canReply, templates, savedReplies, quick, onReply, onNote } = props;
  const { t, locale } = useT();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [templateName, setTemplateName] = useState('');
  const [vars, setVars] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({ focus: (m) => { if (m) onMode(m); requestAnimationFrame(() => area.current?.focus()); } }), [onMode]);
  // A different conversation starts with an empty draft in reply mode.
  useEffect(() => { setText(''); setTemplateName(''); setVars([]); setError(null); setInfo(null); }, [d.id]);

  const pageChannel = d.channel.transport === 'meta_page';
  const humanOpen = pageChannel && !!d.humanReplyUntil && new Date(d.humanReplyUntil).getTime() > Date.now();
  const canWrite = d.window.open || humanOpen;
  const note = mode === 'note';
  const chosen = !note && !pageChannel ? templates.find((tp) => tp.name === templateName) : undefined;

  const slash = slashQuery(text, caret);
  const matches = slash && dismissedAt !== slash.start ? matchSavedReplies(savedReplies, slash.query) : [];
  const pickerOpen = matches.length > 0;
  useEffect(() => { setActive(0); }, [slash?.query, pickerOpen]);

  const update = (next: string, at: number) => { setText(next); setCaret(at); requestAnimationFrame(() => { area.current?.setSelectionRange(at, at); }); };
  const choose = (r: SavedReply) => {
    const out = insertReply(text, caret, replyBody(r, d.locale), slash);
    update(out.text, out.caret);
    area.current?.focus();
  };
  const snippet = (s: string) => {
    const out = insertSnippet(text, area.current?.selectionStart ?? caret, s);
    if (note) onMode('reply');
    update(out.text, out.caret);
    area.current?.focus();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (pending) return;
    setError(null); setInfo(null);
    setPending('send');
    try {
      if (note) { await onNote(text.trim()); setInfo(t('connect.ws.noteSaved')); }
      else if (chosen) await onReply({ templateName: chosen.name, variables: vars });
      else await onReply({ text: text.trim() });
      setText(''); setCaret(0); setTemplateName(''); setVars([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(matches[active] ?? matches[0]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDismissedAt(slash!.start); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); return; }
    if (e.key === 'Escape') { e.preventDefault(); area.current?.blur(); }
  };
  const makePaymentLink = async () => {
    if (!quick.paymentLink) return;
    setError(null); setPending('pay');
    try { snippet(await quick.paymentLink()); setInfo(t('connect.ws.linkInserted')); }
    catch (err) { setError((err as Error).message); }
    finally { setPending(null); }
  };

  if (!canReply) return <div className="composer composer-readonly"><p className="fine m-0">{t('connect.ws.readOnly')}</p></div>;
  const blocked = !note && !chosen && !canWrite;
  const disabled = !!pending || (note ? !text.trim() || text.length > NOTE_MAX
    : chosen ? chosen.variables.some((_, i) => !vars[i]) : !text.trim() || !canWrite);
  const listId = `${id}-replies`;

  return (
    <form className="composer" data-mode={mode} onSubmit={submit} aria-label={note ? t('connect.ws.noteMode') : t('connect.ws.replyMode')}>
      <div className="composer-top">
        <SegmentedControl size="sm" label={t('connect.ws.composeAs')} value={mode} onChange={onMode} options={[
          { value: 'reply', label: <>{t('connect.ws.replyMode')} <Kbd>r</Kbd></> },
          { value: 'note', label: <>{t('connect.ws.noteMode')} <Kbd>n</Kbd></> },
        ]} />
        {!note && <Badge tone={d.window.open ? 'ok' : 'warn'}>{d.window.open ? t('connect.window.open', { until: dateTime(d.window.closesAt, locale) }) : t('connect.window.closed')}</Badge>}
      </div>
      {note
        ? <p className="composer-note-hint"><InboxIcon name="lock" size={14} /> {t('connect.ws.noteHint')}</p>
        : pageChannel ? (!d.window.open && <Notice tone="warn">{humanOpen ? t('connect.window.humanAgent', { until: dateTime(d.humanReplyUntil!, locale) }) : t('connect.window.pageClosed')}</Notice>)
          : !d.window.open && <Notice tone="warn">{t('connect.window.templateOnly')}</Notice>}
      {!note && !pageChannel && templates.length > 0 && (
        <SelectField label={t('connect.inbox.template')} value={templateName} onChange={(e) => { setTemplateName(e.target.value); setVars([]); }}>
          <option value="">{d.window.open ? t('connect.inbox.freeText') : t('connect.inbox.chooseTemplate')}</option>
          {templates.map((tp) => <option key={tp.id} value={tp.name}>{tp.name} ({tp.language}){tp.sandbox ? ` · ${t('connect.sandbox.badge')}` : ''}</option>)}
        </SelectField>
      )}
      {chosen ? chosen.variables.map((v, i) => (
        <Field key={v} label={v} value={vars[i] ?? ''} required onChange={(e) => { const n = [...vars]; n[i] = e.target.value; setVars(n); }} />
      )) : (
        <div className="composer-field">
          <label className="sr-only" htmlFor={`${id}-text`}>{note ? t('connect.ws.noteMode') : t('connect.inbox.message')}</label>
          <textarea id={`${id}-text`} ref={area} className="textarea composer-text" rows={2} value={text} dir="auto"
            placeholder={note ? t('connect.ws.notePlaceholder') : t('connect.ws.replyPlaceholder')}
            maxLength={note ? NOTE_MAX : pageChannel ? 2000 : 4096} disabled={blocked}
            aria-autocomplete="list" aria-controls={pickerOpen ? listId : undefined} aria-activedescendant={pickerOpen ? `${listId}-${active}` : undefined}
            onChange={(e) => { setText(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)} onKeyDown={onKeyDown} />
          {pickerOpen && (
            <ul id={listId} role="listbox" className="composer-replies" aria-label={t('connect.ws.savedReplies')}>
              {matches.map((r, i) => (
                <li key={r.id} id={`${listId}-${i}`} role="option" aria-selected={i === active} className="composer-reply"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => choose(r)} onMouseMove={() => { if (i !== active) setActive(i); }}>
                  <span className="composer-reply-title"><bdi>{r.title}</bdi>{r.shortcut && <span className="composer-reply-key" dir="ltr">/{r.shortcut}</span>}</span>
                  <span className="composer-reply-body"><bdi>{replyBody(r, d.locale)}</bdi></span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {info && !error && <p className="fine m-0" role="status">{info}</p>}
      <div className="composer-send">
        {note ? <span className="fine composer-hint">{t('connect.ws.sendHint')} <Kbd keys={['Ctrl', 'Enter']} /></span> : (
          <div className="composer-quick" role="group" aria-label={t('connect.ws.quickActions')}>
            <button type="button" className="btn btn-sm btn-ghost" disabled={blocked || !savedReplies.length} onClick={() => snippet('/')}>{t('connect.ws.savedReplies')} <Kbd>/</Kbd></button>
            {quick.orderUrl && <button type="button" className="btn btn-sm btn-ghost" disabled={blocked} onClick={() => snippet(quick.orderUrl!)}><InboxIcon name="link" /> {t('connect.ws.orderLink')}</button>}
            {quick.paymentLink && <button type="button" className="btn btn-sm btn-ghost" disabled={blocked || pending === 'pay'} onClick={() => void makePaymentLink()}><InboxIcon name="card" /> {t('connect.ws.paymentLink')}</button>}
            {quick.reserveUrl && <button type="button" className="btn btn-sm btn-ghost" disabled={blocked} onClick={() => snippet(quick.reserveUrl!)}><InboxIcon name="calendar" /> {t('connect.ws.reservationLink')}</button>}
          </div>
        )}
        <button className={note ? 'btn btn-note' : 'btn btn-primary'} disabled={disabled} aria-keyshortcuts="Control+Enter" title={`${t('connect.ws.sendHint')} Ctrl+Enter`}>
          {note ? t('connect.ws.addNote') : t('connect.inbox.send')}
        </button>
      </div>
    </form>
  );
});

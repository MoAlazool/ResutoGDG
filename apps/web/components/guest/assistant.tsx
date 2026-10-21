'use client';
// "Help me choose" (legacy guest.js assistant()/renderRecommendation(), guest-chat.css). A guided conversation over the
// live menu: the guest types what they want (English or Arabic) or sets budget, party and diet; the server answers with
// a validated plan from this menu (rules and this restaurant's order history — labelled as such, not a chatbot).
// Adding the meal only fills the cart; the guest still reviews and confirms.
import { useRef, useState, type FormEvent } from 'react';
import { ASSISTANT_ALLERGENS, type AssistantRequest, type AssistantResult } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { guestMoney as money, pick } from '@/lib/format';
import { MoneyRow, Photo, Sheet } from './shell';

/** The menu-assistant card under the cover (legacy .menu-assistant). */
export function AssistantCard({ onOpen }: { onOpen: () => void }) {
  const { t } = useT();
  return (
    <section className="gx-assistant">
      <div className="gx-spark" aria-hidden>✧</div>
      <div><strong>{t('core.guest.assistant.cardTitle')}</strong><p>{t('core.guest.assistant.cardLabel')}</p></div>
      <button type="button" className="gx-btn" onClick={onOpen}>{t('core.guest.assistant.open')}</button>
    </section>
  );
}

type Turn = { who: 'user'; text: string } | { who: 'bot'; result: AssistantResult } | { who: 'error'; text: string };

export function AssistantSheet({ endpoint, headers, extra, currency, onClose, onAccept }: {
  endpoint: string; headers?: Record<string, string>; extra?: Partial<AssistantRequest>; currency: string; onClose: () => void;
  onAccept: (items: AssistantResult['items']) => void;
}) {
  const { t, locale } = useT();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [budget, setBudget] = useState('');
  const [party, setParty] = useState('');
  const [vegetarian, setVegetarian] = useState(false);
  const [mild, setMild] = useState(false);
  const [quick, setQuick] = useState(false);
  const [exclude, setExclude] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const thread = useRef<HTMLDivElement | null>(null);
  const scroll = () => requestAnimationFrame(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight; });
  const allergenLabel = (a: string) => { const l = t(`core.allergen.${a}`); return l === `core.allergen.${a}` ? a : l; };

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const said = text.trim();
    const budgetMajor = Number(budget.replace(/[,،٬]/g, ''));
    const body: AssistantRequest = {
      ...extra, text: said || null,
      ...(budget.trim() && budgetMajor > 0 ? { budgetMinor: Math.round(budgetMajor * 100) } : {}),
      ...(party.trim() && Number(party) > 0 ? { party: Math.min(20, Math.max(1, Math.round(Number(party)))) } : {}),
      ...(vegetarian ? { vegetarian } : {}), ...(mild ? { mild } : {}), ...(quick ? { quick } : {}),
      ...(exclude.length ? { exclude: exclude as AssistantRequest['exclude'] } : {}),
    };
    setTurns((x) => [...x, { who: 'user', text: said || t('core.guest.assistant.defaultAsk') }]);
    setText('');
    setBusy(true);
    scroll();
    try {
      const result = await api<AssistantResult>(endpoint, { body, headers });
      setTurns((x) => [...x, { who: 'bot', result }]);
    } catch (err) {
      setTurns((x) => [...x, { who: 'error', text: (err as ApiRequestError).message }]);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  const prompts: Array<[string, string]> = [
    [t('core.guest.assistant.p1', { amount: money(currency === 'SAR' ? 20000 : 50000, currency, locale) }), t('core.guest.assistant.p1Label')],
    [t('core.guest.assistant.p2'), t('core.guest.assistant.p2Label')],
    [t('core.guest.assistant.p3'), t('core.guest.assistant.p3Label')],
  ];
  const understood = (r: AssistantResult) => [
    t('core.guest.assistant.understood.party', { n: r.understood.party }),
    ...(r.understood.budgetMinor ? [t('core.guest.assistant.understood.budget', { amount: money(r.understood.budgetMinor, r.currency, locale) })] : []),
    ...(r.understood.vegetarian ? [t('core.guest.assistant.understood.vegetarian')] : []),
    ...(r.understood.mild ? [t('core.guest.assistant.understood.mild')] : []),
    ...(r.understood.quick ? [t('core.guest.assistant.understood.quick')] : []),
    ...(r.understood.exclude.length ? [t('core.guest.assistant.understood.avoid', { list: [...new Set(r.understood.exclude.map(allergenLabel))].join(locale === 'ar' ? '، ' : ', ') })] : []),
  ].join(' · ');

  return (
    <Sheet title={t('core.guest.assistant.title')} onClose={onClose} chat>
      <div className="gx-chat">
        <div ref={thread} className="gx-chat-thread" aria-live="polite">
          <div className="gx-bubble is-bot"><span className="gx-bubble-avatar" aria-hidden>✧</span><div><p>{t('core.guest.assistant.hello')}</p></div></div>
          <div className="gx-prompts">
            {prompts.map(([value, label]) => <button key={label} type="button" onClick={() => setText(value)}>{label}</button>)}
          </div>
          {turns.map((turn, i) => turn.who === 'user' ? (
            <div key={i} className="gx-bubble is-user"><p>{turn.text}</p></div>
          ) : turn.who === 'error' ? (
            <p key={i} className="gx-note is-danger">{turn.text}</p>
          ) : (
            <div key={i}>
              <div className="gx-bubble is-bot"><span className="gx-bubble-avatar" aria-hidden>✧</span>
                <div>
                  <small className="gx-chat-mode">{t('core.guest.assistant.mode')}</small>
                  <p>{turn.result.outcome === 'fits' ? t('core.guest.assistant.fits') : turn.result.outcome === 'over_budget' ? t('core.guest.assistant.overBudget') : t('core.guest.assistant.noMatch')}</p>
                  <p className="gx-fine">{understood(turn.result)}</p>
                </div>
              </div>
              {turn.result.items.length > 0 && (
                <>
                  <div className="gx-meals">
                    {turn.result.items.map((item) => {
                      const name = pick(locale, item.name, item.nameAr);
                      return (
                        <article key={item.productId} className="gx-meal">
                          <Photo src={item.imageUrl} name={name} size={105} />
                          <div>
                            <h3>{name}</h3>
                            <p>{item.reasons.map((r) => t(`core.guest.assistant.reason.${r}`)).join(' · ')}</p>
                            <div className="gx-meal-foot"><span><bdi>{item.quantity}</bdi> × <bdi>{money(item.priceMinor, turn.result.currency, locale)}</bdi></span>
                              <strong><bdi>{money(item.priceMinor * item.quantity, turn.result.currency, locale)}</bdi></strong></div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  <div className="gx-meal-total">
                    <MoneyRow label={t('core.guest.assistant.total')} value={money(turn.result.estimatedTotalMinor, turn.result.currency, locale)} />
                    <button type="button" className="gx-btn is-primary is-block" style={{ marginTop: 12 }} onClick={() => onAccept(turn.result.items)}>{t('core.guest.assistant.accept')}</button>
                  </div>
                </>
              )}
              <p className="gx-allergy-note">{t('core.guest.allergenNote')}</p>
            </div>
          ))}
          {busy && <p role="status" className="gx-fine">{t('core.guest.assistant.thinking')}</p>}
        </div>
        <form className="gx-composer" onSubmit={ask}>
          <details>
            <summary>{t('core.guest.assistant.prefs')}</summary>
            <div className="gx-pref-grid">
              <label className="gx-field" style={{ display: 'grid', gap: 6, fontSize: 13 }}>{t('core.guest.assistant.budget', { currency })}
                <input inputMode="decimal" dir="ltr" value={budget} onChange={(e) => setBudget(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }} /></label>
              <label className="gx-field" style={{ display: 'grid', gap: 6, fontSize: 13 }}>{t('core.guest.assistant.people')}
                <input inputMode="numeric" dir="ltr" value={party} onChange={(e) => setParty(e.target.value)} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px' }} /></label>
            </div>
            <div className="gx-checks">
              <label><input type="checkbox" checked={vegetarian} onChange={(e) => setVegetarian(e.target.checked)} />{t('core.guest.assistant.vegetarian')}</label>
              <label><input type="checkbox" checked={mild} onChange={(e) => setMild(e.target.checked)} />{t('core.guest.assistant.mild')}</label>
              <label><input type="checkbox" checked={quick} onChange={(e) => setQuick(e.target.checked)} />{t('core.guest.assistant.quick')}</label>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="gx-fine">{t('core.guest.assistant.exclude')}</legend>
              <div className="gx-checks">
                {ASSISTANT_ALLERGENS.filter((a) => a !== 'gluten').map((a) => (
                  <label key={a}><input type="checkbox" checked={exclude.includes(a)} onChange={(e) => setExclude((x) => (e.target.checked ? [...x, a] : x.filter((y) => y !== a)))} />{allergenLabel(a)}</label>
                ))}
              </div>
            </fieldset>
          </details>
          <label className="gx-fine" htmlFor="gx-assistant-text">{t('core.guest.assistant.message')}</label>
          <div className="gx-send">
            <textarea id="gx-assistant-text" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('core.guest.assistant.placeholder')}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
            <button className="gx-btn is-primary" disabled={busy}>{t('core.guest.assistant.send')}</button>
          </div>
          <small>{t('core.guest.assistant.honest')}</small>
        </form>
      </div>
    </Sheet>
  );
}

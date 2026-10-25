'use client';
// 21-INT WhatsApp official onboarding (plan §6.9), in Inbox > Channels: Connect with Facebook (Embedded Signup,
// unchanged) → number and branch → ordering → templates and language (from the template library) → staff routing →
// test conversation ("Send a test template to my phone" plus the live inbound check) → activate. Every step uses the
// existing channel, template and ordering APIs; nothing here talks to Meta directly. The QR "compatibility mode" of
// §6.9 is gated research (G-WA) and is not offered.
import { useEffect, useMemo, useState } from 'react';
import { WHATSAPP_ONBOARDING_STEPS, WHATSAPP_TEMPLATE_LIBRARY, WHATSAPP_TEST_TEMPLATE, type ChannelRoutingMode, type WhatsAppOnboardingStep } from '@resuto/contracts/lite';
import { Badge, Field, Notice, SelectField, Sheet, useAction } from '@resuto/ui';
import { time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { EmbeddedSignupCard } from './MetaChannels';
import s from './whatsapp-stepper.module.css';

export interface StepperChannel {
  id: string; kind: string; transport: string; sandbox: boolean; displayName: string; status: string; orderingEnabled: boolean; branchId: string | null;
  verified: boolean | null; webhookSubscribed: boolean | null; routing?: ChannelRoutingMode;
  number?: { displayPhoneNumber: string | null; verifiedName: string | null; qualityRating: string | null } | null;
}
interface Template { id: string; name: string; language: string; providerStatus: string }
interface InboundCheck { received: boolean; lastInboundAt: string | null; webhookSubscribed: boolean | null; verified: boolean | null; sandbox: boolean }

const ROUTING: ChannelRoutingMode[] = ['manual', 'round_robin', 'by_branch'];
const libraryNames = [...new Set(WHATSAPP_TEMPLATE_LIBRARY.map((x) => x.name))];

/** Which steps are done for a channel (the stepper marks them; activation waits for the test). */
export function stepDone(step: WhatsAppOnboardingStep, ch: StepperChannel | null, ctx: { templates: Template[]; tested: boolean }): boolean {
  if (!ch) return false;
  switch (step) {
    case 'connect': return true;
    case 'number': return ch.sandbox || !!ch.verified;
    case 'ordering': return true;
    case 'templates': return ctx.templates.some((x) => x.name === WHATSAPP_TEST_TEMPLATE && (x.providerStatus === 'approved' || (ch.sandbox && x.providerStatus === 'sandbox')));
    case 'routing': return !!ch.routing;
    case 'test': return ctx.tested;
    case 'activate': return ch.status !== 'disabled' && ctx.tested;
  }
}

/** The stepper in a sheet; opens by itself on ?connect=whatsapp (from the marketplace) or after the signup reload. */
export function WhatsAppStepperLauncher({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('connect') === 'whatsapp' || q.get('signup') === 'whatsapp') setOpen(true);
  }, []);
  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>{t('wa.open')}</button>
      {open && (
        <Sheet open onClose={() => setOpen(false)} size="lg" title={t('wa.title')} description={t('wa.subtitle')}>
          <WhatsAppStepper onChanged={onChanged} />
        </Sheet>
      )}
    </>
  );
}

export function WhatsAppStepper({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const channels = useApi<{ items: StepperChannel[] }>(`/o/${org.id}/connect/channels`);
  const templates = useApi<{ items: Template[] }>(`/o/${org.id}/connect/templates`);
  const catalog = useApi<{ items: Array<{ id: string; marketplace?: { providerReview: string | null } }> }>(can('integrations:manage') ? `/o/${org.id}/integrations/catalog` : null);
  const payments = useApi<{ items: Array<{ provider: string; status: string; environment: string; enabled: boolean }> }>(
    can('integrations:manage') ? `/o/${org.id}/integrations/connections?category=payments` : null);
  const [step, setStep] = useState<WhatsAppOnboardingStep>('connect');
  const [channelId, setChannelId] = useState('');
  const [tested, setTested] = useState(false);
  const wa = (channels.data?.items ?? []).filter((c) => c.kind === 'whatsapp');
  const ch = wa.find((c) => c.id === channelId) ?? wa[0] ?? null;
  const tpl = templates.data?.items ?? [];
  const index = WHATSAPP_ONBOARDING_STEPS.indexOf(step);
  const reload = async () => { await Promise.all([channels.reload(), templates.reload()]); await onChanged(); };
  const patch = useAction(async (body: Record<string, unknown>) => {
    await session.call(`/o/${org.id}/connect/channels/${ch!.id}`, { method: 'PATCH', body });
    await reload();
  });
  const review = catalog.data?.items.find((i) => i.id === 'whatsapp_cloud')?.marketplace?.providerReview ?? null;
  const go = (d: number) => setStep(WHATSAPP_ONBOARDING_STEPS[Math.min(Math.max(index + d, 0), WHATSAPP_ONBOARDING_STEPS.length - 1)]!);
  const canNext = step === 'connect' ? wa.length > 0 : !!ch;

  return (
    <div className={s.stepper}>
      <div className={s.chips}>
        <span className="fine">{t('wa.progress', { step: index + 1, total: WHATSAPP_ONBOARDING_STEPS.length })}</span>
        {review && <Badge tone={review === 'approved' ? 'ok' : 'info'}>{t('wa.chip.review', { state: t(`mkt.review.${review}`) })}</Badge>}
        {ch && <Badge tone={ch.sandbox ? 'sandbox' : ch.verified ? 'ok' : 'danger'}>{t(ch.sandbox ? 'wa.number.sandbox' : ch.verified ? 'wa.number.verified' : 'wa.number.unverified')}</Badge>}
      </div>
      <ol className={s.steps} aria-label={t('wa.title')}>
        {WHATSAPP_ONBOARDING_STEPS.map((k, i) => (
          <li key={k}><button type="button" aria-current={k === step ? 'step' : undefined} data-done={stepDone(k, ch, { templates: tpl, tested })}
            disabled={i > 0 && wa.length === 0} onClick={() => setStep(k)}>{i + 1}. {t(`wa.step.${k}`)}</button></li>
        ))}
      </ol>
      <div className={s.body}>
        <h3>{t(`wa.step.${step}`)}</h3>
        {step === 'connect' && <ConnectStep channels={wa} onChanged={reload} />}
        {step === 'number' && (wa.length === 0 ? <Notice tone="warn">{t('wa.number.none')}</Notice> : <>
          <SelectField label={t('wa.number.channel')} value={ch?.id ?? ''} onChange={(e) => setChannelId(e.target.value)}>
            {wa.map((c) => <option key={c.id} value={c.id}>{c.displayName}{c.sandbox ? ` · ${t('connect.sandbox.badge')}` : ''}</option>)}
          </SelectField>
          <SelectField label={t('wa.number.branch')} value={ch?.branchId ?? ''} onChange={(e) => patch.run({ branchId: e.target.value || null })}>
            <option value="">{t('wa.number.allBranches')}</option>
            {org.branches.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
          </SelectField>
          {ch?.number && <ul className={s.list}>
            {ch.number.displayPhoneNumber && <li className="fine">{t('wa.number.state')}: <bdi dir="ltr">{ch.number.displayPhoneNumber}</bdi></li>}
            {ch.number.verifiedName && <li className="fine">{t('wa.number.verifiedName')}: <bdi>{ch.number.verifiedName}</bdi></li>}
            {ch.number.qualityRating && <li className="fine">{t('wa.number.quality')}: <bdi dir="ltr">{ch.number.qualityRating}</bdi></li>}
          </ul>}
        </>)}
        {step === 'ordering' && ch && <OrderingStep ch={ch} onToggle={(v) => patch.run({ orderingEnabled: v })}
          payment={(payments.data?.items ?? []).find((p) => p.enabled && p.status === 'connected' && p.provider !== 'simulated') ?? null} />}
        {step === 'templates' && <TemplatesStep templates={tpl} onChanged={reload} />}
        {step === 'routing' && ch && (
          <fieldset className={s.choices}>
            <legend className="fine">{t('wa.routing.label')}</legend>
            {ROUTING.map((m) => (
              <label key={m} className={s.choice}>
                <input type="radio" name="wa-routing" value={m} checked={(ch.routing ?? 'manual') === m} onChange={() => patch.run({ routing: m })} />
                <strong>{t(`wa.routing.${m}`)}</strong>
                <span className="fine">{t(`wa.routing.${m}Help`)}</span>
              </label>
            ))}
          </fieldset>
        )}
        {step === 'test' && ch && <TestStep ch={ch} onTested={() => setTested(true)} />}
        {step === 'activate' && ch && <>
          <p className="fine m-0">{t('wa.activate.body')}</p>
          {!tested && <Notice tone="warn">{t('wa.activate.needsTest')}</Notice>}
          {ch.status !== 'disabled' && tested ? <Notice tone="ok">{t('wa.activate.done')}</Notice> : (
            <div><button type="button" className="btn btn-primary" disabled={!tested || patch.pending} onClick={() => patch.run({ disabled: false })}>{t('wa.activate.cta')}</button></div>
          )}
        </>}
        {patch.error && <Notice tone="danger">{patch.error}</Notice>}
      </div>
      <div className={s.actions}>
        <button type="button" className="btn btn-ghost" disabled={index === 0} onClick={() => go(-1)}>{t('wa.back')}</button>
        {index < WHATSAPP_ONBOARDING_STEPS.length - 1 && <button type="button" className="btn" disabled={!canNext} onClick={() => go(1)}>{t('wa.next')}</button>}
      </div>
    </div>
  );
}

function ConnectStep({ channels, onChanged }: { channels: StepperChannel[]; onChanged: () => Promise<void> }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const sandbox = useAction(async () => {
    await session.call(`/o/${org.id}/connect/channels`, { body: { transport: 'sandbox', displayName: t('connect.channels.sandboxName') } });
    await onChanged();
  });
  return (
    <>
      <p className="fine m-0">{t('wa.connect.body')}</p>
      <EmbeddedSignupCard onDone={onChanged} />
      <div className={s.item}>
        <span className="fine">{t('wa.connect.have', { n: channels.length })}</span>
        {!channels.some((c) => c.sandbox) && <button type="button" className="btn btn-sm btn-ghost" disabled={sandbox.pending} onClick={() => sandbox.run()}>{t('wa.connect.sandbox')}</button>}
      </div>
      {sandbox.error && <Notice tone="danger">{sandbox.error}</Notice>}
    </>
  );
}

function OrderingStep({ ch, onToggle, payment }: { ch: StepperChannel; onToggle: (v: boolean) => void; payment: { provider: string } | null }) {
  const { t } = useT();
  const { org } = useOrg();
  const branches = org.branches.filter((b) => b.isActive && (!ch.branchId || b.id === ch.branchId));
  const pickup = branches.some((b) => b.acceptsPickup);
  const delivery = branches.some((b) => b.acceptsDelivery);
  return (
    <>
      <label className="check"><input type="checkbox" checked={ch.orderingEnabled} onChange={(e) => onToggle(e.target.checked)} /> {t('wa.ordering.enable')}</label>
      <div className={s.chips}>
        <span className="fine">{t('wa.ordering.fulfilment')}:</span>
        {pickup && <Badge tone="info">{t('wa.ordering.pickup')}</Badge>}
        {delivery && <Badge tone="info">{t('wa.ordering.delivery')}</Badge>}
        {!pickup && !delivery && <span className="fine">{t('wa.ordering.none')}</span>}
        <a className="fine" href={`/dashboard/${org.id}/settings`}>{t('wa.ordering.settings')}</a>
      </div>
      <p className="fine m-0">{t('wa.ordering.menuLink')} <a href={`/m/${org.slug}`} target="_blank" rel="noreferrer" dir="ltr">/m/{org.slug}</a></p>
      <p className="fine m-0">{t('wa.ordering.payment')}: {payment ? t('wa.ordering.paymentOnline', { provider: payment.provider }) : t('wa.ordering.paymentCash')}</p>
    </>
  );
}

function TemplatesStep({ templates, onChanged }: { templates: Template[]; onChanged: () => Promise<void> }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [language, setLanguage] = useState<'en' | 'ar'>(locale);
  const statusOf = (name: string) => templates.find((x) => x.name === name && x.language === language)?.providerStatus ?? 'missing';
  const [picked, setPicked] = useState<string[]>([WHATSAPP_TEST_TEMPLATE]);
  const [added, setAdded] = useState<number | null>(null);
  const add = useAction(async () => {
    let n = 0;
    for (const name of picked.filter((x) => statusOf(x) === 'missing')) {
      const lib = WHATSAPP_TEMPLATE_LIBRARY.find((x) => x.name === name && x.language === language)!;
      const created = await session.call<{ id: string }>(`/o/${org.id}/connect/templates`, { body: lib });
      await session.call(`/o/${org.id}/connect/templates/${created.id}/submit`, { method: 'POST' });
      n++;
    }
    setAdded(n);
    await onChanged();
  });
  const tone = (st: string) => (st === 'approved' ? 'ok' : st === 'rejected' ? 'danger' : st === 'missing' ? 'neutral' : st === 'sandbox' ? 'sandbox' : 'warn');
  return (
    <>
      <p className="fine m-0">{t('wa.templates.body')}</p>
      <SelectField label={t('wa.templates.language')} value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'ar')}>
        <option value="en">{t('wa.templates.lang.en')}</option><option value="ar">{t('wa.templates.lang.ar')}</option>
      </SelectField>
      <ul className={s.list}>
        {libraryNames.map((name) => {
          const lib = WHATSAPP_TEMPLATE_LIBRARY.find((x) => x.name === name && x.language === language)!;
          const st = statusOf(name);
          return (
            <li key={name} className={s.item}>
              <label>
                <input type="checkbox" disabled={st !== 'missing'} checked={st !== 'missing' || picked.includes(name)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, name] : picked.filter((x) => x !== name))} />
                <span><code dir="ltr">{name}</code><br /><span className="fine" dir={language === 'ar' ? 'rtl' : 'ltr'}>{lib.body}</span></span>
              </label>
              <Badge tone={tone(st)}>{t(`wa.templates.status.${st}`)}</Badge>
            </li>
          );
        })}
      </ul>
      <div><button type="button" className="btn" disabled={add.pending || !picked.some((x) => statusOf(x) === 'missing')} onClick={() => add.run()}>{t('wa.templates.add')}</button></div>
      {added !== null && <Notice tone="ok">{t('wa.templates.added', { n: added })}</Notice>}
      {add.error && <Notice tone="danger">{add.error}</Notice>}
    </>
  );
}

function TestStep({ ch, onTested }: { ch: StepperChannel; onTested: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [phone, setPhone] = useState('');
  const [since, setSince] = useState<string | null>(null);
  const [sent, setSent] = useState<{ sandbox: boolean } | null>(null);
  const checkPath = useMemo(() => (since ? `/o/${org.id}/connect/channels/${ch.id}/inbound-check?since=${encodeURIComponent(since)}` : null), [since, org.id, ch.id]);
  const [received, setReceived] = useState(false);
  const check = useApi<InboundCheck>(checkPath, { pollMs: received ? undefined : 3000 });
  useEffect(() => { if (check.data?.received) setReceived(true); }, [check.data?.received]);
  useEffect(() => { if (received) onTested(); }, [received, onTested]);
  const send = useAction(async () => {
    const start = new Date(Date.now() - 1000).toISOString();
    const r = await session.call<{ sandbox: boolean }>(`/o/${org.id}/connect/channels/${ch.id}/test-template`, { body: { phone: phone.trim(), language: locale } });
    setSent(r);
    setSince(start);
  });
  const simulate = useAction(async () => {
    await session.call(`/o/${org.id}/connect/sandbox/inbound`, { body: { channelId: ch.id, from: phone.trim(), text: 'OK' } });
    await check.reload();
  });
  return (
    <>
      <Field label={t('wa.test.phone')} value={phone} dir="ltr" inputMode="tel" placeholder="+201001234567" onChange={(e) => setPhone(e.target.value)} />
      <div><button type="button" className="btn btn-primary" disabled={send.pending || !/^\+[1-9][0-9]{6,14}$/.test(phone.trim())} onClick={() => send.run()}>{t('wa.test.send')}</button></div>
      {send.error && <Notice tone="danger">{send.error}</Notice>}
      {sent && <Notice tone="ok">{t(sent.sandbox ? 'wa.test.sentSandbox' : 'wa.test.sent')}</Notice>}
      {sent && !received && <p className="fine m-0" aria-live="polite">{t('wa.test.waiting')}</p>}
      {received && check.data?.lastInboundAt && <Notice tone="ok">{t('wa.test.received', { time: time(check.data.lastInboundAt, locale) })}</Notice>}
      {sent && ch.sandbox && !received && <div><button type="button" className="btn btn-sm btn-ghost" disabled={simulate.pending} onClick={() => simulate.run()}>{t('wa.test.simulate')}</button></div>}
      {check.data && !check.data.sandbox && (
        <div className={s.chips}><Badge tone={check.data.webhookSubscribed ? 'ok' : 'warn'}>{t(check.data.webhookSubscribed ? 'wa.test.webhook' : 'wa.test.noWebhook')}</Badge></div>
      )}
      {simulate.error && <Notice tone="danger">{simulate.error}</Notice>}
    </>
  );
}

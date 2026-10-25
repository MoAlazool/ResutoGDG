'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Role } from '@resuto/contracts';
import { assignableRoles, INTL_LOCALE } from '@resuto/contracts/lite';
import { Badge, Card, DataTableV2, EmptyState, Field, Modal, Notice, SelectField, Skeleton, Code, Email, Phone, UserText } from '@resuto/ui';
import '@/components/ops/ops.css';
import { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { ROLE_LABELS, TEAM_STRINGS } from './strings';
import styles from './team.module.css';

interface Member { id: string; userId: string; role: Role; branchIds: string[] | null; status: string; fullName: string | null; email: string | null }
interface Invitation { id: string; email: string | null; phone: string | null; role: Role; branchIds: string[] | null; expiresAt: string }

const day = (iso: string, locale: 'en' | 'ar') => new Intl.DateTimeFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { dateStyle: 'medium' }).format(new Date(iso));

function BranchPicker({ value, onChange, branches, s, locale }: {
  value: string[] | null; onChange: (v: string[] | null) => void; branches: Array<{ id: string; name: string; nameAr: string | null }>;
  s: (typeof TEAM_STRINGS)['en']; locale: 'en' | 'ar';
}) {
  return (
    <fieldset className="ops-fieldset">
      <legend>{s.branches}</legend>
      <div className={styles.scope}>
        <label className="check"><input type="radio" checked={value === null} onChange={() => onChange(null)} /> {s.allBranches}</label>
        <label className="check"><input type="radio" checked={value !== null} onChange={() => onChange(branches[0] ? [branches[0].id] : [])} /> {s.someBranches}</label>
      </div>
      {value !== null && (
        <div className="row gap-12 mbs-8">
          {branches.map((b) => (
            <label key={b.id} className="check">
              <input type="checkbox" checked={value.includes(b.id)} onChange={(e) => onChange(e.target.checked ? [...value, b.id] : value.filter((x) => x !== b.id))} />
              {locale === 'ar' && b.nameAr ? b.nameAr : b.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export default function TeamPage() {
  const { locale } = useT();
  const s = TEAM_STRINGS[locale];
  const roles = ROLE_LABELS[locale];
  const { org } = useOrg();
  const session = useSession();
  const team = useApi<{ members: Member[]; invitations: Invitation[] }>(`/o/${org.id}/members`);
  const assignable = assignableRoles(org.role);
  const branchName = (id: string) => { const b = org.branches.find((x) => x.id === id); return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : id.slice(0, 8); };
  const scopeLabel = (ids: string[] | null) => (ids === null ? s.allBranches : ids.map(branchName).join(', '));

  // invite form (the command palette's "Invite a team member" opens the page with ?invite=1: focus the first field)
  const inviteForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('invite') === '1') inviteForm.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, []);
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>(assignable.includes('waiter') ? 'waiter' : assignable[0] ?? 'waiter');
  const [scope, setScope] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; limit?: boolean } | null>(null);
  const [link, setLink] = useState<{ url: string; who: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // row actions
  const [rowError, setRowError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [editScope, setEditScope] = useState<string[] | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!email && !phone) { setError({ text: s.contactRequired }); return; }
    setPending(true); setError(null); setLink(null); setCopied(false);
    try {
      const r = await session.call<{ id: string; token: string; expiresAt: string }>(`/o/${org.id}/invitations`, {
        body: { email: email || undefined, phone: phone || undefined, role, branchIds: scope },
      });
      setLink({ url: `${window.location.origin}/invite/${r.token}`, who: email || phone, expiresAt: r.expiresAt });
      setEmail(''); setPhone('');
      await team.reload();
    } catch (err) {
      const x = err as ApiRequestError;
      setError({ text: x.message, limit: x.code === 'plan_limit_reached' });
    } finally {
      setPending(false);
    }
  }

  async function patch(m: Member, body: Record<string, unknown>) {
    setRowError(null);
    try {
      await session.call(`/o/${org.id}/members/${m.id}`, { method: 'PATCH', body });
      await team.reload();
      return true;
    } catch (err) {
      setRowError((err as Error).message);
      return false;
    }
  }

  async function remove(m: Member) {
    setRowError(null);
    try {
      await session.call(`/o/${org.id}/members/${m.id}`, { method: 'DELETE' });
      setRemoving(null);
      await team.reload();
    } catch (err) {
      setRowError((err as Error).message);
      setRemoving(null);
    }
  }

  const editable = (m: Member) => m.role !== 'owner' && m.userId !== session.me?.user.id && assignable.includes(m.role);
  const members = (team.data?.members ?? []).filter((m) => m.status !== 'removed');

  return (
    <SettingsShell header={{ title: s.title, subtitle: s.subtitle }}>
      {assignable.length === 0 ? <Notice tone="warn">{s.cannotAssign}</Notice> : (
        <Card title={s.invite}>
          <form onSubmit={invite} ref={inviteForm}>
            <div className="form-row">
              <Field label={s.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
              <Field label={s.phone} type="tel" value={phone} placeholder="+201001234567" pattern="\+[1-9][0-9]{6,14}" onChange={(e) => setPhone(e.target.value.trim())} dir="ltr" />
              <SelectField label={s.role} value={role} onChange={(e) => setRole(e.target.value as Role)} hint={role === 'driver' ? s.driverHint : undefined}>
                {assignable.map((r) => <option key={r} value={r}>{roles[r]}</option>)}
              </SelectField>
            </div>
            {org.branches.length > 1 && <BranchPicker value={scope} onChange={setScope} branches={org.branches} s={s} locale={locale} />}
            {error && (
              <div className="mbe-12"><Notice tone="danger">{error.limit ? s.limitHit : error.text}{' '}
                {error.limit && <Link href={`/dashboard/${org.id}/billing`}>{s.upgrade}</Link>}</Notice></div>
            )}
            <button className="btn btn-primary" disabled={pending}>{pending ? s.sending : s.send}</button>
          </form>
          {link && (
            <div className="mbs-16">
              <Notice tone="ok">
                <div className="stack gap-8">
                  <span>{s.linkReady.replace('{who}', link.who).replace('{date}', day(link.expiresAt, locale))}</span>
                  <div className="row gap-8">
                    <input className={`input ${styles.link}`} readOnly value={link.url} dir="ltr" onFocus={(e) => e.target.select()} aria-label={s.linkLabel} />
                    <button type="button" className="btn btn-sm" onClick={async () => { await navigator.clipboard?.writeText(link.url).catch(() => undefined); setCopied(true); }}>
                      {copied ? s.copied : s.copy}
                    </button>
                  </div>
                </div>
              </Notice>
            </div>
          )}
        </Card>
      )}

      {team.error ? <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void team.reload()}>{s.retry}</button></Notice>
        : !team.data ? <Card><Skeleton lines={4} /></Card> : (
          <>
            <Card title={s.members}>
              {rowError && <div className="mbe-12"><Notice tone="danger">{rowError}</Notice></div>}
              <DataTableV2 label={s.members} rows={members} rowKey={(m) => m.id} columns={[
                { key: 'name', header: s.name, render: (m) => (
                  <div><strong>{m.fullName ? <UserText>{m.fullName}</UserText> : m.email ? <Email value={m.email} /> : <Code>{m.userId.slice(0, 8)}</Code>}</strong>
                    {m.userId === session.me?.user.id && <> <Badge tone="info">{s.you}</Badge></>}
                    {m.email && m.fullName && <div className="fine"><Email value={m.email} /></div>}</div>) },
                { key: 'role', header: s.role, render: (m) => editable(m) ? (
                  <select className={`select ${styles.roleSelect}`} value={m.role} aria-label={s.role}
                    onChange={(e) => void patch(m, { role: e.target.value })}>
                    {assignable.map((r) => <option key={r} value={r}>{roles[r]}</option>)}
                  </select>) : roles[m.role] },
                { key: 'branches', header: s.branches, render: (m) => (
                  <span>{scopeLabel(m.branchIds)}{editable(m) && org.branches.length > 1 && (
                    <> <button className="btn btn-ghost btn-sm" aria-label={s.editBranchesAction} onClick={() => { setEditing(m); setEditScope(m.branchIds); }}>✎</button></>)}</span>) },
                { key: 'status', header: s.status, render: (m) => <Badge tone={m.status === 'active' ? 'ok' : 'warn'}>{s[`st_${m.status}` as keyof typeof s] ?? m.status}</Badge> },
                { key: 'actions', header: s.actions, align: 'end', render: (m) => editable(m) ? (
                  <div className="row justify-end gap-6">
                    <button className="btn btn-sm" onClick={() => void patch(m, { status: m.status === 'active' ? 'suspended' : 'active' })}>{m.status === 'active' ? s.suspend : s.reactivate}</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setRemoving(m)}>{s.remove}</button>
                  </div>) : null },
              ]} />
            </Card>
            <Card title={s.pending}>
              {team.data.invitations.length ? (
                <DataTableV2 label={s.pending} rows={team.data.invitations} rowKey={(i) => i.id} columns={[
                  { key: 'who', header: s.name, render: (i) => i.email ? <Email value={i.email} /> : <Phone value={i.phone} /> },
                  { key: 'role', header: s.role, render: (i) => roles[i.role] },
                  { key: 'branches', header: s.branches, render: (i) => scopeLabel(i.branchIds) },
                  { key: 'exp', header: s.status, render: (i) => <span className="muted">{s.expires.replace('{date}', day(i.expiresAt, locale))}</span> },
                ]} />
              ) : <EmptyState title={s.noPending} />}
            </Card>
          </>
        )}

      <Modal open={!!editing} onClose={() => setEditing(null)} title={<>{s.editBranches} — <UserText>{editing?.fullName || editing?.email || ''}</UserText></>}
        footer={<><button className="btn" onClick={() => setEditing(null)}>{s.cancel}</button>
          <button className="btn btn-primary" disabled={editScope !== null && editScope.length === 0}
            onClick={async () => { if (editing && (await patch(editing, { branchIds: editScope }))) setEditing(null); }}>{s.save}</button></>}>
        <BranchPicker value={editScope} onChange={setEditScope} branches={org.branches} s={s} locale={locale} />
      </Modal>
      <Modal open={!!removing} onClose={() => setRemoving(null)} title={s.remove}
        footer={<><button className="btn" onClick={() => setRemoving(null)}>{s.cancel}</button><button className="btn btn-danger" onClick={() => removing && void remove(removing)}>{s.remove}</button></>}>
        <p>{s.removeConfirm.replace('{name}', removing?.fullName || removing?.email || '')}</p>
      </Modal>
    </SettingsShell>
  );
}

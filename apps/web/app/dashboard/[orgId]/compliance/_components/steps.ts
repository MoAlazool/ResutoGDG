// Set-up steps per tax regime (21-MONEY). Pure: derived from the compliance summary, the ZATCA EGS units and the ETA
// connection the API reports, so the stepper never shows a step as done that the data does not prove. The last step
// of every regime is certification, which Resuto does not have: it is always "not certified", never done.

export type StepState = 'done' | 'in_progress' | 'todo' | 'error' | 'outside' | 'not_certified' | 'unknown';
export type StepTarget = 'profile' | 'documents' | 'integrations' | null;
export interface RegimeStep { key: string; state: StepState; target: StepTarget; count?: { done: number; total: number } }

export interface EgsUnitLite { branchId: string; status: string; environment: string; lastError?: string | null }
export interface ComplianceFacts {
  profileValidated: boolean;
  /** Active branches (each needs its own ZATCA EGS unit). */
  branches: number;
  units: EgsUnitLite[] | null;
  /** null: unknown (the role cannot read integration connections). */
  etaConnection: { status: string; environment: string } | null | undefined;
  issued30d: number;
  submissionMode: string;
}

const RANK: Record<string, number> = { key_generated: 1, compliance_csid: 2, compliance_checked: 3, active: 4 };

/** Branches whose most advanced unit has reached `rank` (a retired unit counts for nothing). */
function reached(units: EgsUnitLite[], rank: number): number {
  const best = new Map<string, number>();
  for (const u of units) if (u.status !== 'retired') best.set(u.branchId, Math.max(best.get(u.branchId) ?? 0, RANK[u.status] ?? 0));
  return [...best.values()].filter((r) => r >= rank).length;
}

const progress = (done: number, total: number, blocked = false): StepState => (blocked ? 'error' : total > 0 && done >= total ? 'done' : done > 0 ? 'in_progress' : 'todo');

/** ZATCA Phase 2: tax profile → EGS key and CSR → compliance CSID (OTP) → compliance checks → production CSID, per branch. */
export function zatcaSteps(f: ComplianceFacts): RegimeStep[] {
  const units = (f.units ?? []).filter((u) => u.status !== 'retired');
  const total = Math.max(1, f.branches);
  const failed = units.some((u) => u.status === 'error' || !!u.lastError);
  const stage = (key: string, rank: number): RegimeStep => {
    const done = reached(units, rank);
    return { key, state: f.units === null ? 'unknown' : progress(done, total, failed && done < total), target: 'profile', count: { done, total } };
  };
  return [
    { key: 'profile', state: f.profileValidated ? 'done' : 'todo', target: 'profile' },
    stage('egs', 1),
    stage('csid', 2),
    stage('checks', 3),
    stage('production', 4),
    { key: 'certification', state: 'not_certified', target: null },
  ];
}

/** ETA e-receipt: tax profile → taxpayer and POS registered at ETA (outside Resuto) → POS credentials → receipts → submission. */
export function etaSteps(f: ComplianceFacts): RegimeStep[] {
  const conn = f.etaConnection;
  const connected: StepState = conn === undefined ? 'unknown' : conn === null ? 'todo' : conn.status === 'connected' ? 'done' : conn.status === 'error' ? 'error' : 'in_progress';
  const sent = f.submissionMode === 'production_api' || f.submissionMode === 'sandbox_api';
  return [
    { key: 'profile', state: f.profileValidated ? 'done' : 'todo', target: 'profile' },
    { key: 'portal', state: 'outside', target: null },
    { key: 'connect', state: connected, target: 'integrations' },
    { key: 'documents', state: f.issued30d > 0 ? 'done' : 'todo', target: 'documents' },
    // The sandbox stub records submissions locally: nothing reaches ETA, so this step is never done in that mode.
    { key: 'submission', state: sent ? 'in_progress' : 'todo', target: 'documents' },
    { key: 'certification', state: 'not_certified', target: null },
  ];
}

/** The step to work on next: the first one that is neither done nor outside Resuto's control. */
export function currentStep(steps: RegimeStep[]): string | null {
  return steps.find((s) => s.state !== 'done' && s.state !== 'outside' && s.state !== 'not_certified')?.key ?? null;
}

export const doneCount = (steps: RegimeStep[]) => steps.filter((s) => s.state === 'done').length;

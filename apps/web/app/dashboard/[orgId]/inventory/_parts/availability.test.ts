import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PAR-08: the landing views follow legacy. These pages import through the '@/…' alias (not resolved by the web unit
// tests), so the order is checked on the source; the browser captures in evidence/ws12-parity show the result.
const page = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

describe('inventory and settings open like legacy (PAR-08)', () => {
  it('inventory opens on dish availability, with the stock module in the following tabs', () => {
    const src = page('inventory/page.tsx');
    expect(src).toMatch(/const TABS = \['availability', 'levels', 'movement', 'stocktake', 'items', 'recipes', 'alerts', 'waste', 'history'\] as const;/);
    expect(src).toContain("useState<Tab>('availability')");
    expect(src).toContain("{tab === 'availability' && <AvailabilityTab />}");
    const tab = readFileSync(join(__dirname, 'availability.tsx'), 'utf8');
    // Per dish: portions (own count or recipe), available / sold out, sold-out-today toggle and Configure.
    for (const s of ['portionsOf(p, branchId)', "t('ops.menu.soldOutToday')", "t('ops.avail.configure')", 'branchState(p, branchId).offered']) expect(tab).toContain(s);
  });

  it('settings opens on the service model; profile and the launch checklist follow', () => {
    const src = page('settings/page.tsx');
    const mode = src.indexOf("<Card title={t('ops.mode.title')}>");
    const profile = src.indexOf('<Card title={s.profile}>');
    const checklist = src.indexOf('<Card title={s.checklist}');
    expect(mode).toBeGreaterThan(0);
    expect(mode).toBeLessThan(profile);
    expect(profile).toBeLessThan(checklist);
  });
});

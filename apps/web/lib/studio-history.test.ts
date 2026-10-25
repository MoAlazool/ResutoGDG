import { describe, expect, it } from 'vitest';
import type { SectionContent } from '@resuto/contracts';
import { addEntry, contentEntry, deleteEntry, DraftHistory, HISTORY_LIMIT, moved, reorderEntry, visibilityEntry, websiteEntry, type DraftApi } from './studio-history';

/** An in-memory draft behind the DraftApi, with server-assigned ids (re-creating a section gives it a new id). */
function fakeDraft(initial: Array<{ id: string; kind: string; headline?: string; visible?: boolean }>) {
  let n = 0;
  const sections: Array<{ id: string; kind: string; content: SectionContent; isVisible: boolean }> =
    initial.map((s) => ({ id: s.id, kind: s.kind, content: s.headline ? { headline: { en: s.headline } } : {}, isVisible: s.visible ?? true }));
  let website: Record<string, unknown> = { template: 'olive' };
  const calls: string[] = [];
  const api: DraftApi = {
    async updateWebsite(patch) { calls.push('website'); website = { ...website, ...patch }; },
    async createSection(input) { const id = `srv-${++n}`; calls.push(`create ${input.kind}`); sections.push({ id, ...input }); return { id }; },
    async updateSection(id, patch) {
      const s = sections.find((x) => x.id === id);
      if (!s) throw new Error(`no section ${id}`);
      calls.push(`update ${id}`);
      if (patch.content) s.content = patch.content;
      if (patch.isVisible !== undefined) s.isVisible = patch.isVisible;
    },
    async deleteSection(id) {
      const i = sections.findIndex((x) => x.id === id);
      if (i < 0) throw new Error(`no section ${id}`);
      calls.push(`delete ${id}`);
      sections.splice(i, 1);
    },
    async reorderSections(ids) {
      if (ids.length !== sections.length || ids.some((id) => !sections.some((s) => s.id === id))) throw new Error('order mismatch');
      calls.push('reorder');
      sections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    },
  };
  return { api, sections, calls, website: () => website };
}

async function apply(h: DraftHistory, api: DraftApi, entry: Parameters<DraftHistory['push']>[0]) {
  await h.run(entry.forward, api);
  h.push(entry);
}
async function undo(h: DraftHistory, api: DraftApi) {
  const e = h.takeUndo()!;
  await h.run(e.backward, api);
  h.undone(e);
}
async function redo(h: DraftHistory, api: DraftApi) {
  const e = h.takeRedo()!;
  await h.run(e.forward, api);
  h.redone(e);
}

describe('Studio history stack (undo/redo over draft operations)', () => {
  it('undoes and redoes a content edit, a visibility toggle and a reorder in order', async () => {
    const d = fakeDraft([{ id: 'a', kind: 'hero', headline: 'Old' }, { id: 'b', kind: 'about' }]);
    const h = new DraftHistory();
    await apply(h, d.api, contentEntry('edit hero', 'a', { headline: { en: 'Old' } }, { headline: { en: 'New' } }));
    await apply(h, d.api, visibilityEntry('hide about', 'b', false));
    await apply(h, d.api, reorderEntry('move', ['a', 'b'], ['b', 'a']));
    expect(d.sections.map((s) => s.id)).toEqual(['b', 'a']);
    expect(h.undoLabel).toBe('move');
    await undo(h, d.api);
    expect(d.sections.map((s) => s.id)).toEqual(['a', 'b']);
    await undo(h, d.api);
    expect(d.sections.find((s) => s.id === 'b')!.isVisible).toBe(true);
    await undo(h, d.api);
    expect(d.sections[0]!.content).toEqual({ headline: { en: 'Old' } });
    expect(h.canUndo).toBe(false);
    expect(h.redoLabel).toBe('edit hero');
    await redo(h, d.api);
    expect(d.sections[0]!.content).toEqual({ headline: { en: 'New' } });
    expect(h.canRedo).toBe(true);
  });

  it('a new edit clears the redo list', async () => {
    const d = fakeDraft([{ id: 'a', kind: 'hero' }]);
    const h = new DraftHistory();
    await apply(h, d.api, visibilityEntry('hide', 'a', false));
    await undo(h, d.api);
    expect(h.canRedo).toBe(true);
    await apply(h, d.api, contentEntry('edit', 'a', {}, { headline: { en: 'x' } }));
    expect(h.canRedo).toBe(false);
  });

  it('undoing a delete re-creates the section in its place, and later entries still find it under its reference', async () => {
    const d = fakeDraft([{ id: 'a', kind: 'hero' }, { id: 'b', kind: 'about', headline: 'Story' }, { id: 'c', kind: 'hours' }]);
    const h = new DraftHistory();
    const b = d.sections[1]!;
    await apply(h, d.api, contentEntry('edit about', 'b', { headline: { en: 'Story' } }, { headline: { en: 'Our story' } }));
    await apply(h, d.api, deleteEntry('delete about', 'b', { ...b, content: { headline: { en: 'Our story' } } }, ['a', 'b', 'c']));
    expect(d.sections.map((s) => s.id)).toEqual(['a', 'c']);
    await undo(h, d.api); // re-created under a new server id, back in the middle
    const recreated = d.sections[1]!;
    expect(recreated.id).toBe('srv-1');
    expect(d.sections.map((s) => s.kind)).toEqual(['hero', 'about', 'hours']);
    expect(recreated.content).toEqual({ headline: { en: 'Our story' } });
    expect(h.idOf('b')).toBe('srv-1');
    expect(h.refOf('srv-1')).toBe('b');
    await undo(h, d.api); // the edit made before the delete applies to the re-created section
    expect(recreated.content).toEqual({ headline: { en: 'Story' } });
    await redo(h, d.api);
    await redo(h, d.api); // delete again, by reference
    expect(d.sections.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('undoing an added section deletes it; redo adds it again under a new id', async () => {
    const d = fakeDraft([{ id: 'a', kind: 'hero' }]);
    const h = new DraftHistory();
    await apply(h, d.api, addEntry('add offers', 'new:1', { kind: 'offers', content: {}, isVisible: true }));
    expect(h.idOf('new:1')).toBe('srv-1');
    await undo(h, d.api);
    expect(d.sections.map((s) => s.kind)).toEqual(['hero']);
    await redo(h, d.api);
    expect(h.idOf('new:1')).toBe('srv-2');
    expect(d.sections.map((s) => s.kind)).toEqual(['hero', 'offers']);
  });

  it('records website patches with their previous values', async () => {
    const d = fakeDraft([]);
    const h = new DraftHistory();
    await apply(h, d.api, websiteEntry('design', { template: 'olive' }, { template: 'smash' }));
    expect(d.website().template).toBe('smash');
    await undo(h, d.api);
    expect(d.website().template).toBe('olive');
  });

  it('keeps at most HISTORY_LIMIT entries and clears everything when the draft changed elsewhere', () => {
    const h = new DraftHistory(3);
    for (let i = 0; i < 5; i++) h.push(visibilityEntry(`e${i}`, 'a', i % 2 === 0));
    let count = 0;
    while (h.takeUndo()) count++;
    expect(count).toBe(3);
    expect(HISTORY_LIMIT).toBe(50);
    h.push(visibilityEntry('x', 'a', true));
    h.remap('a', 'srv-9');
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.idOf('a')).toBe('a');
  });

  it('an op the API refuses stops the run (the caller drops the entry)', async () => {
    const d = fakeDraft([{ id: 'a', kind: 'hero' }]);
    const h = new DraftHistory();
    await expect(h.run([{ type: 'section.update', ref: 'gone', isVisible: false }], d.api)).rejects.toThrow('no section gone');
  });

  it('moves an item one step and refuses to move past the ends', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
    const xs = ['a'];
    expect(moved(xs, 0, -1)).toBe(xs);
  });
});

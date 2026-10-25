// Studio undo/redo (21-STUDIO, plan §6.4): a client history stack over draft operations. Every edit the workspace
// makes is recorded as forward and backward operations (each one API call on the draft), so undo replays the backward
// list and redo the forward one. Sections are named by a stable local reference: undoing a delete re-creates the
// section under a new server id, and the reference table maps the old reference to it, so later entries that name the
// section keep working. Pure (no React, no fetch); unit-tested in lib/studio-history.test.ts.
import type { SectionContent, UpdateWebsite } from '@resuto/contracts';

export type DraftOp =
  | { type: 'website.update'; patch: UpdateWebsite }
  | { type: 'section.create'; ref: string; kind: string; content: SectionContent; isVisible: boolean }
  | { type: 'section.update'; ref: string; content?: SectionContent; isVisible?: boolean }
  | { type: 'section.delete'; ref: string }
  | { type: 'sections.reorder'; refs: string[] };

export interface HistoryEntry {
  label: string;
  forward: DraftOp[];
  backward: DraftOp[];
}

/** What the executor needs to run an op against the API (studio.service routes). */
export interface DraftApi {
  updateWebsite(patch: UpdateWebsite): Promise<void>;
  createSection(input: { kind: string; content: SectionContent; isVisible: boolean }): Promise<{ id: string }>;
  updateSection(id: string, patch: { content?: SectionContent; isVisible?: boolean }): Promise<void>;
  deleteSection(id: string): Promise<void>;
  reorderSections(ids: string[]): Promise<void>;
}

export const HISTORY_LIMIT = 50;

export class DraftHistory {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  /** Local reference → current server id (a reference starts as the section's id). */
  private readonly ids = new Map<string, string>();

  constructor(private readonly limit = HISTORY_LIMIT) {}

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  get undoLabel() { return this.past[this.past.length - 1]?.label ?? null; }
  get redoLabel() { return this.future[this.future.length - 1]?.label ?? null; }

  /** The server id a reference points at now. */
  idOf(ref: string): string { return this.ids.get(ref) ?? ref; }
  /** The reference for a server id (the original reference when the section was re-created). */
  refOf(id: string): string {
    for (const [ref, current] of this.ids) if (current === id) return ref;
    return id;
  }
  remap(ref: string, id: string) { if (ref === id) this.ids.delete(ref); else this.ids.set(ref, id); }

  /** Records an edit that has already been made; a new edit clears the redo list. */
  push(entry: HistoryEntry) {
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.future = [];
  }

  /** Takes the entry to undo (the caller runs its backward ops, then calls done/failed). */
  takeUndo(): HistoryEntry | null { return this.past.pop() ?? null; }
  takeRedo(): HistoryEntry | null { return this.future.pop() ?? null; }
  /** After a successful undo the entry can be redone, and the other way round. */
  undone(entry: HistoryEntry) { this.future.push(entry); }
  redone(entry: HistoryEntry) { this.past.push(entry); }

  /** The draft changed outside this history (a published revision restored, a change set applied): start over. */
  clear() { this.past = []; this.future = []; this.ids.clear(); }

  /** Runs ops in order through the API, resolving references (and remapping a re-created section). */
  async run(ops: DraftOp[], api: DraftApi) {
    for (const op of ops) {
      switch (op.type) {
        case 'website.update': await api.updateWebsite(op.patch); break;
        case 'section.create': {
          const created = await api.createSection({ kind: op.kind, content: op.content, isVisible: op.isVisible });
          this.remap(op.ref, created.id);
          break;
        }
        case 'section.update': await api.updateSection(this.idOf(op.ref), { content: op.content, isVisible: op.isVisible }); break;
        case 'section.delete': await api.deleteSection(this.idOf(op.ref)); break;
        case 'sections.reorder': await api.reorderSections(op.refs.map((r) => this.idOf(r))); break;
      }
    }
  }
}

// --- Entry builders (the workspace's edits) ---------------------------------------------------------------------------

interface SectionLike { id: string; kind: string; content: SectionContent; isVisible: boolean }

export function contentEntry(label: string, ref: string, before: SectionContent, after: SectionContent): HistoryEntry {
  return { label, forward: [{ type: 'section.update', ref, content: after }], backward: [{ type: 'section.update', ref, content: before }] };
}

export function visibilityEntry(label: string, ref: string, visible: boolean): HistoryEntry {
  return { label, forward: [{ type: 'section.update', ref, isVisible: visible }], backward: [{ type: 'section.update', ref, isVisible: !visible }] };
}

/** A new section appended at the end (undo deletes it). */
export function addEntry(label: string, ref: string, s: Omit<SectionLike, 'id'>): HistoryEntry {
  return {
    label,
    forward: [{ type: 'section.create', ref, kind: s.kind, content: s.content, isVisible: s.isVisible }],
    backward: [{ type: 'section.delete', ref }],
  };
}

/** A deleted section; undo re-creates it with its content and puts it back in its place. */
export function deleteEntry(label: string, ref: string, s: SectionLike, orderBefore: string[]): HistoryEntry {
  return {
    label,
    forward: [{ type: 'section.delete', ref }],
    backward: [{ type: 'section.create', ref, kind: s.kind, content: s.content, isVisible: s.isVisible }, { type: 'sections.reorder', refs: orderBefore }],
  };
}

export function reorderEntry(label: string, before: string[], after: string[]): HistoryEntry {
  return { label, forward: [{ type: 'sections.reorder', refs: after }], backward: [{ type: 'sections.reorder', refs: before }] };
}

export function websiteEntry(label: string, before: UpdateWebsite, after: UpdateWebsite): HistoryEntry {
  return { label, forward: [{ type: 'website.update', patch: after }], backward: [{ type: 'website.update', patch: before }] };
}

/** Moves the item at `from` one step (−1 or +1); the same array when it cannot move. */
export function moved<T>(xs: T[], from: number, dir: -1 | 1): T[] {
  const to = from + dir;
  if (from < 0 || to < 0 || to >= xs.length) return xs;
  const next = xs.slice();
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

import type { ChangeSetView, PublicSite, SectionContent, StudioAiPlan, WebsiteSeo, WebsiteTemplate, WebsiteTheme } from '@resuto/contracts';
import type { CanvasDevice, CanvasTarget } from '@/lib/studio-canvas';
import type { DraftHistory, HistoryEntry } from '@/lib/studio-history';

export interface WebsiteState {
  website: {
    id: string; template: WebsiteTemplate; theme: WebsiteTheme; seo: WebsiteSeo; status: 'draft' | 'published';
    draftRevision: number; publishedRevision: number; publishedAt: string | null; updatedAt: string; hasUnpublishedChanges: boolean;
  };
  sections: SectionRow[];
  media: Record<string, { url: string; alt: string | null }>;
  publicPath: string;
  /** POST …/website/template only: the sections the template added. */
  addedSectionIds?: string[];
}
export interface SectionRow { id: string; kind: string; sortOrder: number; isVisible: boolean; content: SectionContent }
export interface MediaItem { id: string; url: string; contentType: string; byteSize: number; alt: string | null; altAr: string | null; inUse: boolean; createdAt: string }
export type Tr = (key: string, vars?: Record<string, string | number>) => string;

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';
export type InspectorMode = 'section' | 'site' | 'ai';

/** An AI proposal on the canvas: the change set, how it was read, and the draft as it will look once applied. */
export interface Proposal { changeSet: ChangeSetView; plan: StudioAiPlan | null; after: PublicSite | null }

/** What the workspace panes share (one object, passed down; WebsiteStudio owns the state). */
export interface Studio {
  orgId: string;
  state: WebsiteState;
  preview: PublicSite | null;
  canWrite: boolean;
  canPublish: boolean;
  selected: CanvasTarget | null;
  select: (id: CanvasTarget | null) => void;
  /** Runs an edit (its forward ops) and records it for undo. False when the API refused it (a toast says why). */
  edit: (entry: HistoryEntry) => Promise<boolean>;
  history: DraftHistory;
  /** Reloads the draft after a change made outside the history (template, restore, an applied change set). */
  refresh: (opts?: { clearHistory?: boolean }) => Promise<void>;
  setDirty: (dirty: boolean) => void;
  device: CanvasDevice;
  canvasLocale: 'en' | 'ar';
  proposal: Proposal | null;
  setProposal: (p: Proposal | null) => void;
  compare: 'before' | 'after';
  setCompare: (c: 'before' | 'after') => void;
  publish: () => Promise<void>;
}

import type { SectionContent, WebsiteSeo, WebsiteTemplate, WebsiteTheme } from '@resuto/contracts';

export interface WebsiteState {
  website: {
    id: string; template: WebsiteTemplate; theme: WebsiteTheme; seo: WebsiteSeo; status: 'draft' | 'published';
    draftRevision: number; publishedRevision: number; publishedAt: string | null; updatedAt: string; hasUnpublishedChanges: boolean;
  };
  sections: SectionRow[];
  media: Record<string, { url: string; alt: string | null }>;
  publicPath: string;
}
export interface SectionRow { id: string; kind: string; sortOrder: number; isVisible: boolean; content: SectionContent }
export interface MediaItem { id: string; url: string; contentType: string; byteSize: number; alt: string | null; altAr: string | null; inUse: boolean; createdAt: string }
export type Tr = (key: string, vars?: Record<string, string | number>) => string;

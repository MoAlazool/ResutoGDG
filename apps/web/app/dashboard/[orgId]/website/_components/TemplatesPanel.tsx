'use client';
import { TEMPLATE_FAMILIES, TEMPLATE_VARIANTS, type TemplateFamily, type TemplateVariantKey } from '@resuto/contracts/lite';
import { useToast } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import type { DraftOp } from '@/lib/studio-history';
import type { Studio, WebsiteState } from './types';

/** Colour chips drawn as SVG (the family's own colours, not page styles). */
function Swatch({ f }: { f: TemplateFamily }) {
  const colours = [f.theme.primaryColor, f.theme.accentColor, f.theme.backgroundColor];
  return (
    <svg className="ws-swatch" viewBox="0 0 66 20" width="66" height="20" aria-hidden focusable="false">
      {colours.map((c, i) => <rect key={c} x={i * 22} width="20" height="20" rx="5" fill={c} stroke="currentColor" strokeOpacity=".15" />)}
    </svg>
  );
}

/**
 * Templates: style families × layout variants (packages/contracts/src/studio-templates.ts). "Use style" restyles the
 * draft; "Use style and layout" also adds the layout's sections the draft lacks. Nothing is deleted, and both are
 * undoable from the toolbar.
 */
export function TemplatesPanel({ studio }: { studio: Studio }) {
  const { t } = useT();
  const session = useSession();
  const toast = useToast();
  const current = studio.state.website;
  const apply = async (f: TemplateFamily, variant: TemplateVariantKey, addSections: boolean) => {
    const before = { template: current.template, theme: current.theme };
    try {
      const res = await session.call<WebsiteState>(`/o/${studio.orgId}/studio/website/template`, { body: { family: f.key, variant, applyStyle: true, addSections } });
      const added = (res.addedSectionIds ?? []).map((id) => res.sections.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
      const forward: DraftOp[] = [{ type: 'website.update', patch: { template: res.website.template, theme: res.website.theme } },
        ...added.map((s): DraftOp => ({ type: 'section.create', ref: s.id, kind: s.kind, content: s.content, isVisible: s.isVisible }))];
      const backward: DraftOp[] = [...added.map((s): DraftOp => ({ type: 'section.delete', ref: s.id })), { type: 'website.update', patch: before }];
      studio.history.push({ label: t('studio.ws.h.template', { name: t(`studio.family.${f.key}`) }), forward, backward });
      await studio.refresh();
      toast.show({ message: t('studio.templates.applied', { name: t(`studio.family.${f.key}`), n: added.length }), tone: 'ok' });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    }
  };
  return (
    <div className="stack gap-12">
      <p className="fine m-0">{t('studio.templates.hint')}</p>
      <ul className="ws-templates">
        {TEMPLATE_FAMILIES.map((f) => (
          <li key={f.key} className="ws-template" data-current={current.template === f.renderer && current.theme.primaryColor === f.theme.primaryColor || undefined}>
            <div className="spread"><strong>{t(`studio.family.${f.key}`)}</strong><Swatch f={f} /></div>
            <small>{t(`studio.family.${f.key}.body`)}</small>
            {studio.canWrite && (
              <div className="stack gap-6">
                {TEMPLATE_VARIANTS.map((v) => (
                  <div key={v} className="ws-template-variant">
                    <span className="fine">{t(`studio.variant.${v}`)}: {f.variants[v].map((k) => t(`studio.kind.${k}`)).join(' · ')}</span>
                    <span className="row gap-4">
                      {v === 'full' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => void apply(f, v, false)}
                        aria-label={t('studio.templates.useStyleOf', { name: t(`studio.family.${f.key}`) })}>{t('studio.templates.useStyle')}</button>}
                      <button type="button" className="btn btn-sm" onClick={() => void apply(f, v, true)}
                        aria-label={t('studio.templates.useLayoutOf', { name: t(`studio.family.${f.key}`), variant: t(`studio.variant.${v}`) })}>{t('studio.templates.useLayout')}</button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

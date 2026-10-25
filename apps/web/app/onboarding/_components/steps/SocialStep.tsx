'use client';
// Step 7: social links (PUT /o/:orgId/social-links replaces the set). Each link is checked as it is typed with the
// same rules as the API (https, the network's own hosts), so the owner sees a problem before saving.
import { useState } from 'react';
import { checkSocialLink, SOCIAL_NETWORKS, type SocialLinks, type SocialNetwork } from '@resuto/contracts/lite';
import { SOCIAL_ICON_SRC } from '@/components/guest/SocialIcons';
import { useT } from '@/lib/i18n/client';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';

const PLACEHOLDER: Record<SocialNetwork, string> = {
  instagram: 'https://instagram.com/…', facebook: 'https://facebook.com/…', tiktok: 'https://tiktok.com/@…', x: 'https://x.com/…',
  snapchat: 'https://snapchat.com/add/…', whatsapp: 'https://wa.me/20…', google_maps: 'https://maps.app.goo.gl/…', website: 'https://…',
};

export function SocialStep() {
  const { t } = useT();
  const w = useWizard();
  const { call } = w;
  const org = w.org!;
  const [links, setLinks] = useState<Record<string, string>>(() => ({ ...(org.socialLinks ?? {}) }));
  const [error, setError] = useState<string | null>(null);
  const problem = (n: SocialNetwork) => {
    const v = links[n]?.trim();
    return v && !checkSocialLink(n, v).ok;
  };
  const bad = SOCIAL_NETWORKS.filter(problem);

  const submit = async () => {
    if (bad.length) return;
    setError(null);
    try {
      const body = Object.fromEntries(SOCIAL_NETWORKS.map((n) => [n, links[n]?.trim() || null]));
      const r = await call<{ socialLinks: SocialLinks }>(`/o/${org.id}/social-links`, { method: 'PUT', body });
      w.setOrg({ ...org, socialLinks: r.socialLinks });
      await w.finish();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <StepFrame title={t('onb.social.title')} body={t('onb.social.body')} onSubmit={submit} primaryDisabled={bad.length > 0} error={error}>
      <div className="onb-social">
        {SOCIAL_NETWORKS.map((n) => {
          const label = t(`core.guest.social.${n}`);
          return (
            <label key={n} className="onb-social-row">
              <img src={SOCIAL_ICON_SRC[n]} alt="" width={24} height={24} />
              <span className="onb-social-name">{label}</span>
              <input className="input" type="url" inputMode="url" dir="ltr" autoCapitalize="none" spellCheck={false} placeholder={PLACEHOLDER[n]}
                value={links[n] ?? ''} aria-invalid={problem(n) || undefined} onChange={(e) => setLinks({ ...links, [n]: e.target.value })} />
              {problem(n) && <small className="onb-error">{t('onb.social.invalid', { network: label })}</small>}
            </label>
          );
        })}
      </div>
    </StepFrame>
  );
}

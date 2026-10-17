'use client';
import { PageHeader } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

// Placeholder overview; Agent B replaces it with the analytics overview.
export default function OverviewPage() {
  const { t } = useT();
  const { org } = useOrg();
  return <PageHeader title={t('nav.overview')} subtitle={org.name} />;
}

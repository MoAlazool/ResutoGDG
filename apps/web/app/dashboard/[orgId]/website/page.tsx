'use client';
import { ToastProvider } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { WebsiteStudio } from './_components/WebsiteStudio';

export default function WebsitePage() {
  const { t } = useT();
  return (
    <ModuleGate module="studio" permission="studio:read">
      <ToastProvider closeLabel={t('action.close')}>
        <Inner />
      </ToastProvider>
    </ModuleGate>
  );
}

function Inner() {
  const { org, can } = useOrg();
  return <WebsiteStudio orgId={org.id} can={can} />;
}

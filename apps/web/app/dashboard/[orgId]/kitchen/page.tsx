'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Skeleton } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { kitchenDisplayPath } from '@/lib/home-path';
import { useOrg } from '@/lib/org-context';

/**
 * Kitchen (21-OPS: one route). The dashboard's Kitchen link and `g k` open the full-screen kitchen display at
 * /kitchen/[orgId]; this route only forwards there (replacing the history entry), so there is one implementation.
 */
export default function KitchenPage() {
  return <ModuleGate module="core" permission="kitchen:operate"><ToKitchenDisplay /></ModuleGate>;
}

function ToKitchenDisplay() {
  const { org } = useOrg();
  const router = useRouter();
  useEffect(() => { router.replace(kitchenDisplayPath(org.role, org.id)); }, [router, org.role, org.id]);
  return <Skeleton lines={6} />;
}

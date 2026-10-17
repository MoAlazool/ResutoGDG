'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, Notice, SelectField } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

const toSlug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** Scenario 1, step 1: signup → restaurant → first branch. */
export default function OnboardingPage() {
  const { t, locale } = useT();
  const session = useSession();
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (session.ready && !session.token) router.replace('/signup');
  }, [session.ready, session.token, router]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const org = await session.call<{ id: string }>('/orgs', {
        body: {
          name, slug, nameAr: f.get('nameAr') || null, country: f.get('country'), planId: f.get('planId'),
          defaultLocale: locale,
          branch: { name: f.get('branchName'), city: f.get('city') || null },
        },
      });
      await session.refreshMe();
      router.push(`/dashboard/${org.id}/menu?welcome=1`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  const ar = locale === 'ar';
  return (
    <main className="center-page">
      <form className="auth-card rise" onSubmit={submit} style={{ width: 'min(560px, 100%)' }}>
        <div className="spread"><span className="overline">{ar ? 'الخطوة 1 من 3' : 'Step 1 of 3'}</span><LanguageToggle /></div>
        <h1 style={{ fontSize: 26 }}>{ar ? 'أنشئ مطعمك' : 'Create your restaurant'}</h1>
        <Field label={ar ? 'اسم المطعم' : 'Restaurant name'} value={name} required maxLength={120}
          onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(toSlug(e.target.value)); }} />
        <Field label={ar ? 'الاسم بالعربية (اختياري)' : 'Arabic name (optional)'} name="nameAr" dir="rtl" maxLength={120} />
        <Field label={ar ? 'رابط موقعك' : 'Your Resuto web address'} value={slug} required pattern="[a-z0-9][a-z0-9-]{1,46}[a-z0-9]"
          hint={`resuto.app/r/${slug || '…'}`} onChange={(e) => { setSlug(toSlug(e.target.value)); setSlugEdited(true); }} />
        <div className="form-row">
          <SelectField label={ar ? 'الدولة' : 'Country'} name="country" defaultValue="EG">
            <option value="EG">{ar ? 'مصر (جنيه مصري)' : 'Egypt (EGP)'}</option>
            <option value="SA">{ar ? 'السعودية (ريال)' : 'Saudi Arabia (SAR)'}</option>
          </SelectField>
          <SelectField label={ar ? 'الخطة' : 'Plan'} name="planId" defaultValue="growth" hint={ar ? 'تجربة مجانية 14 يومًا للخطط المدفوعة' : '14-day trial on paid plans'}>
            <option value="free">Free QR</option>
            <option value="starter">Starter</option>
            <option value="growth">Growth</option>
            <option value="pro">Pro</option>
          </SelectField>
        </div>
        <div className="form-row">
          <Field label={ar ? 'اسم الفرع الأول' : 'First branch name'} name="branchName" required defaultValue={ar ? 'الفرع الرئيسي' : 'Main branch'} />
          <Field label={ar ? 'المدينة' : 'City'} name="city" />
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <button className="btn btn-primary btn-block" disabled={pending} style={{ marginBlockStart: 10 }}>{pending ? t('state.loading') : t('action.continue')}</button>
      </form>
    </main>
  );
}

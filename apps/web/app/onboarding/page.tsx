import { Wizard } from './_components/Wizard';

export const metadata = { title: 'Set up your menu', robots: { index: false } };

/** The Free QR-menu onboarding wizard (21-ONB, plan §6.2): signup → published menu → printed menu QR. */
export default function OnboardingPage() {
  return <Wizard />;
}

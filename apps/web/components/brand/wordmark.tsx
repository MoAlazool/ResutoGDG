import Link from 'next/link';

/**
 * The Resuto wordmark on guest pages (reservations): the Latin "r resuto." in English and the Arabic logo
 * "ريسوتو" on Arabic pages, as legacy's experience header did (legacy/public/experience-ui.js, gallery PAR-06).
 * The platform's own logo, shared with the landing page; not a restaurant cover photo (those always come from the
 * tenant, components/guest/guest.test.ts).
 */
export function GuestWordmark({ locale }: { locale: 'en' | 'ar' }) {
  return locale === 'ar'
    ? <Link className="gx-wordmark is-ar" href="/" aria-label="ريسوتو"><img src="/brand/resuto-arabic-logo.webp" alt="ريسوتو" width={103} height={32} /></Link>
    : <Link className="gx-wordmark" href="/"><i aria-hidden>r</i><span>resuto<b>.</b></span></Link>;
}

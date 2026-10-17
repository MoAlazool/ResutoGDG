import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Tracking link: the API counts the click (attribution_events link_click) and
 * returns a RELATIVE destination with utm_* plus rcid (campaign) and rsid (click
 * session). Ordering pages forward those parameters as the order's attribution.
 * Only same-site paths are ever redirected to.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const home = new URL('/', req.url);
  if (!/^[A-Za-z0-9_-]{6,32}$/.test(code)) return NextResponse.redirect(home, 302);
  try {
    const res = await fetch(`${API_URL}/v1/public/l/${encodeURIComponent(code)}`, {
      cache: 'no-store',
      headers: { 'X-Forwarded-For': req.headers.get('x-forwarded-for') ?? '', Accept: 'application/json' },
    });
    if (!res.ok) return NextResponse.redirect(home, 302);
    const { destination } = (await res.json()) as { destination?: string };
    if (!destination || !destination.startsWith('/') || destination.startsWith('//')) return NextResponse.redirect(home, 302);
    return NextResponse.redirect(new URL(destination, req.url), 302);
  } catch {
    return NextResponse.redirect(home, 302);
  }
}

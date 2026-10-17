import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { SERVER_API_URL } from '../_components/load-site';

/**
 * Drops the cached published site right after a publish so guests see the new
 * revision immediately (otherwise it refreshes within 30 s). Only a signed-in
 * member of the restaurant that owns the slug may trigger it: the bearer token
 * is checked against the Studio API.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const authz = req.headers.get('authorization');
  const body = (await req.json().catch(() => ({}))) as { orgId?: unknown };
  if (!authz?.startsWith('Bearer ') || typeof body.orgId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.orgId)) {
    return NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in to continue' } }, { status: 401 });
  }
  const res = await fetch(`${SERVER_API_URL}/v1/o/${body.orgId}/studio/website`, { headers: { authorization: authz }, cache: 'no-store' });
  if (!res.ok) return NextResponse.json({ error: { code: 'forbidden', message: 'Not allowed' } }, { status: 403 });
  const site = (await res.json()) as { publicPath?: string };
  if (site.publicPath !== `/r/${slug}`) return NextResponse.json({ error: { code: 'forbidden', message: 'Not allowed' } }, { status: 403 });
  revalidateTag(`site:${slug}`);
  return NextResponse.json({ revalidated: true });
}

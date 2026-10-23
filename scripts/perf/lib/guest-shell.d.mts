// Types for guest-shell.mjs (imported by the web unit tests).
export interface GuestShellReport {
  bytes: number;
  h1: number | null;
  dish: number | null;
  firstHiddenSegment: number | null;
  firstFallback: number | null;
  loading: number | null;
  ok: boolean;
  problems: string[];
}
export function inspectGuestShell(html: string): GuestShellReport;

// Old or guessable dashboard URLs that open a navigation item's route (22-TYPE). Dependency-free: next.config.ts
// imports it. Temporary redirects, so the targets can move again without browsers caching the hop.

/**
 * The website builder is called "Website studio" in the navigation and lives at /website; /studio (the name staff use
 * for it) opens it too, keeping the query (?tab=domains …). The floor plan editor stays /floor?tab=studio.
 */
export function navRedirects() {
  return [
    { source: '/dashboard/:orgId/studio', destination: '/dashboard/:orgId/website', permanent: false },
  ];
}

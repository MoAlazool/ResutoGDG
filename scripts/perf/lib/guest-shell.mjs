// HTML check behind scripts/perf/guest-shell.mjs (PERF-01), shared with the web unit tests.

/** Where the first heading and dish card are, and what streamed structure precedes them. */
export function inspectGuestShell(html) {
  const at = (re) => { const i = html.search(re); return i < 0 ? null : i; };
  const h1 = at(/<h1[\s>]/);
  const dish = at(/class="gx-dish-name"/);   // a real dish card (the loading skeleton has gx-dish boxes, never a name)
  const firstHiddenSegment = at(/<div hidden id="S:/);
  // A Suspense boundary still pending in the shell paints its fallback (`<template id="B:n">` then the fallback). An
  // empty one (`…</template><!--/$-->`) paints nothing: Next streams the page metadata that way, inside a hidden div.
  const firstFallback = at(/<template id="B:[^"]*"><\/template>(?!<!--\/\$-->)/);
  const loading = at(/class="[^"]*\bgx-loading\b/);
  const before = (x, y) => x !== null && (y === null || x < y);
  const problems = [];
  if (h1 === null) problems.push('no <h1> in the HTML');
  if (dish === null) problems.push('no dish card in the HTML');
  for (const [name, pos] of [['<h1>', h1], ['dish card', dish]]) {
    if (pos === null) continue;
    if (before(firstHiddenSegment, pos)) problems.push(`${name} streams in a hidden segment (revealed by script after a fallback)`);
    if (before(firstFallback, pos)) problems.push(`a Suspense fallback is emitted before the ${name}`);
    if (before(loading, pos)) problems.push(`the loading shell is painted before the ${name}`);
  }
  return { bytes: html.length, h1, dish, firstHiddenSegment, firstFallback, loading, ok: problems.length === 0, problems };
}

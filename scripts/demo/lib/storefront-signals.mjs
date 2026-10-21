// What the legacy Smash & Co storefront (legacy/public/burger.js) told guests and the 2.0 demo lacked (gallery PAR-02):
// "Open now · 11:00 AM – 12:00 AM", "Pickup ≈ 12 min" and "Delivery · Downtown". In 2.0 these come from data: the
// branch's opening hours (FT-09, branch time zone), the dishes' preparation times (the storefront shows their median)
// and the branch district (English and Arabic). Pure: the loader writes them through the API.

/** Branch fields for the burger branch: every day 11:00 to midnight, Cairo time, in Downtown. */
export const SMASH_BRANCH = {
  district: 'Downtown',
  districtAr: 'وسط البلد',
  timezone: 'Africa/Cairo',
  openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, opens: '11:00', closes: '00:00' })),
};

/** Kitchen preparation minutes per legacy dish id (cold drinks publish none). Median 12, legacy's "≈ 12 min". */
export const SMASH_PREP_MINUTES = { b0: 12, b1: 14, b2: 13, b3: 12, b4: 10, b5: 8, b6: 9, b7: 5 };

/** The branch PATCH body that fills only what is missing (an operator's own hours or district are kept). */
export function smashBranchPatch(current) {
  const patch = {};
  if (!current?.district) patch.district = SMASH_BRANCH.district;
  if (!current?.districtAr) patch.districtAr = SMASH_BRANCH.districtAr;
  if (!current?.timezone) patch.timezone = SMASH_BRANCH.timezone;
  if (!Array.isArray(current?.openingHours) || !current.openingHours.length) patch.openingHours = SMASH_BRANCH.openingHours;
  return patch;
}

/** Median of the published preparation times, as the storefront computes its pickup estimate. */
export const medianPrep = (mins) => {
  const xs = mins.filter((n) => typeof n === 'number' && n > 0).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : null;
};

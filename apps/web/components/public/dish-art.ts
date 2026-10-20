// What to show for a dish that has no photo (audits VP-04, DF-08). Never the menu-photography contact sheet: that is
// eight Olive Room dishes on one image, and as a background it puts someone else's food on every card.
//
// Fast-food items get the flat illustrations of the original Smash & Co storefront (legacy/public/burger-art.js,
// now static files in /art/dishes); everything else gets a neutral placeholder (legacy `.dish-placeholder`).
// Matching uses the English names, which are always present; Arabic text is display only.

export type DishArtKind = 'burger' | 'burger-double' | 'burger-chicken' | 'burger-veggie' | 'fries' | 'fries-loaded' | 'rings' | 'shake' | 'drink';

/** Category first, then the specific dish, so a new menu row still gets a mark (legacy dishArt rules). */
export function dishArtKind(name: string | null | undefined, category: string | null | undefined): DishArtKind | null {
  const n = (name ?? '').toLowerCase();
  const c = (category ?? '').toLowerCase();
  const burgerish = c.includes('burger') || /\b(burger|smash)\b/.test(n);
  if (burgerish) {
    if (n.includes('double')) return 'burger-double';
    if (n.includes('chicken')) return 'burger-chicken';
    if (n.includes('veggie') || n.includes('vegetarian')) return 'burger-veggie';
    return 'burger';
  }
  if (n.includes('loaded') && n.includes('fries')) return 'fries-loaded';
  if (n.includes('ring')) return 'rings';
  if (n.includes('fries') || (c.includes('side') && /\b(fries|chips|potato)/.test(n))) return 'fries';
  if (c.includes('shake') || n.includes('shake')) return 'shake';
  if (/\b(cola|soda|pepsi|sprite|fanta)\b/.test(n)) return 'drink';
  return null;
}

export const dishArtUrl = (kind: DishArtKind) => `/art/dishes/${kind}.svg`;

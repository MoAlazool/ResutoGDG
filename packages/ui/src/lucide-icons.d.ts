// Per-icon ESM entries of lucide-react (dist/esm/icons/<name>.mjs). The package publishes types only for its root
// entry; importing an icon from its own module keeps the bundle to that icon (plus lucide's ~1.6 kB gzip runtime)
// in development builds too, where the root barrel would pull in every icon.
declare module 'lucide-react/dist/esm/icons/*.mjs' {
  import type { LucideIcon } from 'lucide-react';
  const icon: LucideIcon;
  export default icon;
}

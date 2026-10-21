// Placeholder replaced by the FT-04 enhancement helpers below (kept small so FT-08 compiles on its own).
let sharpModule: any | null | undefined;
export function loadSharp(): any | null {
  if (sharpModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sharpModule = require('sharp');
      sharpModule.cache(false);
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

export const sharpAvailable = () => !!loadSharp();

// UI strings for the studio module. Keys must be prefixed "studio." and exist in both languages.
// Floor Studio strings live next to the floor components; website/Studio strings are below.
import { studioFloorAr, studioFloorEn } from '../../../components/floor/strings';

const siteEn: Record<string, string> = {};
const siteAr: Record<string, string> = {};

export const studio = {
  en: { ...studioFloorEn, ...siteEn } as Record<string, string>,
  ar: { ...studioFloorAr, ...siteAr } as Record<string, string>,
};

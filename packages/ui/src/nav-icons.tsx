/// <reference path="./lucide-icons.d.ts" />
import Activity from 'lucide-react/dist/esm/icons/activity.mjs';
import Armchair from 'lucide-react/dist/esm/icons/armchair.mjs';
import ArrowDownUp from 'lucide-react/dist/esm/icons/arrow-down-up.mjs';
import Bike from 'lucide-react/dist/esm/icons/bike.mjs';
import Blocks from 'lucide-react/dist/esm/icons/blocks.mjs';
import BookOpen from 'lucide-react/dist/esm/icons/book-open.mjs';
import BuildingComplex from 'lucide-react/dist/esm/icons/building-complex.mjs';
import Cable from 'lucide-react/dist/esm/icons/cable.mjs';
import CalendarClock from 'lucide-react/dist/esm/icons/calendar-clock.mjs';
import ChartLine from 'lucide-react/dist/esm/icons/chart-line.mjs';
import ChefHat from 'lucide-react/dist/esm/icons/chef-hat.mjs';
import ConciergeBell from 'lucide-react/dist/esm/icons/concierge-bell.mjs';
import CreditCard from 'lucide-react/dist/esm/icons/credit-card.mjs';
import ExternalLink from 'lucide-react/dist/esm/icons/external-link.mjs';
import Globe from 'lucide-react/dist/esm/icons/globe.mjs';
import Landmark from 'lucide-react/dist/esm/icons/landmark.mjs';
import LayoutDashboard from 'lucide-react/dist/esm/icons/layout-dashboard.mjs';
import ListChecks from 'lucide-react/dist/esm/icons/list-checks.mjs';
import Lock from 'lucide-react/dist/esm/icons/lock.mjs';
import Megaphone from 'lucide-react/dist/esm/icons/megaphone.mjs';
import MessagesSquare from 'lucide-react/dist/esm/icons/messages-square.mjs';
import Package from 'lucide-react/dist/esm/icons/package.mjs';
import ReceiptText from 'lucide-react/dist/esm/icons/receipt-text.mjs';
import Scale from 'lucide-react/dist/esm/icons/scale.mjs';
import ScrollText from 'lucide-react/dist/esm/icons/scroll-text.mjs';
import Settings from 'lucide-react/dist/esm/icons/settings.mjs';
import Shield from 'lucide-react/dist/esm/icons/shield.mjs';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles.mjs';
import Store from 'lucide-react/dist/esm/icons/store.mjs';
import Tags from 'lucide-react/dist/esm/icons/tags.mjs';
import UserCheck from 'lucide-react/dist/esm/icons/user-check.mjs';
import UserCog from 'lucide-react/dist/esm/icons/user-cog.mjs';
import Users from 'lucide-react/dist/esm/icons/users.mjs';
import Wallet from 'lucide-react/dist/esm/icons/wallet.mjs';
import { Icon, type LucideIcon } from './icon';
import type { NavGlyphName } from './shell';

/**
 * Curated Lucide icons for the navigation and module names that NAV_GLYPHS (shell.tsx) covers with Unicode glyphs
 * today. One distinct icon per module (the glyph set reused ◉ for visits, payments and operations). The shell keeps
 * its glyphs until 21-SHELL switches it over; this map costs about 5.7 kB gzip (35 icons + Lucide's runtime), so the
 * switch should land with the shell's own savings. Import single icons directly where only a few are needed.
 */
export const NAV_ICONS: Record<NavGlyphName, LucideIcon> = {
  overview: LayoutDashboard, frontdesk: ConciergeBell, orders: ReceiptText, kitchen: ChefHat, floor: Armchair,
  reservations: CalendarClock, visits: UserCheck, menu: BookOpen, inventory: Package, delivery: Bike, customers: Users,
  inbox: MessagesSquare, marketing: Megaphone, website: Globe, payments: CreditCard, finance: Landmark, compliance: Scale,
  analytics: ChartLine, intelligence: Sparkles, mcp: Cable, settings: Settings, team: UserCog, integrations: Blocks,
  billing: Wallet, audit: ScrollText, branches: Store, data: ArrowDownUp, setup: ListChecks, guest: ExternalLink,
  admin: Shield, tenants: BuildingComplex, prices: Tags, operations: Activity, lock: Lock,
};

/** Navigation icon by module name (decorative: the item's text is its label). */
export function NavIcon({ name, size = 18 }: { name: NavGlyphName; size?: number }) {
  return <Icon icon={NAV_ICONS[name]} size={size} className="ws-glyph-icon" />;
}

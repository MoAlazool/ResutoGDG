// Labels for the two largest code lists of the operator vocabulary (lib/vocab.ts): activity-log actions and integration
// capabilities. Separate from lib/vocab.ts so only the screens that show them (activity log, change sets, integrations)
// carry their copy in the page's messages (lib/i18n/route-families.ts, 21-PERF).
import { humanise, lookup, type Translate } from './vocab';

/** Activity-log action ("order.status_changed" -> "Order status changed"), or null when it has no label yet. */
export const actionLabel = (t: Translate, action: string) => lookup(t, `vocab.action.${action}`);

/** Integration capability ("transaction_listing" -> "Transaction listing" / "قائمة المعاملات"); REM-W06. */
export const capabilityLabel = (t: Translate, code: string) =>
  lookup(t, `vocab.capability.${code}`) ?? lookup(t, `intg.capability.${code}`) ?? humanise(code);

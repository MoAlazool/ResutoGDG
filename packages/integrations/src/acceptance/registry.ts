// Registers every provider's acceptance checks (one module per provider). Loaded by scripts/providers/acceptance.mjs;
// never imported by application code, so registering is a no-op for the API and the tests.
import './stripe';
import './paymob';
import './moyasar';
import './meta';

export { ACCEPTANCE_CHECKS } from './index';

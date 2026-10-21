// Registers every provider's acceptance checks (one module per provider). Loaded by scripts/providers/acceptance.mjs;
// never imported by application code, so registering is a no-op for the API and the tests.
import './stripe';
import './paymob';
import './moyasar';
import './meta';
// ws7b (wave 4): custom domains, tracking sinks, POS, accounting, tax, notifications, push, maps, LLM.
import './domains';
import './gemini';
import './maps';

export { ACCEPTANCE_CHECKS } from './index';

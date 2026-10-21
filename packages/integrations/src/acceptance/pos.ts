// Foodics acceptance check (INT-24): against the Foodics SANDBOX (api-sandbox.foodics.com) with a token obtained through
// "Connect with Foodics" on a sandbox app (or Postman's OAuth flow, as Foodics documents). Read-only: whoami and the
// first page of products. The OAuth redirect itself needs a browser and a sandbox console login, so it is part of the
// manual procedure in docs/INTEGRATION_READINESS.md, not of this script.
import { foodicsAdapter } from '../pos/foodics';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';

export const posChecks: AcceptanceCheck[] = [
  {
    id: 'foodics.whoami_menu_page', provider: 'foodics', capability: 'menu_import', modes: ['official_test'],
    requires: ['FOODICS_SANDBOX_TOKEN'], effect: 'read',
    prerequisites: ['A Foodics sandbox account and developer app (support@foodics.com). Create a token with "Connect with Foodics" on a sandbox connection or Postman, with the general.read scope.'],
    docsUrl: 'https://developers.foodics.com/guides/get-started.html',
    async run(ctx) {
      const actx = { environment: 'sandbox' as const, credentials: { accessToken: ctx.env.FOODICS_SANDBOX_TOKEN! }, config: {}, fetch: ctx.adapter.fetch };
      const health = await foodicsAdapter.healthCheck(actx);
      ctx.evidence('whoami', { ok: health.ok, business: health.details.business ?? null });
      expectThat(health.ok, 'whoami did not return a business');
      const page = await foodicsAdapter.fetchMenuPage(actx, { cursor: null, currency: 'SAR' });
      ctx.evidence('products page 1', { rows: page.rows.length, warnings: page.warnings.length, hasNext: page.nextCursor !== null });
      expectThat(page.rows.every((r) => r.available === false), 'imported rows must start unavailable');
    },
  },
];

registerChecks(...posChecks);

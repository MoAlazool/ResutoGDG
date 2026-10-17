// Shared fixtures for Agent B2 tests (inventory, customers, analytics).
import { TenantContext } from '../src/common/auth/context';
import { DbService } from '../src/common/db/db.service';
import { OrdersKernelService, type PlaceOrderInput } from '../src/modules/kernel/orders-kernel.service';
import { auth, type TestApp, type TestTenant } from './helpers';

export const ownerCtx = (tenant: TestTenant) =>
  new TenantContext(tenant.orgId, 'owner', null, tenant.owner.userId, 'user', tenant.owner.userId);

/** Places an order through the shared kernel (the only order writer) as the tenant owner. */
export function placeOrder(t: TestApp, tenant: TestTenant, input: Omit<PlaceOrderInput, 'branchId'> & { branchId?: string }) {
  const db = t.app.get(DbService);
  const orders = t.app.get(OrdersKernelService);
  const ctx = ownerCtx(tenant);
  return db.scoped(ctx, (tx) => orders.place(tx, ctx, { branchId: tenant.branchId, ...input }));
}

export async function addBranch(t: TestApp, tenant: TestTenant, name: string): Promise<string> {
  const res = await t.http.post(`/v1/o/${tenant.orgId}/branches`).set(auth(tenant.owner)).send({ name });
  if (res.status !== 201) throw new Error(`branch failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

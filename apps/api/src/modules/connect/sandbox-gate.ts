import type { Env } from '../../config/env';
import { DomainError } from '../../common/errors/domain-error';

/**
 * Sandbox channels and the inbound simulator exist for development, tests, demos and staging (audit PS-27). The
 * simulator injects "customer" messages that the ordering bot turns into real orders, so production refuses both
 * (CONNECT_SANDBOX defaults to off there and cannot be switched on). Existing sandbox channels keep their history.
 */
export function assertConnectSandbox(env: Pick<Env, 'CONNECT_SANDBOX'>) {
  if (!env.CONNECT_SANDBOX) {
    throw new DomainError('sandbox_disabled', 'WhatsApp sandbox channels are not available here; connect a WhatsApp Business number instead', 403);
  }
}

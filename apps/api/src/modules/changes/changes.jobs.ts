import { Injectable, Logger } from '@nestjs/common';
import { Scheduled } from '../../common/events/events';
import { ChangesService } from './changes.service';

@Injectable()
export class ChangesJobs {
  private readonly logger = new Logger('ChangesJobs');
  constructor(private readonly changes: ChangesService) {}

  /** The outbox of external effects: due attempts (first tries a request did not finish, retries after backoff). */
  @Scheduled('changes.effects', 15, { timeoutMs: 120_000 })
  async effects() {
    const r = await this.changes.runDueEffects();
    const resumed = await this.changes.resumeStuck();
    if (r.attempted || resumed) this.logger.log(`effects attempted ${r.attempted}, succeeded ${r.succeeded}; resumed ${resumed} change set(s)`);
    return { ...r, resumed };
  }

  /** Pending change sets nobody decided on in time. */
  @Scheduled('changes.expire', 60)
  async expire() {
    const n = await this.changes.expireAll();
    if (n) this.logger.log(`expired ${n} change set(s)`);
    return { expired: n };
  }
}

import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { EventDispatcher } from './common/events/dispatcher.service';

/**
 * Publishes outbox events to handlers and runs scheduled jobs until `stopping()`
 * returns true. Used by the worker entrypoint and, with RUN_WORKER_IN_PROCESS,
 * inside the API process. Event claims and handler runs are leases and jobs
 * are claimed through job_leases with a shared cadence, so several loops
 * (worker + in-process worker, overlapping deploys, replicas) can run side by
 * side without running a handler or a job twice at once.
 */
export async function runWorkerLoop(app: INestApplicationContext, stopping: () => boolean, label = 'Worker'): Promise<void> {
  const dispatcher = app.get(EventDispatcher);
  const logger = new Logger(label);
  logger.log(`handlers: ${dispatcher.registered.handlers.map((h) => h.name).join(', ') || 'none'}; jobs: ${dispatcher.registered.jobs.join(', ') || 'none'}`);
  while (!stopping()) {
    try {
      const n = await dispatcher.tick();
      await dispatcher.runDueJobs();
      if (n === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      logger.error(error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

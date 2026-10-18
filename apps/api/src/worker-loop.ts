import { Logger } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { EventDispatcher } from './common/events/dispatcher.service';

/**
 * Publishes outbox events to handlers and runs scheduled jobs until `stopping()`
 * returns true. Used by the worker entrypoint and, with RUN_WORKER_IN_PROCESS,
 * inside the API process. Claims use SKIP LOCKED and jobs use advisory locks,
 * so several loops can run side by side.
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

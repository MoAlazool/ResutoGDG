import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { EventDispatcher } from './common/events/dispatcher.service';

/**
 * Worker entrypoint: same modular monolith, no HTTP. Publishes outbox events
 * to handlers and runs scheduled jobs. Scale horizontally; claims use
 * SKIP LOCKED and jobs use advisory locks.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  const dispatcher = app.get(EventDispatcher);
  const logger = new Logger('Worker');
  logger.log(`handlers: ${dispatcher.registered.handlers.map((h) => h.name).join(', ') || 'none'}; jobs: ${dispatcher.registered.jobs.join(', ') || 'none'}`);
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  while (!stopping) {
    try {
      const n = await dispatcher.tick();
      await dispatcher.runDueJobs();
      if (n === 0) await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      logger.error(error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { runWorkerLoop } from './worker-loop';

/**
 * Worker entrypoint: same modular monolith, no HTTP. Publishes outbox events
 * to handlers and runs scheduled jobs. Scale horizontally: event claims and
 * handler runs are leased (outbox_events.claim_token, event_handlings
 * 'running'), and jobs are claimed through job_leases, which holds no session
 * state and so also works through a transaction pooler.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  await runWorkerLoop(app, () => stopping);
  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });

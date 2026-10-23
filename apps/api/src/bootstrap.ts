import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { compressionMiddleware } from './common/http/compression';
import { hardeningMiddleware, trustProxySetting } from './common/http/http-hardening';
import { installOutboundRequestId } from './common/http/request-context';
import { buildHeaderMiddleware, buildInfo } from './common/observability/build-info';
import { errorReporter, installCrashReporting } from './common/observability/error-tracking';
import { loadEnv } from './config/env';
import { runWorkerLoop } from './worker-loop';

export async function createApp(): Promise<INestApplication> {
  const env = loadEnv();
  installOutboundRequestId();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: env.NODE_ENV === 'test' ? ['error'] : undefined });
  app.setGlobalPrefix('v1');
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false, maxAge: 600,
    // ETag: the web app (another origin) revalidates its polls with If-None-Match (PCL-24 / REM-W02); a browser hides
    // the validator from script unless it is exposed here. If-None-Match and Cache-Control in the request need no entry:
    // with no allowedHeaders, cors reflects the preflight's Access-Control-Request-Headers.
    exposedHeaders: ['X-Request-Id', 'X-Build', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'X-Resuto-List', 'ETag'],
  });
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', trustProxySetting(env));
  // Request id + context, security and cache headers, access log (see http-hardening.ts).
  app.use(hardeningMiddleware(env));
  // Deployed commit on every response (CR-07): X-Build: api@<short sha>.
  app.use(buildHeaderMiddleware());
  // Brotli/gzip for JSON/CSV bodies >= 1 kB (PCL-24); conditional GET (ETag / If-None-Match) is Express's default.
  app.use(compressionMiddleware());
  // With the in-process worker, main() owns SIGTERM/SIGINT so the loop stops before the pool closes.
  if (!env.RUN_WORKER_IN_PROCESS) app.enableShutdownHooks();
  return app;
}

/** How long a signal waits for the in-process worker's current tick before the app closes anyway. */
const WORKER_DRAIN_MS = 15_000;

export async function main() {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT, '0.0.0.0');
  const build = buildInfo();
  new Logger('Resuto').log(`API listening on :${env.PORT} (${env.NODE_ENV}; payments ${env.PAYMENT_MODE}, storage ${env.STORAGE_DRIVER}; `
    + `build ${build.shortCommit ?? 'local'} built ${build.builtAt ?? 'unknown'}; error tracking ${errorReporter().enabled ? 'on' : 'off'})`);
  // A crash is logged as one JSON line on stderr and sent to error tracking (bounded wait), then the process exits 1.
  installCrashReporting();
  if (env.RUN_WORKER_IN_PROCESS) {
    // Single-service hosting (e.g. a free web service): the outbox/job loop shares this process.
    // On a signal the loop finishes its current tick (bounded) before Nest closes the app and ends the database pool;
    // closing first made the tick fail with "Cannot use a pool after calling end on the pool" on every deploy.
    let stopping = false;
    const loop = runWorkerLoop(app, () => stopping, 'InProcessWorker');
    const shutdown = async (signal: NodeJS.Signals) => {
      stopping = true;
      await Promise.race([loop, new Promise((r) => setTimeout(r, WORKER_DRAIN_MS))]);
      await app.close();
      process.kill(process.pid, signal);
    };
    process.once('SIGTERM', (s) => void shutdown(s));
    process.once('SIGINT', (s) => void shutdown(s));
  }
}

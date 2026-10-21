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
    exposedHeaders: ['X-Request-Id', 'X-Build', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
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
  app.enableShutdownHooks();
  return app;
}

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
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    void runWorkerLoop(app, () => stopping, 'InProcessWorker');
  }
}

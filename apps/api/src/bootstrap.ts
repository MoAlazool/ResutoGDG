import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { hardeningMiddleware, trustProxySetting } from './common/http/http-hardening';
import { installOutboundRequestId } from './common/http/request-context';
import { loadEnv } from './config/env';
import { runWorkerLoop } from './worker-loop';

export async function createApp(): Promise<INestApplication> {
  const env = loadEnv();
  installOutboundRequestId();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: env.NODE_ENV === 'test' ? ['error'] : undefined });
  app.setGlobalPrefix('v1');
  app.enableCors({
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false, maxAge: 600,
    exposedHeaders: ['X-Request-Id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  });
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', trustProxySetting(env));
  // Request id + context, security and cache headers, access log (see http-hardening.ts).
  app.use(hardeningMiddleware(env));
  app.enableShutdownHooks();
  return app;
}

export async function main() {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Resuto').log(`API listening on :${env.PORT} (${env.NODE_ENV}; payments ${env.PAYMENT_MODE}, storage ${env.STORAGE_DRIVER})`);
  if (env.RUN_WORKER_IN_PROCESS) {
    // Single-service hosting (e.g. a free web service): the outbox/job loop shares this process.
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    void runWorkerLoop(app, () => stopping, 'InProcessWorker');
  }
}

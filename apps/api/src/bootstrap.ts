import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { runWorkerLoop } from './worker-loop';

export async function createApp(): Promise<INestApplication> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: env.NODE_ENV === 'test' ? ['error'] : undefined });
  app.setGlobalPrefix('v1');
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false, maxAge: 600, exposedHeaders: ['X-Request-Id'] });
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    // Accept a caller's correlation id only in a safe shape (it is echoed and logged).
    const given = req.headers['x-request-id'];
    req.id = typeof given === 'string' && /^[A-Za-z0-9._:-]{8,64}$/.test(given) ? given : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.enableShutdownHooks();
  return app;
}

export async function main() {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT, '0.0.0.0');
  new Logger('Resuto').log(`API listening on :${env.PORT} (${env.NODE_ENV})`);
  if (env.RUN_WORKER_IN_PROCESS) {
    // Single-service hosting (e.g. a free web service): the outbox/job loop shares this process.
    let stopping = false;
    process.once('SIGTERM', () => { stopping = true; });
    process.once('SIGINT', () => { stopping = true; });
    void runWorkerLoop(app, () => stopping, 'InProcessWorker');
  }
}

import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

export async function createApp(): Promise<INestApplication> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: env.NODE_ENV === 'test' ? ['error'] : undefined });
  app.setGlobalPrefix('v1');
  app.enableCors({ origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false, maxAge: 600 });
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 1);
  app.use((req: Request & { id?: string }, res: Response, next: NextFunction) => {
    req.id = (req.headers['x-request-id'] as string)?.slice(0, 64) || randomUUID();
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
}

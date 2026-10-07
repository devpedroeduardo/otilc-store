import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { Env } from './config/env';

/** Monta a aplicação. Usado pelo main.ts e pelos testes de integração. */
export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    logger: env.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'],
  });
  app.use(helmet());
  app.enableCors({ origin: env.WEB_ORIGIN, methods: ['GET', 'POST'] });
  app.disable('x-powered-by');
  // Atrás de um proxy (Render, Railway), o IP real do cliente vem no X-Forwarded-For.
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '20kb' });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

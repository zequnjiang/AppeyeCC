import Fastify from 'fastify';
import cors from '@fastify/cors';
import { logger } from './logger.js';

/** 构建 Fastify 实例；路由在后续 Epic 中通过 registerApiRoutes 挂载。 */
export async function buildApp() {
  const app = Fastify({ loggerInstance: logger });
  await app.register(cors, { origin: true });
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
  return app;
}

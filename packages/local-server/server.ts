import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { InventoryService } from '../core/service';
import { errorMessage, message } from '../contracts/messages';
export async function createServer({ service = new InventoryService(), webRoot, dev = false }: { service?: InventoryService; webRoot?: string; dev?: boolean } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 4096 });
  const token = randomBytes(32).toString('hex');
  const match = (value: unknown) => typeof value === 'string' && Buffer.byteLength(value) === Buffer.byteLength(token) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return reply.code(403).send({ error: message('errors.localOnly') });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return reply.code(403).send({ error: message('errors.originForbidden') });
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (request.url !== '/api/bootstrap') {
        const authenticated = match(request.headers['x-inventory-token']);
        if (!authenticated) return reply.code(401).send({ error: message('errors.sessionExpired') });
      }
    }
  });
  app.get('/api/bootstrap', async (_, reply) => {
    return { token };
  });
  app.post('/api/scan', async request => {
    const { project } = z.object({ project: z.string().max(4096).optional() }).parse(request.body ?? {});
    return service.scan(project || undefined);
  });
  app.get('/api/directories', async request => {
    const query = z.object({ path: z.string().max(4096).optional() }).parse(request.query);
    return service.directories(query.path);
  });
  app.setErrorHandler((error, _, reply) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (error instanceof z.ZodError || code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.code(400).send({ error: message('errors.invalidRequest') });
    }
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: message('errors.payloadTooLarge') });
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: message('errors.unsupportedContentType') });
    return reply.code(500).send({ error: errorMessage(error) });
  });
  app.setNotFoundHandler((_, reply) => reply.code(404).send({ error: message('errors.notFound') }));
  if (dev) {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: message('errors.notFound') });
      reply.hijack(); vite.middlewares(request.raw, reply.raw, () => { reply.raw.statusCode = 404; reply.raw.end('Not found'); });
    });
    app.addHook('onClose', async () => { await vite.close(); });
  } else if (webRoot) {
    await app.register(staticPlugin, { root: path.resolve(webRoot), index: ['index.html'] });
  }
  app.addHook('onClose', async () => { await service.close(); });
  return app;
}

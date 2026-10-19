import path from 'node:path';
import { createServer } from './server';
const dev = process.argv.includes('--dev');
const app = await createServer({ dev, webRoot: path.resolve('dist/web') });
try {
  const address = await app.listen({ port: Number(process.env.PORT ?? 4317), host: '127.0.0.1' });
  console.log(`Agent Lens → ${address}`);
} catch (error) { console.error(error); process.exit(1); }
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => { await app.close(); process.exit(0); });

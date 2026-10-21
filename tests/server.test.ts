import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from '../packages/local-server/server';
import { InventoryService } from '../packages/core/service';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { message } from '../packages/contracts/messages';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for(const fn of cleanup.splice(0)) await fn(); });
it('requires a local host, same origin, and session token before reading local data', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-api-'));
  const app = await createServer({ service: new InventoryService({ home }) });
  cleanup.push(() => app.close(), () => fs.rm(home, { recursive: true, force: true }));
  expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'attacker.com' } })).statusCode).toBe(403);
  expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost', origin: 'https://attacker.com' } })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url: '/api/scan', headers: { host: 'localhost' }, payload: {} })).statusCode).toBe(401);
  const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
  const headers = { host: 'localhost', 'x-inventory-token': bootstrap.json().token };
  const result = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
  expect(result.statusCode).toBe(200); expect(result.json().agents).toHaveLength(2);
  const invalid = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: { project: 12 } });
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: message('errors.invalidRequest') });
});

it('returns structured errors for authentication, parsing, filesystem and unexpected failures', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-errors-'));
  const service = new InventoryService({ home });
  const app = await createServer({ service });
  cleanup.push(() => app.close(), () => fs.rm(home, { recursive: true, force: true }));
  expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'attacker.com' } })).json()).toEqual({ error: message('errors.localOnly') });
  expect((await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost', origin: 'https://attacker.com' } })).json()).toEqual({ error: message('errors.originForbidden') });
  expect((await app.inject({ url: '/api/directories', headers: { host: 'localhost' } })).json()).toEqual({ error: message('errors.sessionExpired') });
  const bootstrap = await app.inject({ url: '/api/bootstrap', headers: { host: 'localhost' } });
  const headers = { host: 'localhost', 'x-inventory-token': bootstrap.json().token };
  for (const [payload, expectedStatus, code] of [
    ['{"project":', 400, 'errors.invalidRequest'],
    [JSON.stringify({ project: 'x'.repeat(5000) }), 413, 'errors.payloadTooLarge'],
  ] as const) {
    const response = await app.inject({ method: 'POST', url: '/api/scan', headers: { ...headers, 'content-type': 'application/json' }, payload });
    expect(response.statusCode).toBe(expectedStatus);
    expect(response.json()).toEqual({ error: message(code) });
  }
  const unsupported = await app.inject({ method: 'POST', url: '/api/scan', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: 'test' });
  expect(unsupported.statusCode).toBe(415);
  expect(unsupported.json()).toEqual({ error: message('errors.unsupportedContentType') });
  const missing = await app.inject({ url: `/api/directories?path=${encodeURIComponent(path.join(home, 'missing'))}`, headers });
  expect(missing.json()).toEqual({ error: message('errors.pathNotFound') });
  const file = path.join(home, 'file.txt');
  await fs.writeFile(file, 'test');
  const notDirectory = await app.inject({ url: `/api/directories?path=${encodeURIComponent(file)}`, headers });
  expect(notDirectory.json()).toEqual({ error: message('errors.notDirectory') });
  const invalidProject = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: { project: file } });
  expect(invalidProject.json()).toEqual({ error: message('errors.invalidProject') });
  const notFound = await app.inject({ url: '/api/missing', headers });
  expect(notFound.statusCode).toBe(404);
  expect(notFound.json()).toEqual({ error: message('errors.notFound') });
  vi.spyOn(service, 'scan').mockRejectedValueOnce(Object.assign(new Error('private permission details'), { code: 'EACCES' }));
  expect((await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} })).json()).toEqual({ error: message('errors.permissionDenied') });
  vi.spyOn(service, 'scan').mockRejectedValueOnce(new Error('token=secret raw configuration'));
  const unexpected = await app.inject({ method: 'POST', url: '/api/scan', headers, payload: {} });
  expect(unexpected.json()).toEqual({ error: message('errors.operationFailed') });
  expect(unexpected.body).not.toContain('secret');
});

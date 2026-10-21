import { expect, it, vi } from 'vitest';
import { createDesktopClient, createHttpClient } from '../apps/web/src/transport';
import { captureResult, InventoryError, message } from '../packages/contracts/messages';
import type { InventoryBridge } from '../packages/contracts';

it('retries a failed bootstrap and retains a structured API error', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('network private details'))
    .mockResolvedValueOnce(Response.json({ token: 'session-token' }))
    .mockResolvedValueOnce(Response.json({ error: message('errors.permissionDenied') }, { status: 500 }));
  const client = createHttpClient(fetcher);
  await expect(client.scan()).rejects.toMatchObject({ detail: message('errors.connectionFailed') });
  await expect(client.scan()).rejects.toMatchObject({ detail: message('errors.permissionDenied') });
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/bootstrap', '/api/bootstrap', '/api/scan']);
});

it('reacquires a token after a 401 and succeeds on explicit retry', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'first' }))
    .mockResolvedValueOnce(Response.json({ error: message('errors.sessionExpired') }, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ token: 'second' }))
    .mockResolvedValueOnce(Response.json({ path: '/repo', parent: '/', entries: [] }));
  const client = createHttpClient(fetcher);
  await expect(client.directories()).rejects.toMatchObject({ detail: message('errors.sessionExpired') });
  await expect(client.directories()).resolves.toEqual({ path: '/repo', parent: '/', entries: [] });
  expect(fetcher.mock.calls[3][1]?.headers).toMatchObject({ 'X-Inventory-Token': 'second' });
});

it('does not expose malformed response bodies', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'session' }))
    .mockResolvedValueOnce(new Response('<html>private proxy details</html>', { status: 502 }));
  await expect(createHttpClient(fetcher).scan()).rejects.toMatchObject({ detail: message('errors.invalidResponse') });
});

it('handles invalid bootstrap data without caching the failure', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 12 }))
    .mockResolvedValueOnce(Response.json({ token: 'session' }))
    .mockResolvedValueOnce(Response.json({ resources: [] }));
  const client = createHttpClient(fetcher);
  await expect(client.scan()).rejects.toMatchObject({ detail: message('errors.invalidResponse') });
  await expect(client.scan()).resolves.toMatchObject({ resources: [] });
});

it.each([
  [{ code: 'future.error', params: {} }, message('errors.requestFailed')],
  [{ code: 'errors.fileUnreadable', params: { limitMB: 2, lng: 'zh-CN' } }, message('errors.requestFailed')],
  ['Legacy local service error', 'Legacy local service error'],
])('handles unknown payloads and legacy servers: %j', async (error, expected) => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ token: 'session' }))
    .mockResolvedValueOnce(Response.json({ error }, { status: 500 }));
  await expect(createHttpClient(fetcher).scan()).rejects.toMatchObject({ detail: expected });
});

it('unwraps a cloned IPC failure before constructing a renderer-side Error', async () => {
  const bridge: InventoryBridge = {
    scan: async () => JSON.parse(JSON.stringify(await captureResult(() => { throw new InventoryError(message('errors.notDirectory')); }))),
    directories: async () => ({ ok: true, value: { path: '/repo', parent: '/', entries: [] } }),
    chooseDirectory: async () => ({ ok: true, value: null }),
    reveal: async () => ({ ok: false, error: message('errors.resourceNotFound') }),
  };
  const client = createDesktopClient(bridge);
  await expect(client.scan('/file')).rejects.toMatchObject({ detail: message('errors.notDirectory') });
  await expect(client.directories()).resolves.toMatchObject({ path: '/repo' });
  await expect(client.chooseDirectory()).resolves.toBeNull();
  await expect(client.reveal('missing')).rejects.toMatchObject({ detail: message('errors.resourceNotFound') });
  bridge.scan = async () => { throw new Error('Error invoking remote method: raw details'); };
  await expect(client.scan()).rejects.toMatchObject({ detail: message('errors.connectionFailed') });
});

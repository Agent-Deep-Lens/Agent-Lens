import type { InventoryBridge, InventoryClient, DirectoryListing, Snapshot } from '../../../packages/contracts';
import { InventoryError, isMessage, message, type MessageText, type Result } from '../../../packages/contracts/messages';

function responseError(value: unknown): MessageText {
  const error = value && typeof value === 'object' && 'error' in value ? value.error : undefined;
  return isMessage(error) || typeof error === 'string' && error.length > 0 ? error : message('errors.requestFailed');
}

export function createHttpClient(fetcher: typeof fetch = fetch): InventoryClient {
  let token: Promise<string> | undefined;
  async function fetchResponse(url: string, init?: RequestInit) {
    try { return await fetcher(url, init); }
    catch { throw new InventoryError(message('errors.connectionFailed')); }
  }
  async function readResponse(response: Response): Promise<unknown> {
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new InventoryError(message('errors.invalidResponse')); }
    if (!response.ok) throw new InventoryError(responseError(body));
    return body;
  }
  function session() {
    if (!token) {
      const pending = fetchResponse('/api/bootstrap').then(readResponse).then(body => {
        if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string' || !body.token) throw new InventoryError(message('errors.invalidResponse'));
        return body.token;
      });
      token = pending;
      // A rejected bootstrap must not permanently poison later retries.
      void pending.catch(() => { if (token === pending) token = undefined; });
    }
    return token;
  }
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const current = session();
    const response = await fetchResponse(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Inventory-Token': await current } });
    if (response.status === 401 && token === current) token = undefined;
    return await readResponse(response) as T;
  }
  return {
    scan: project => request<Snapshot>('/api/scan', { method: 'POST', body: JSON.stringify({ project }) }),
    directories: path => request<DirectoryListing>(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  };
}

export function createDesktopClient(bridge: InventoryBridge): Required<InventoryClient> {
  async function invoke<T>(operation: () => Promise<Result<T>>): Promise<T> {
    let result: Result<T>;
    try { result = await operation(); }
    catch { throw new InventoryError(message('errors.connectionFailed')); }
    if (!result || typeof result.ok !== 'boolean') throw new InventoryError(message('errors.invalidResponse'));
    if (!result.ok) throw new InventoryError(responseError(result));
    return result.value;
  }
  return {
    scan: project => invoke(() => bridge.scan(project)),
    directories: path => invoke(() => bridge.directories(path)),
    chooseDirectory: locale => invoke(() => bridge.chooseDirectory(locale)),
    reveal: id => invoke(() => bridge.reveal(id)),
  };
}

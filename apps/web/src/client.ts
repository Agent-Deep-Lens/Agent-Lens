import type { InventoryClient } from '../../../packages/contracts/index';
declare global { interface Window { inventory?: InventoryClient } }
let token: Promise<string> | undefined;
async function session() { return token ??= fetch('/api/bootstrap').then(async r => { if (!r.ok) throw new Error('无法连接本地服务'); return (await r.json()).token; }); }
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Inventory-Token': await session() } });
  if (!response.ok) { if (response.status === 401) token = undefined; throw new Error((await response.json()).error ?? '请求失败'); }
  return response.json();
}
export const client: InventoryClient = window.inventory ?? {
  scan: project => request('/api/scan', { method: 'POST', body: JSON.stringify({ project }) }),
  directories: path => request(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ''}`),
};

import { InventoryError, message } from '../contracts/messages';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { adapters, type AgentAdapter } from '../adapters/index';
import { canonical, exists, id } from './files';
import { ScanContext } from './scanner-context';
import type { Resource, Snapshot } from '../contracts/index';
export interface ScanOptions { home?: string; project?: string; roots?: Partial<Record<'claude' | 'codex', string>>; adapters?: AgentAdapter[] }
export async function scanInventory(options: ScanOptions = {}): Promise<{ snapshot: Snapshot; watched: string[] }> {
  const start = Date.now(); const home = options.home ?? os.homedir();
  const project = options.project ? await canonical(options.project) : undefined;
  if (project && !(await fs.stat(project)).isDirectory()) throw new InventoryError(message('errors.invalidProject'));
  const results = await Promise.all((options.adapters ?? adapters).map(async adapter => {
    const root = options.roots?.[adapter.id] ?? (!options.home ? (adapter.id === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR) : undefined) ?? path.join(home, `.${adapter.id}`);
    const ctx = new ScanContext(adapter.id, home, root, project);
    try { await adapter.scan(ctx); } catch { ctx.diagnostic(root, message('scan.partialFailure')); }
    const executableFound = (await Promise.all((process.env.PATH ?? '').split(path.delimiter).map(dir => exists(path.join(dir, adapter.id + (process.platform === 'win32' ? '.exe' : '')))))).some(Boolean);
    return { ctx, environment: { id: adapter.id, name: adapter.id === 'claude' ? 'Claude Code' : 'Codex', configFound: await exists(root) || ctx.resources.length > 0, executableFound } };
  }));
  const resources = new Map<string, Resource>();
  for (const { ctx } of results) for (const resource of ctx.resources) {
    const previous = resources.get(resource.id);
    if (previous) previous.bindings.push(...resource.bindings.filter(b => !previous.bindings.some(p => p.id === b.id)));
    else resources.set(resource.id, resource);
  }
  return { snapshot: { id: id(project ?? home, String(start)), project: project ?? null,
    scannedAt: new Date().toISOString(), durationMs: Date.now() - start,
    resources: [...resources.values()].sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics: results.flatMap(r => r.ctx.diagnostics), agents: results.map(r => r.environment) },
    watched: [...new Set(results.flatMap(r => [...r.ctx.watched]))] };
}

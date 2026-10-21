import { InventoryError, message } from '../contracts/messages';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { scanInventory, type ScanOptions } from './scanner';
import { canonical, entries } from './files';
import type { DirectoryListing, Snapshot } from '../contracts/index';
export class InventoryService {
  private pending = new Map<string, Promise<Snapshot>>();
  private snapshots = new Map<string, Snapshot>();
  constructor(private options: ScanOptions = {}) {}
  scan(project?: string): Promise<Snapshot> {
    const key = project ?? '';
    const existing = this.pending.get(key);
    if (existing) return existing;
    const request = scanInventory({ ...this.options, project }).then(({ snapshot }) => {
      for (const resource of snapshot.resources) this.snapshots.set(resource.id, snapshot);
      return snapshot;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
  resourcePath(id: string) { return this.snapshots.get(id)?.resources.find(r => r.id === id)?.path; }
  async directories(input?: string): Promise<DirectoryListing> {
    const home = this.options.home ?? os.homedir();
    const full = input?.startsWith('~') ? path.join(home, input.slice(1)) : input ?? home;
    const dir = await canonical(full);
    if (!(await fs.stat(dir)).isDirectory()) throw new InventoryError(message('errors.notDirectory'));
    const listing = await entries(dir);
    const directories = (await Promise.all(listing.filter(e => !e.name.startsWith('.')).map(async e => {
      const p = path.join(dir, e.name);
      const isDirectory = e.isDirectory() || e.isSymbolicLink() && (await fs.stat(p).catch(() => null))?.isDirectory();
      return isDirectory ? { name: e.name, path: p } : null;
    }))).filter((e): e is { name: string; path: string } => e !== null).sort((a, b) => a.name.localeCompare(b.name));
    return { path: dir, parent: path.dirname(dir) === dir ? null : path.dirname(dir), entries: directories };
  }
  async close() { await Promise.allSettled(this.pending.values()); this.snapshots.clear(); }
}

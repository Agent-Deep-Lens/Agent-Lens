import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import TOML from '@iarna/toml';
export type Obj = Record<string, any>;
export const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
export const str = (v: unknown, fallback = ''): string => typeof v === 'string' ? v : fallback;
export const id = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20);
export const inside = (root: string, target: string) => { const r = path.relative(root, target); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
export async function exists(p: string) { try { await fs.access(p); return true; } catch { return false; } }
export async function canonical(p: string) { try { return await fs.realpath(p); } catch { return path.resolve(p); } }
export async function entries(p: string) { try { return await fs.readdir(p, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } }
export async function readText(p: string) {
  const stat = await fs.stat(p);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('文件不可读取或超过 1 MB 限制');
  return fs.readFile(p, 'utf8');
}
export function parseDocument(text: string) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)/);
  return match ? { data: object(YAML.parse(match[1])), body: match[2].trim() } : { data: {}, body: text.trim() };
}
export function parseConfig(text: string, file: string): Obj {
  return object(file.endsWith('.toml') ? TOML.parse(text) : JSON.parse(text));
}
// Values from credential containers never cross the process boundary. Also sanitize URLs and CLI args.
export function redact(value: unknown, key = ''): any {
  if (/token|secret|password|authorization|api.?key|credential/i.test(key)) return '••••••';
  if (['env', 'headers', 'http_headers', 'env_http_headers'].includes(key) && value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).map(k => [k, '••••••']));
  if (key === 'args' && Array.isArray(value)) {
    let hideNext = false;
    return value.map(v => {
      const s = String(v);
      if (hideNext) { hideNext = false; return '••••••'; }
      if (/^--?.*(?:token|secret|password|key|auth)/i.test(s)) {
        if (s.includes('=')) return s.split('=')[0] + '=••••••';
        hideNext = true; return s;
      }
      return redact(s);
    });
  }
  if (typeof value === 'string') return value
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1••••••@')
    .replace(/([?&][\w.-]+)=([^\s&#]+)/g, '$1=••••••')
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{12,})\b/g, '••••••')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, '$1••••••');
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}
export async function projectAncestors(project: string) {
  const dirs = [project]; let current = project;
  while (!(await exists(path.join(current, '.git')))) {
    const parent = path.dirname(current);
    if (parent === current) return [project];
    current = parent; dirs.push(current);
  }
  return dirs.reverse();
}

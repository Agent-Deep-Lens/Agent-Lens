import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentId, Binding, Diagnostic, Kind, Resource, Scope, Status } from '../contracts/index';
import { canonical, entries, exists, id, inside, object, parseConfig, parseDocument, readText, redact, str, type Obj } from './files';
export interface SourceOptions { scope: Scope; status?: Status; reason?: string; plugin?: string; configPath?: string; appliesTo?: string }
export class ScanContext {
  resources: Resource[] = []; diagnostics: Diagnostic[] = []; watched = new Set<string>();
  constructor(public agent: AgentId, public home: string, public root: string, public project?: string) {}
  diagnostic(file: string, message: string) { this.diagnostics.push({ agent: this.agent, path: file, message }); }
  async config(file: string): Promise<Obj> {
    this.watched.add(file);
    if (!(await exists(file))) return {};
    try { return parseConfig(await readText(file), file); }
    catch { this.diagnostic(file, '配置无法解析，请检查文件格式或访问权限'); return {}; }
  }
  async add(kind: Kind, name: string, file: string, data: Obj, content: string, opts: SourceOptions, key = '') {
    const real = await canonical(file); const resourceId = id(kind, real, key);
    const binding: Binding = { id: id(resourceId, this.agent, file, opts.plugin ?? '', opts.scope), agent: this.agent,
      scope: opts.scope, path: file, status: opts.status ?? 'available', reason: opts.reason ?? '在 Agent 的标准发现目录中找到；实际加载仍受会话与权限影响',
      plugin: opts.plugin, configPath: opts.configPath, appliesTo: opts.appliesTo };
    const existing = this.resources.find(r => r.id === resourceId);
    if (existing) { if (!existing.bindings.some(b => b.id === binding.id)) existing.bindings.push(binding); return existing; }
    const resource: Resource = { id: resourceId, kind, name, description: str(data.description), path: real,
      version: str(data.version) || undefined, content: redact(content), metadata: redact(data), bindings: [binding] };
    this.resources.push(resource); return resource;
  }
  async markdown(file: string, kind: 'skill' | 'subagent', opts: SourceOptions) {
    this.watched.add(file);
    try {
      const { data, body } = parseDocument(await readText(file));
      const name = str(data.name, path.basename(file) === 'SKILL.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md'));
      await this.add(kind, name, file, data, body, opts);
    } catch { this.diagnostic(file, '无法读取定义或 YAML 元数据格式不正确'); }
  }
  async skills(dir: string, opts: SourceOptions) {
    this.watched.add(dir);
    try {
      if (await exists(path.join(dir, 'SKILL.md'))) { await this.markdown(path.join(dir, 'SKILL.md'), 'skill', opts); return; }
      for (const entry of await entries(dir)) {
        if (entry.name.startsWith('.') && entry.name !== '.system') continue;
        const sub = path.join(dir, entry.name);
        if (entry.name === '.system') { await this.skills(sub, { ...opts, scope: 'system', status: 'available', reason: '在宿主内置技能目录中发现' }); continue; }
        const skill = path.join(sub, 'SKILL.md');
        if (await exists(skill)) await this.markdown(skill, 'skill', opts);
        else if (entry.isSymbolicLink() && !(await exists(sub))) this.diagnostic(sub, '符号链接指向的资源不存在');
        if (this.agent === 'claude' && await exists(path.join(sub, '.claude-plugin/plugin.json'))) {
          await this.plugin(sub, { ...opts, status: 'conditional', reason: '技能目录中的插件；是否加载取决于宿主版本和工作区信任' });
        }
      }
    } catch { this.diagnostic(dir, '无法访问技能目录'); }
  }
  async agents(dir: string, opts: SourceOptions) {
    this.watched.add(dir);
    try {
      const stat = await fs.stat(dir).catch(() => null);
      const files = stat?.isFile() ? [dir] : (await entries(dir)).map(e => path.join(dir, e.name));
      for (const file of files) {
        if (file.endsWith('.md')) await this.markdown(file, 'subagent', opts);
        else if (file.endsWith('.toml')) {
          const data = await this.config(file);
          if (Object.keys(data).length) await this.add('subagent', str(data.name, path.basename(file, '.toml')), file, data, str(data.developer_instructions), opts);
        }
      }
    } catch { this.diagnostic(dir, '无法访问子 Agent 定义目录'); }
  }
  async mcp(map: unknown, file: string, opts: SourceOptions) {
    for (const [name, raw] of Object.entries(object(map))) {
      const data = object(raw);
      const valid = typeof data.command === 'string' || typeof data.url === 'string';
      const status = !valid ? 'invalid' : data.enabled === false || data.disabled === true ? 'disabled' : opts.status;
      const safe = redact(data);
      await this.add('mcp', name, file, safe, JSON.stringify(safe, null, 2), { ...opts, status,
        reason: !valid ? '缺少 command 或 url' : status === 'disabled' ? '配置明确禁用此服务' : opts.reason ?? '已发现 MCP 配置；尚未连接服务或检查授权' }, `${opts.scope}:${name}`);
    }
  }
  async plugin(root: string, opts: SourceOptions, identity?: string) {
    const candidates = this.agent === 'claude' ? ['.claude-plugin/plugin.json'] : ['plugin.json', '.codex-plugin/plugin.json'];
    let manifestFile = '';
    for (const candidate of candidates) if (await exists(path.join(root, candidate))) { manifestFile = path.join(root, candidate); break; }
    if (!manifestFile) { this.diagnostic(root, '插件目录缺少可识别的清单文件'); return; }
    const data = await this.config(manifestFile);
    if (!Object.keys(data).length) return;
    const name = str(data.name, path.basename(root));
    const plugin = await this.add('plugin', name, manifestFile, data, JSON.stringify(redact(data), null, 2), opts);
    const child = { ...opts, plugin: plugin.id };
    const fields = { ...data, ...object(object(data.extensions)['com.openai']) };
    const declared = (value: unknown, defaults: string[]) => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter(v => typeof v === 'string') : defaults;
    const safePath = (p: string) => { const full = path.resolve(root, p); if (!inside(root, full)) { this.diagnostic(manifestFile, '插件资源路径超出插件根目录，已跳过'); return null; } return full; };
    const skillDirs = this.agent === 'claude' ? [...new Set(['skills', ...declared(fields.skills, [])])] : declared(fields.skills, ['skills']);
    for (const d of skillDirs) { const p = safePath(d); if (p && p !== root) await this.skills(p, child); else if (p && await exists(path.join(p, 'SKILL.md'))) await this.markdown(path.join(p, 'SKILL.md'), 'skill', child); }
    for (const d of declared(fields.agents, ['agents'])) { const p = safePath(d); if (p) await this.agents(p, child); }
    if (this.agent === 'claude') {
      for (const d of declared(fields.commands, ['commands'])) {
        const p = safePath(d); if (!p) continue;
        if (p.endsWith('.md')) await this.markdown(p, 'skill', child);
        else for (const e of await entries(p)) if (e.name.endsWith('.md')) await this.markdown(path.join(p, e.name), 'skill', child);
      }
    }
    const mcpField = fields.mcpServers ?? fields.mcp;
    if (mcpField && typeof mcpField === 'object' && !Array.isArray(mcpField)) await this.mcp(object(mcpField).mcpServers ?? mcpField, manifestFile, child);
    for (const d of [...new Set(['.mcp.json', 'mcp.json', ...declared(mcpField, [])])]) {
      const p = safePath(d); if (!p || !(await exists(p))) continue;
      const cfg = await this.config(p); await this.mcp(cfg.mcpServers ?? cfg.servers ?? cfg, p, child);
    }
    if (identity) plugin.metadata.installationKey = identity;
  }
}

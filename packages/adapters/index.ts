import { message } from '../contracts/messages';
import path from 'node:path';
import type { AgentId } from '../contracts/index';
import { ScanContext, type SourceOptions } from '../core/scanner-context';
import { canonical, entries, exists, inside, object, projectAncestors, str, type Obj } from '../core/files';
export interface AgentAdapter { id: AgentId; scan(ctx: ScanContext): Promise<void> }

async function localDefinitions(ctx: ScanContext, dir: string, opts: SourceOptions) {
  const agentDir = ctx.agent === 'claude' ? '.claude' : '.codex';
  await ctx.skills(path.join(dir, ctx.agent === 'claude' ? '.claude' : '.agents', 'skills'), opts);
  await ctx.agents(path.join(dir, agentDir, 'agents'), opts);
  if (ctx.agent === 'claude') {
    const commands = path.join(dir, '.claude', 'commands'); ctx.watched.add(commands);
    for (const e of await entries(commands)) if (e.name.endsWith('.md')) await ctx.markdown(path.join(commands, e.name), 'skill', opts);
  }
  if (await exists(path.join(dir, agentDir + '-plugin', 'plugin.json')) || (ctx.agent === 'codex' && await exists(path.join(dir, 'plugin.json')))) {
    await ctx.plugin(dir, { ...opts, status: 'conditional', reason: message('reason.projectPluginSource') });
  }
  const pluginsDir = path.join(dir, agentDir, 'plugins');
  ctx.watched.add(pluginsDir);
  for (const e of await entries(pluginsDir)) {
    if (['cache', 'marketplaces'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(pluginsDir, e.name);
    if (await exists(path.join(p, agentDir + '-plugin', 'plugin.json')) || await exists(path.join(p, 'plugin.json')))
      await ctx.plugin(p, { ...opts, status: 'conditional', reason: message('reason.localPluginSource') });
  }
}

// Explicitly bounded project walk: no dependency folders, symlink recursion or arbitrary home traversal.
async function nestedDefinitions(ctx: ScanContext) {
  if (!ctx.project || ctx.project === ctx.home || path.dirname(ctx.project) === ctx.project) return;
  const excluded = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'vendor', '.next', 'coverage', 'target']);
  let count = 0; let truncated = false;
  async function walk(dir: string, depth: number) {
    if (count++ > 3000 || depth > 8) { truncated = true; return; }
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const sub = path.join(dir, entry.name);
      const marker = ctx.agent === 'claude' ? '.claude' : '.agents';
      if (await exists(path.join(sub, marker)) || await exists(path.join(sub, '.codex')) || await exists(path.join(sub, ctx.agent === 'claude' ? '.claude-plugin' : '.codex-plugin'))) {
        await localDefinitions(ctx, sub, { scope: 'project', appliesTo: sub, status: 'conditional', reason: message('reason.nestedDefinition') });
      }
      await walk(sub, depth + 1);
    }
  }
  await walk(ctx.project, 0);
  if (truncated) ctx.diagnostic(ctx.project, message('scan.nestedLimit', { directories: 3000, depth: 8 }));
}

async function pluginInstalls(ctx: ScanContext, settings: Obj) {
  const installedFile = path.join(ctx.root, 'plugins', 'installed_plugins.json');
  const installed = await ctx.config(installedFile);
  const known = new Set<string>();
  for (const [key, records] of Object.entries(object(installed.plugins))) {
    for (const record of Array.isArray(records) ? records : [records]) {
      const r = object(record); const root = str(r.installPath);
      if (!root) continue;
      const scoped = ['project', 'local'].includes(r.scope);
      if (scoped && (!ctx.project || !r.projectPath || !inside(await canonical(path.resolve(r.projectPath)), ctx.project))) continue;
      const enabled = ctx.agent === 'claude' ? settings.enabledPlugins?.[key] : settings.plugins?.[key]?.enabled;
      const opts: SourceOptions = { scope: scoped ? 'project' : 'user', configPath: installedFile,
        status: enabled === true ? 'available' : enabled === false ? 'disabled' : 'unknown',
        reason: enabled === true ? message('reason.pluginEnabled') : enabled === false ? message('reason.pluginDisabledWithChildren') : message('reason.pluginUnconfirmed') };
      known.add(key); await ctx.plugin(root, opts, key);
    }
  }
  // Codex installations may only expose cache + config; do not infer active version from timestamps.
  if (ctx.agent === 'codex') {
    const cache = path.join(ctx.root, 'plugins', 'cache'); ctx.watched.add(cache);
    for (const marketplace of await entries(cache)) {
      if (!marketplace.isDirectory()) continue;
      for (const plugin of await entries(path.join(cache, marketplace.name))) {
        if (!plugin.isDirectory()) continue;
        const key = `${plugin.name}@${marketplace.name}`; if (known.has(key)) continue;
        const base = path.join(cache, marketplace.name, plugin.name);
        const versions = (await entries(base)).filter(e => e.isDirectory());
        for (const version of versions) {
          const root = path.join(base, version.name);
          if (!(await exists(path.join(root, '.codex-plugin/plugin.json'))) && !(await exists(path.join(root, 'plugin.json')))) continue;
          const enabled = settings.plugins?.[key]?.enabled;
          await ctx.plugin(root, { scope: 'user', configPath: path.join(ctx.root, 'config.toml'),
            status: enabled === false ? 'disabled' : enabled === true && versions.length === 1 ? 'available' : 'unknown',
            reason: enabled === false ? message('reason.pluginDisabled') : enabled === true && versions.length === 1 ? message('reason.uniqueCacheEnabled') : message('reason.cacheUnconfirmed') }, key);
          known.add(key);
        }
      }
    }
  }
  const configured = ctx.agent === 'claude' ? object(settings.enabledPlugins) : object(settings.plugins);
  for (const key of Object.keys(configured)) if (!known.has(key)) {
    const enabled = ctx.agent === 'claude' ? configured[key] : configured[key]?.enabled;
    const file = path.join(ctx.root, ctx.agent === 'claude' ? 'settings.json' : 'config.toml');
    await ctx.add('plugin', key.split('@')[0], file, { installationKey: key }, '', {
      scope: 'user', status: enabled === false ? 'disabled' : 'unknown', reason: message('reason.pluginContentMissing'), configPath: file,
    }, key);
  }
}

const claude: AgentAdapter = { id: 'claude', async scan(ctx) {
  const settings = await ctx.config(path.join(ctx.root, 'settings.json'));
  await ctx.skills(path.join(ctx.root, 'skills'), { scope: 'user' });
  await ctx.agents(path.join(ctx.root, 'agents'), { scope: 'user' });
  for (const e of await entries(path.join(ctx.root, 'commands'))) if (e.name.endsWith('.md')) await ctx.markdown(path.join(ctx.root, 'commands', e.name), 'skill', { scope: 'user' });
  const globalFile = path.join(ctx.home, '.claude.json');
  const global = await ctx.config(globalFile);
  await ctx.mcp(global.mcpServers, globalFile, { scope: 'user' });
  let effective: Obj = { ...settings, enabledPlugins: { ...object(settings.enabledPlugins) } };
  if (ctx.project) {
    for (const dir of await projectAncestors(ctx.project)) {
      await localDefinitions(ctx, dir, { scope: 'project' });
      for (const name of ['settings.json', 'settings.local.json']) {
        const file = path.join(dir, '.claude', name); const cfg = await ctx.config(file);
        effective = { ...effective, ...cfg, enabledPlugins: { ...effective.enabledPlugins, ...object(cfg.enabledPlugins) } };
      }
      const file = path.join(dir, '.mcp.json');
      await ctx.mcp((await ctx.config(file)).mcpServers, file, { scope: 'project', status: 'conditional', reason: message('reason.projectMcpApproval') });
    }
    let projectCfg: Obj = {};
    for (const [key, value] of Object.entries(object(global.projects))) if (await canonical(key) === ctx.project) projectCfg = object(value);
    await ctx.mcp(projectCfg.mcpServers, globalFile, { scope: 'project', configPath: globalFile });
    for (const r of ctx.resources.filter(r => r.kind === 'mcp')) for (const b of r.bindings) {
      if ((effective.disabledMcpjsonServers ?? []).includes(r.name) || (projectCfg.disabledMcpServers ?? []).includes(r.name)) { b.status = 'disabled'; b.reason = message('reason.projectMcpDisabled'); }
      else if (b.status === 'conditional' && (effective.enableAllProjectMcpServers === true || (effective.enabledMcpjsonServers ?? []).includes(r.name))) { b.status = 'available'; b.reason = message('reason.projectMcpApproved'); }
    }
    await nestedDefinitions(ctx);
  }
  await pluginInstalls(ctx, effective);
  // Claude personal skill/agent definitions take precedence over project definitions.
  for (const kind of ['skill', 'subagent'] as const) {
    const personal = new Set(ctx.resources.filter(r => r.kind === kind && r.bindings.some(b => b.scope === 'user' && !b.plugin)).map(r => r.name));
    for (const r of ctx.resources.filter(r => r.kind === kind && personal.has(r.name))) for (const b of r.bindings)
      if (b.scope === 'project' && !b.plugin && b.status === 'available') { b.status = 'shadowed'; b.reason = message('reason.personalPrecedence'); }
  }
} };

const codex: AgentAdapter = { id: 'codex', async scan(ctx) {
  await ctx.skills(path.join(ctx.home, '.agents', 'skills'), { scope: 'user' });
  await ctx.skills(path.join(ctx.root, 'skills'), { scope: 'user', status: 'unknown', reason: message('reason.compatibilityDirectory') });
  await ctx.agents(path.join(ctx.root, 'agents'), { scope: 'user' });
  const globalFile = path.join(ctx.root, 'config.toml'); const global = await ctx.config(globalFile);
  let settings = { ...global, plugins: { ...object(global.plugins) } }; const configs: { file: string; data: Obj; opts: SourceOptions }[] = [{ file: globalFile, data: global, opts: { scope: 'user' } }];
  if (ctx.project) {
    for (const dir of await projectAncestors(ctx.project)) {
      await localDefinitions(ctx, dir, { scope: 'project' });
      const file = path.join(dir, '.codex', 'config.toml'); const cfg = await ctx.config(file);
      settings = { ...settings, ...cfg, plugins: { ...settings.plugins, ...object(cfg.plugins) } };
      configs.push({ file, data: cfg, opts: { scope: 'project', status: 'conditional', reason: message('reason.projectTrust') } });
    }
    await nestedDefinitions(ctx);
  }
  for (const { file, data, opts } of configs) {
    await ctx.mcp(data.mcp_servers, file, opts);
    // Legacy named-role declarations remain inspectable alongside standalone TOML agents.
    for (const [name, raw] of Object.entries(object(data.agents))) {
      const role = object(raw); if (!role.config_file && !role.description) continue;
      const roleFile = role.config_file ? path.resolve(path.dirname(file), str(role.config_file)) : file;
      const detail = role.config_file ? await ctx.config(roleFile) : {};
      await ctx.add('subagent', name, roleFile, { ...detail, ...role }, str(detail.developer_instructions), { ...opts, configPath: file }, roleFile === file ? name : '');
    }
    for (const raw of Array.isArray(data.skills?.config) ? data.skills.config : []) {
      const item = object(raw); if (!item.path) continue;
      const target = await canonical(path.resolve(path.dirname(file), str(item.path)));
      for (const resource of ctx.resources.filter(r => r.kind === 'skill' && (r.path === target || path.dirname(r.path) === target)))
        for (const b of resource.bindings) if (item.enabled === false) { b.status = 'disabled'; b.reason = message('reason.skillDisabled'); }
    }
  }
  await pluginInstalls(ctx, settings);
  for (const { file, data } of configs) for (const raw of Array.isArray(data.skills?.config) ? data.skills.config : []) {
    if (!raw?.path || raw.enabled !== false) continue;
    const target = await canonical(path.resolve(path.dirname(file), str(raw.path)));
    for (const resource of ctx.resources.filter(r => r.kind === 'skill' && (r.path === target || path.dirname(r.path) === target)))
      for (const b of resource.bindings) { b.status = 'disabled'; b.reason = message('reason.skillDisabled'); }
  }
} };
export const adapters: AgentAdapter[] = [claude, codex];

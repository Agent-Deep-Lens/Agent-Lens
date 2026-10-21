import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanInventory } from '../packages/core/scanner';
import { redact } from '../packages/core/files';
import { isMessage, message } from '../packages/contracts/messages';
let home: string; let project: string;
async function file(relative: string, content: string | object) { const target = path.join(home, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content)); return target; }
const skill = (name: string, description = 'Test description') => `---\nname: ${name}\ndescription: ${description}\n---\n# Instructions\nRead the project first.`;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'atm-test-')); project = path.join(home, 'project'); await fs.mkdir(path.join(project, '.git'), { recursive: true }); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
describe('mixed Agent inventory', () => {
  it('automatically discovers both Agents and keeps different same-name resources', async () => {
    await file('.claude/skills/global/SKILL.md', skill('global'));
    await file('project/.claude/skills/review/SKILL.md', skill('review', 'Claude review'));
    await file('project/.agents/skills/review/SKILL.md', skill('review', 'Codex review'));
    await file('project/.claude/agents/reviewer.md', skill('reviewer'));
    await file('project/.codex/agents/tester.toml', 'name = "tester"\ndescription = "Runs tests"\ndeveloper_instructions = "Test changes"');
    const { snapshot } = await scanInventory({ home, project });
    expect(snapshot.resources.filter(r => r.name === 'review')).toHaveLength(2);
    expect(snapshot.resources.filter(r => r.kind === 'subagent').map(r => r.name)).toEqual(['reviewer', 'tester']);
    expect(snapshot.resources.find(r => r.name === 'global')?.bindings[0].scope).toBe('user');
    expect(snapshot.agents.map(a => a.id)).toEqual(['claude', 'codex']);
    expect(snapshot.resources.every(r => r.bindings.every(b => isMessage(b.reason)))).toBe(true);
    expect(snapshot.resources.find(r => r.name === 'global')?.bindings[0].reason).toEqual(message('reason.standardDiscovery'));
  });
  it('merges symlinked resources while preserving independent agent bindings', async () => {
    const target = await file('shared/review/SKILL.md', skill('shared'));
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true });
    await fs.mkdir(path.join(home, '.agents/skills'), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(path.dirname(target), path.join(home, '.claude/skills/shared'), linkType);
    await fs.symlink(path.dirname(target), path.join(home, '.agents/skills/shared'), linkType);
    const { snapshot } = await scanInventory({ home });
    expect(snapshot.resources.filter(r => r.name === 'shared')).toHaveLength(1);
    expect(snapshot.resources[0].bindings.map(b => b.agent).sort()).toEqual(['claude', 'codex']);
  });
  it('expands disabled plugins and does not leak project installations globally', async () => {
    const root = path.join(home, 'installed');
    await file('installed/.claude-plugin/plugin.json', { name: 'engineering', description: 'Team workflows' });
    await file('installed/skills/release/SKILL.md', skill('release'));
    await file('installed/agents/reviewer.md', skill('plugin-reviewer'));
    await file('installed/.mcp.json', { mcpServers: { tools: { command: 'node', args: ['server.js'] } } });
    await file('.claude/plugins/installed_plugins.json', { plugins: { 'engineering@team': [{ scope: 'project', projectPath: project, installPath: root }] } });
    await file('project/.claude/settings.json', { enabledPlugins: { 'engineering@team': false } });
    const global = await scanInventory({ home });
    expect(global.snapshot.resources).toHaveLength(0);
    const { snapshot } = await scanInventory({ home, project });
    expect(snapshot.resources).toHaveLength(4);
    expect(snapshot.resources.every(r => r.bindings[0].status === 'disabled')).toBe(true);
    expect(snapshot.resources.filter(r => r.kind !== 'plugin').every(r => !!r.bindings[0].plugin)).toBe(true);
    expect(snapshot.resources.find(r => r.kind === 'plugin')?.bindings[0].reason).toEqual(message('reason.pluginDisabledWithChildren'));
  });
  it('reports broken configs without losing the other agent and never exposes credentials', async () => {
    await file('project/.claude/settings.json', '{broken json');
    await file('.codex/config.toml', '[mcp_servers.api]\ncommand="node"\nargs=["--token", "super-secret"]\n[mcp_servers.api.env]\nCUSTOM="private-value"');
    await file('project/.agents/skills/test/SKILL.md', skill('test'));
    const { snapshot } = await scanInventory({ home, project });
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0].message).toEqual(message('scan.configUnreadable'));
    expect(snapshot.resources.find(r => r.name === 'test')).toBeDefined();
    expect(JSON.stringify(snapshot)).not.toContain('super-secret');
    expect(JSON.stringify(snapshot)).not.toContain('private-value');
    expect(snapshot.resources.find(r => r.name === 'api')?.kind).toBe('mcp');
  });
  it('distinguishes local plugin source and nested skills from enabled installs', async () => {
    await file('project/.claude-plugin/plugin.json', { name: 'local-plugin' });
    await file('project/skills/local/SKILL.md', skill('local'));
    await file('project/apps/web/.agents/skills/nested/SKILL.md', skill('nested'));
    await file('project/node_modules/ignored/.agents/skills/hidden/SKILL.md', skill('hidden'));
    const { snapshot } = await scanInventory({ home, project });
    expect(snapshot.resources.find(r => r.name === 'local-plugin')?.bindings[0].status).toBe('conditional');
    expect(snapshot.resources.find(r => r.name === 'local-plugin')?.bindings[0].reason).toEqual(message('reason.projectPluginSource'));
    expect(snapshot.resources.find(r => r.name === 'nested')?.bindings[0].appliesTo).toBe(await fs.realpath(path.join(project, 'apps/web')));
    expect(snapshot.resources.find(r => r.name === 'nested')?.bindings[0].reason).toEqual(message('reason.nestedDefinition'));
    expect(snapshot.resources.find(r => r.name === 'hidden')).toBeUndefined();
  });
  it('reads repository ancestor definitions and marks Claude personal precedence', async () => {
    await file('.claude/skills/review/SKILL.md', skill('review'));
    await file('project/.claude/skills/review/SKILL.md', skill('review'));
    await file('project/.agents/skills/root/SKILL.md', skill('root'));
    const sub = path.join(project, 'apps/web'); await fs.mkdir(sub, { recursive: true });
    const { snapshot } = await scanInventory({ home, project: sub });
    expect(snapshot.resources.find(r => r.name === 'root')).toBeDefined();
    expect(snapshot.resources.find(r => r.name === 'review' && r.bindings[0].scope === 'project')?.bindings[0].status).toBe('shadowed');
    expect(snapshot.resources.find(r => r.name === 'review' && r.bindings[0].scope === 'project')?.bindings[0].reason).toEqual(message('reason.personalPrecedence'));
  });
  it('honors Codex custom skill paths and disabled plugin configuration', async () => {
    await file('.codex/config.toml', '[plugins."docs@team"]\nenabled=false');
    await file('.codex/plugins/cache/team/docs/1.0/.codex-plugin/plugin.json', { name: 'docs', skills: './.agents/skills/' });
    await file('.codex/plugins/cache/team/docs/1.0/.agents/skills/write/SKILL.md', skill('write'));
    const { snapshot } = await scanInventory({ home });
    expect(snapshot.resources.map(r => r.name)).toEqual(['docs', 'write']);
    expect(snapshot.resources.every(r => r.bindings[0].status === 'disabled')).toBe(true);
    expect(snapshot.resources.every(r => r.bindings[0].reason && isMessage(r.bindings[0].reason))).toBe(true);
  });
  it('keeps reason messages in sync with MCP approval and skill disable overrides', async () => {
    await file('project/.mcp.json', { mcpServers: { approved: { command: 'node' }, disabled: { command: 'node' }, invalid: {} } });
    await file('project/.claude/settings.json', { enabledMcpjsonServers: ['approved'], disabledMcpjsonServers: ['disabled'] });
    const skillFile = await file('project/.agents/skills/disabled/SKILL.md', skill('disabled-skill'));
    await file('project/.codex/config.toml', `[[skills.config]]\npath = ${JSON.stringify(skillFile)}\nenabled = false`);
    const { snapshot } = await scanInventory({ home, project });
    for (const [name, status, reason] of [
      ['approved', 'available', message('reason.projectMcpApproved')],
      ['disabled', 'disabled', message('reason.projectMcpDisabled')],
      ['invalid', 'invalid', message('reason.mcpInvalid')],
      ['disabled-skill', 'disabled', message('reason.skillDisabled')],
    ] as const) {
      expect(snapshot.resources.find(r => r.name === name)?.bindings[0]).toMatchObject({ status, reason });
    }
  });
  it('reports adapter failures and nested limits with parameters rather than exception text', async () => {
    const failure = await scanInventory({ home, adapters: [{ id: 'claude', async scan() { throw new Error('private config'); } }] });
    expect(failure.snapshot.diagnostics[0].message).toEqual(message('scan.partialFailure'));
    expect(JSON.stringify(failure)).not.toContain('private config');
    await fs.mkdir(path.join(project, ...Array.from({ length: 10 }, (_, i) => `level${i}`)), { recursive: true });
    const { snapshot } = await scanInventory({ home, project });
    expect(snapshot.diagnostics).toHaveLength(2);
    expect(snapshot.diagnostics.every(d => JSON.stringify(d.message) === JSON.stringify(message('scan.nestedLimit', { directories: 3000, depth: 8 })))).toBe(true);
  });
});
it('redacts nested auth data, URL credentials, query parameters and secret command arguments', () => {
  const output = JSON.stringify(redact({ url: 'https://user:secret@example.com/mcp?key=hidden', headers: { Custom: 'hidden' }, args: ['--api-key=hidden'], auth: { password: 'hidden' } }));
  expect(output).not.toContain('hidden'); expect(output).not.toContain('user:secret');
});

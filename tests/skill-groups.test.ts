import { expect, it } from 'vitest';
import { groupSkills } from '../apps/web/src/skill-groups';
import type { Binding, Resource } from '../packages/contracts/index';
const filters = { agent: 'all', scope: 'all', status: 'all' };
const binding = (id: string, overrides: Partial<Binding> = {}): Binding => ({ id, agent: 'claude', scope: 'user', path: '/home/.claude/skills/review/SKILL.md', status: 'available', reason: '', ...overrides });
const resource = (id: string, bindings: Binding[], kind: Resource['kind'] = 'skill'): Resource => ({ id, kind, name: id, description: 'Description', path: '/', content: '', metadata: {}, bindings });
it('groups plugin skills by installation identity and independent skills by project, user and system', () => {
  const plugin = resource('plugin-a', [], 'plugin');
  const plugin2 = { ...resource('plugin-b', [], 'plugin'), name: plugin.name };
  const skills = [resource('a', [binding('a', { plugin: plugin.id })]), resource('b', [binding('b', { plugin: plugin2.id })]),
    resource('local', [binding('c', { scope: 'project', path: '/repo/.claude/skills/local/SKILL.md' })]),
    resource('nested', [binding('d', { scope: 'project', appliesTo: '/repo/web' })]),
    resource('global', [binding('e')]), resource('builtin', [binding('f', { scope: 'system' })])];
  const groups = groupSkills(skills, [...skills, plugin, plugin2], filters);
  expect(groups.map(g => g.type)).toEqual(['project', 'project', 'plugin', 'plugin', 'user', 'system']);
  expect(groups.filter(g => g.type === 'plugin')).toHaveLength(2);
  expect(groups[0].name).toBe('项目内定义 · repo');
});
it('keeps ownership per filtered binding and deduplicates shared skills within a group', () => {
  const skill = resource('shared', [binding('a', { plugin: 'plugin', agent: 'claude' }), binding('b', { plugin: 'plugin', agent: 'codex' }), binding('c', { agent: 'codex', scope: 'project', path: '/repo/.agents/skills/shared/SKILL.md' })]);
  const plugin = resource('plugin', [], 'plugin');
  const groups = groupSkills([skill], [skill, plugin], filters);
  expect(groups).toHaveLength(2);
  expect(groups[1].resources).toHaveLength(1);
  expect(groups[1].agents).toEqual(['claude', 'codex']);
  expect(skill.bindings).toHaveLength(3);
  const filtered = groupSkills([skill], [skill, plugin], { ...filters, scope: 'project' });
  expect(filtered).toHaveLength(1);
  expect(filtered[0].type).toBe('project');
  expect(filtered[0].agents).toEqual(['codex']);
});

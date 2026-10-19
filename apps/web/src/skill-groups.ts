import type { AgentId, Binding, Resource } from '../../../packages/contracts/index';
export interface SkillGroup {
  id: string;
  type: 'plugin' | 'project' | 'user' | 'system';
  name: string;
  description: string;
  plugin?: Resource;
  agents: AgentId[];
  resources: Resource[];
}
export interface SkillFilters { agent: string; scope: string; status: string }
export function matchesBinding(binding: Binding, filters: SkillFilters) {
  return (filters.agent === 'all' || binding.agent === filters.agent)
    && (filters.scope === 'all' || binding.scope === filters.scope)
    && (filters.status === 'all' || binding.status === filters.status);
}
export function groupSkills(skills: Resource[], inventory: Resource[], filters: SkillFilters): SkillGroup[] {
  const plugins = new Map(inventory.filter(r => r.kind === 'plugin').map(r => [r.id, r]));
  const groups = new Map<string, SkillGroup>();
  for (const resource of skills) {
    if (resource.kind !== 'skill') continue;
    for (const binding of resource.bindings.filter(b => matchesBinding(b, filters))) {
      const plugin = binding.plugin ? plugins.get(binding.plugin) : undefined;
      const type = binding.plugin ? 'plugin' : binding.scope === 'project' ? 'project' : binding.scope === 'system' ? 'system' : 'user';
      const projectRoot = binding.appliesTo ?? binding.path.split(/[\\/]\.(?:claude|agents|codex)[\\/]/)[0];
      const key = type === 'plugin' ? `plugin:${binding.plugin}` : type === 'project' ? `project:${projectRoot}` : type;
      let group = groups.get(key);
      if (!group) {
        group = { id: key, type, plugin, agents: [], resources: [],
          name: type === 'plugin' ? plugin?.name ?? '未识别插件' : type === 'project' ? `项目内定义 · ${projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? '当前项目'}` : type === 'system' ? '系统内置' : '全局独立技能',
          description: type === 'plugin' ? plugin?.description ?? '此插件提供的技能' : type === 'project' ? projectRoot : type === 'system' ? 'Agent 自带的技能' : '用户技能目录中的独立定义',
        };
        groups.set(key, group);
      }
      if (!group.agents.includes(binding.agent)) group.agents.push(binding.agent);
      const existing = group.resources.find(r => r.id === resource.id);
      if (existing) existing.bindings.push(binding);
      else group.resources.push({ ...resource, bindings: [binding] });
    }
  }
  const order = { project: 0, plugin: 1, user: 2, system: 3 };
  return [...groups.values()].sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

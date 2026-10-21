import { describe, expect, it } from 'vitest';
import { createLocalization } from '../apps/web/src/i18n/localization';
import { localeStorageKey, resolveLocale, type LocalePreference } from '../packages/i18n/locale';
import { en } from '../packages/i18n/locales/en';
import { zhCN } from '../packages/i18n/locales/zh-CN';
import { groupSkills } from '../apps/web/src/skill-groups';
import type { Resource } from '../packages/contracts';

function storage(initial?: string) {
  const values = new Map(initial === undefined ? [] : [[localeStorageKey, initial]]);
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('locale preferences', () => {
  it.each([
    ['system', ['zh-Hans-CN'], 'zh-CN'], ['system', ['zh-TW'], 'zh-CN'],
    ['system', ['en-GB'], 'en'], ['system', ['de-DE', 'zh-CN'], 'en'],
    ['system', [], 'en'], ['en', ['zh-CN'], 'en'], ['zh-CN', ['en-US'], 'zh-CN'],
  ] satisfies [LocalePreference, string[], string][])('resolves %s with %j to %s', (preference, languages, expected) => {
    expect(resolveLocale(preference, languages)).toBe(expected);
  });

  it('saves an explicit preference and restores it on the next launch', async () => {
    const localStorage = storage();
    const first = createLocalization(localStorage, () => ['zh-CN']);
    await first.ready;
    first.setPreference('en');
    const next = createLocalization(localStorage, () => ['zh-CN']);
    await next.ready;
    expect(next.getPreference()).toBe('en');
    expect(next.i18n.t('settings.title')).toBe('Settings');
    expect(localStorage.getItem(localeStorageKey)).toBe('en');
  });

  it('tracks system changes only while following the system, including after a restart', async () => {
    let languages = ['zh-CN'];
    const localStorage = storage('system');
    const app = createLocalization(localStorage, () => languages);
    await app.ready;
    languages = ['en-US'];
    await app.refreshSystemLanguage();
    expect(app.i18n.t('settings.title')).toBe('Settings');
    app.setPreference('zh-CN');
    await app.refreshSystemLanguage();
    expect(app.i18n.t('settings.title')).toBe('设置');
    app.setPreference('system');
    expect(app.i18n.t('settings.title')).toBe('Settings');
    const next = createLocalization(localStorage, () => ['zh-CN']);
    await next.ready;
    expect(next.getPreference()).toBe('system');
    expect(next.i18n.t('settings.title')).toBe('设置');
  });

  it.each(['invalid', 'null', '"en"', ''])('ignores a corrupt or unsupported stored value: %s', async value => {
    const app = createLocalization(storage(value), () => ['zh-CN']);
    await app.ready;
    expect(app.getPreference()).toBe('system');
    expect(app.locale()).toBe('zh-CN');
  });

  it('remains usable when storage is unavailable', async () => {
    const app = createLocalization({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } }, () => ['zh-CN']);
    await app.ready;
    app.setPreference('en');
    expect(app.getPreference()).toBe('en');
    expect(app.i18n.t('settings.title')).toBe('Settings');
  });
});

describe('bundled translations', () => {
  it('has matching nonempty keys and interpolation parameters in both catalogs', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    const parameters = (text: string) => [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zhCN[key].trim(), key).not.toBe('');
      expect(en[key].trim(), key).not.toBe('');
      expect(parameters(zhCN[key]), key).toEqual(parameters(en[key]));
    }
  });

  it('handles English plurals and renders parameters as data', async () => {
    const app = createLocalization(storage('en'), () => []);
    await app.ready;
    expect(app.i18n.t('counts.resources', { count: 0 })).toBe('0 resources');
    expect(app.i18n.t('counts.resources', { count: 1 })).toBe('1 resource');
    expect(app.i18n.t('counts.resources', { count: 2 })).toBe('2 resources');
    expect(app.i18n.t('detail.viewPlugin', { name: 'My {{plugin}} <name>' })).toBe('View plugin My {{plugin}} <name>');
    app.setPreference('zh-CN');
    expect(app.i18n.t('counts.resources', { count: 1 })).toBe('1 项资源');
    expect(app.i18n.t('counts.resources', { count: 2 })).toBe('2 项资源');
  });

  it('translates generated group labels without changing identity or original resource content', async () => {
    const app = createLocalization(storage('zh-CN'), () => []);
    await app.ready;
    const skill: Resource = { id: 'skill', name: '原始技能', description: '用户描述', kind: 'skill', path: '/repo', content: '原始正文', metadata: {}, bindings: [{ id: 'binding', agent: 'codex', scope: 'project', path: '/repo/.agents/skills/test/SKILL.md', status: 'available', reason: '' }] };
    const filters = { agent: 'all', scope: 'all', status: 'all' };
    const chinese = groupSkills([skill], [skill], filters, app.i18n.getFixedT('zh-CN'))[0];
    app.setPreference('en');
    const english = groupSkills([skill], [skill], filters, app.i18n.getFixedT('en'))[0];
    expect(chinese.name).toBe('项目内定义 · repo');
    expect(english.name).toBe('Project definitions · repo');
    expect(english.id).toBe(chinese.id);
    expect(english.resources[0]).toEqual(skill);
  });
});

import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { i18nOptions } from '../packages/i18n';
import { formatMessage } from '../packages/i18n/messages';
import { captureResult, errorMessage, InventoryError, isMessage, message, messageParameters } from '../packages/contracts/messages';
import { en } from '../packages/i18n/locales/en';
import { zhCN } from '../packages/i18n/locales/zh-CN';

const i18n = createInstance();
await i18n.init(i18nOptions('en'));

describe('language-independent messages', () => {
  it('covers every message and parameter with both translations', () => {
    for (const [code, parameters] of Object.entries(messageParameters)) {
      const key = `messages.${code}` as keyof typeof en;
      const value = { code, params: Object.fromEntries(Object.entries(parameters).map(([key, type]) => [key, type === 'number' ? 8 : 'example'])) };
      expect(isMessage(value), code).toBe(true);
      for (const [locale, catalog] of [['en', en], ['zh-CN', zhCN]] as const) {
        expect(catalog[key], key).toBeTruthy();
        const placeholders = [...catalog[key].matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]).sort();
        expect(placeholders, key).toEqual(Object.keys(parameters).sort());
        const formatted = formatMessage(i18n.getFixedT(locale), value);
        expect(formatted).not.toContain('{{');
        expect(formatted).not.toBe(key);
        if (code !== 'errors.operationFailed') expect(formatted).not.toBe(catalog['messages.errors.operationFailed']);
      }
    }
  });

  it('renders the same serialized result in either language without mutating it', () => {
    const value = JSON.parse(JSON.stringify(message('scan.nestedLimit', { depth: 8, directories: 3000 })));
    const before = JSON.stringify(value);
    expect(formatMessage(i18n.getFixedT('en'), value)).toContain('3000 directories or 8 levels');
    expect(formatMessage(i18n.getFixedT('zh-CN'), value)).toContain('3000 个目录或 8 层');
    expect(JSON.stringify(value)).toBe(before);
    expect(formatMessage(i18n.getFixedT('en'), 'Legacy adapter message')).toBe('Legacy adapter message');
  });

  it.each([
    null, { code: 'not.known', params: {} }, { code: 'scan.nestedLimit', params: {} },
    { code: 'scan.nestedLimit', params: { directories: '3000', depth: 8 } },
    { code: 'scan.nestedLimit', params: { directories: NaN, depth: 8 } },
    { code: 'reason.standardDiscovery', params: { lng: 'zh-CN' } },
    { code: '__proto__', params: {} },
  ])('falls back safely for unknown codes or invalid parameters: %j', value => {
    expect(isMessage(value)).toBe(false);
    expect(formatMessage(i18n.getFixedT('en'), value)).toBe(en['messages.errors.operationFailed']);
  });

  it.each([
    ['ENOENT', 'errors.pathNotFound'], ['ENOTDIR', 'errors.notDirectory'],
    ['EACCES', 'errors.permissionDenied'], ['EPERM', 'errors.permissionDenied'], ['ELOOP', 'errors.symlinkLoop'],
  ])('maps %s without exposing exception messages', (code, expected) => {
    const error = Object.assign(new Error('private-password=secret'), { code });
    expect(errorMessage(error)).toEqual({ code: expected, params: {} });
    expect(JSON.stringify(errorMessage(error))).not.toContain('secret');
  });

  it('preserves known errors in a serializable IPC envelope and sanitizes unexpected failures', async () => {
    const known = await captureResult(() => { throw new InventoryError(message('errors.fileUnreadable', { limitMB: 1 })); });
    expect(JSON.parse(JSON.stringify(known))).toEqual({ ok: false, error: message('errors.fileUnreadable', { limitMB: 1 }) });
    expect(await captureResult(async () => { throw new Error('raw config and private token'); })).toEqual({ ok: false, error: message('errors.operationFailed') });
    expect(await captureResult(() => { throw new Error('native detail'); }, message('errors.directoryPicker'))).toEqual({ ok: false, error: message('errors.directoryPicker') });
    expect(await captureResult(async () => ({ count: 2 }))).toEqual({ ok: true, value: { count: 2 } });
  });
});

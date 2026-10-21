export type Locale = 'zh-CN' | 'en';
export type LocalePreference = Locale | 'system';
export const localeStorageKey = 'atm.locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isLocale(value);
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[]): Locale {
  if (preference !== 'system') return preference;
  // The first system language controls the UI. Unsupported languages fall back to English.
  return /^zh(?:[-_]|$)/i.test(languages[0] ?? '') ? 'zh-CN' : 'en';
}

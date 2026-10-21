import { createInstance } from 'i18next';
import { i18nOptions } from '../../../../packages/i18n';
import { isLocalePreference, localeStorageKey, resolveLocale, type LocalePreference } from '../../../../packages/i18n/locale';

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function createLocalization(storage: PreferenceStorage, languages: () => readonly string[]) {
  let preference: LocalePreference = 'system';
  try {
    const stored = storage.getItem(localeStorageKey);
    if (isLocalePreference(stored)) preference = stored;
  } catch { /* Storage may be disabled; keep an in-memory preference. */ }

  const locale = () => resolveLocale(preference, languages());
  const i18n = createInstance();
  const ready = i18n.init(i18nOptions(locale()));
  const listeners = new Set<() => void>();
  const refreshSystemLanguage = () => i18n.changeLanguage(locale());

  return {
    i18n, ready, locale, refreshSystemLanguage,
    getPreference: () => preference,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setPreference(value: LocalePreference) {
      if (!isLocalePreference(value)) return;
      preference = value;
      try { storage.setItem(localeStorageKey, value); } catch { /* Continue for this session. */ }
      void refreshSystemLanguage();
      listeners.forEach(listener => listener());
    },
  };
}

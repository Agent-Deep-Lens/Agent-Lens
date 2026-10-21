import { useSyncExternalStore } from 'react';
import { createLocalization } from './localization';

export const localization = createLocalization({
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
}, () => navigator.languages.length ? navigator.languages : [navigator.language]);

function updateDocumentLanguage() {
  document.documentElement.lang = localization.locale();
  document.querySelector('meta[name="description"]')?.setAttribute('content', localization.i18n.t('app.description'));
}
localization.i18n.on('languageChanged', updateDocumentLanguage);
void localization.ready.then(updateDocumentLanguage);
window.addEventListener('languagechange', () => { void localization.refreshSystemLanguage(); });

export function useLocalePreference() {
  const preference = useSyncExternalStore(localization.subscribe, localization.getPreference);
  return [preference, localization.setPreference] as const;
}

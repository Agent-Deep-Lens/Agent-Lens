import type { InitOptions } from 'i18next';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import type { Locale } from './locale';

export const resources = { en: { translation: en }, 'zh-CN': { translation: zhCN } };

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
    keySeparator: false;
  }
}

export function i18nOptions(locale: Locale): InitOptions {
  return {
    resources,
    lng: locale,
    supportedLngs: ['zh-CN', 'en'],
    fallbackLng: 'en',
    load: 'currentOnly',
    keySeparator: false,
    initAsync: false,
    interpolation: { escapeValue: false }, // React escapes rendered text.
  };
}

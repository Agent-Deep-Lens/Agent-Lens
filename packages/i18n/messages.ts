import type { TFunction } from 'i18next';
import { isMessage } from '../contracts/messages';

export function formatMessage(t: TFunction, value: unknown): string {
  if (typeof value === 'string') return value;
  // Validate parameters before passing them to i18next; wire data cannot override options.
  if (isMessage(value)) {
    switch (value.code) {
      case 'scan.nestedLimit': return t('messages.scan.nestedLimit', value.params);
      case 'errors.fileUnreadable': return t('messages.errors.fileUnreadable', value.params);
      default: return t(`messages.${value.code}`);
    }
  }
  return t('messages.errors.operationFailed');
}

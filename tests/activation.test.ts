import { expect, it, vi } from 'vitest';
import { onActivation } from '../apps/web/src/activation';
function setup() {
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible', focused: true, hasFocus() { return this.focused; } });
  const refresh = vi.fn();
  const cleanup = onActivation(window, document, refresh);
  return { window, document, refresh, cleanup };
}
it('does not rescan while active and triggers once per window reactivation', () => {
  const { window, refresh, cleanup } = setup();
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  expect(refresh).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('focus'));
  expect(refresh).toHaveBeenCalledTimes(1);
  cleanup();
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
  expect(refresh).toHaveBeenCalledTimes(1);
});
it('coalesces visibility and focus events and never refreshes hidden windows', () => {
  const { window, document, refresh, cleanup } = setup();
  document.visibilityState = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  expect(refresh).not.toHaveBeenCalled();
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  expect(refresh).toHaveBeenCalledTimes(1);
  cleanup();
});

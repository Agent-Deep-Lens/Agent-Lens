/** A visibility+focus transition triggers once, even when both browser events fire. */
export function onActivation(
  windowTarget: EventTarget,
  documentTarget: EventTarget & { visibilityState: string; hasFocus(): boolean },
  refresh: () => void,
) {
  let focused = documentTarget.hasFocus();
  let active = documentTarget.visibilityState === 'visible' && focused;
  const update = () => {
    const next = documentTarget.visibilityState === 'visible' && focused;
    const activated = next && !active;
    active = next;
    if (activated) refresh();
  };
  const focus = () => { focused = true; update(); };
  const blur = () => { focused = false; update(); };
  const visibility = () => { focused = documentTarget.hasFocus(); update(); };
  windowTarget.addEventListener('focus', focus);
  windowTarget.addEventListener('blur', blur);
  documentTarget.addEventListener('visibilitychange', visibility);
  return () => {
    windowTarget.removeEventListener('focus', focus);
    windowTarget.removeEventListener('blur', blur);
    documentTarget.removeEventListener('visibilitychange', visibility);
  };
}

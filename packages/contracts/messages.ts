// Stable, language-independent wire messages. Never include raw exceptions or config contents.
export const messageParameters = {
  "scan.configUnreadable": {},
  "scan.definitionUnreadable": {},
  "scan.brokenSymlink": {},
  "scan.skillsUnreadable": {},
  "scan.agentsUnreadable": {},
  "scan.manifestMissing": {},
  "scan.pluginPathOutsideRoot": {},
  "scan.partialFailure": {},
  "scan.nestedLimit": {
    "directories": "number",
    "depth": "number"
  },
  "reason.standardDiscovery": {},
  "reason.builtIn": {},
  "reason.skillDirectoryPlugin": {},
  "reason.mcpInvalid": {},
  "reason.mcpDisabled": {},
  "reason.mcpDiscovered": {},
  "reason.projectPluginSource": {},
  "reason.localPluginSource": {},
  "reason.nestedDefinition": {},
  "reason.pluginEnabled": {},
  "reason.pluginDisabledWithChildren": {},
  "reason.pluginUnconfirmed": {},
  "reason.pluginDisabled": {},
  "reason.uniqueCacheEnabled": {},
  "reason.cacheUnconfirmed": {},
  "reason.pluginContentMissing": {},
  "reason.projectMcpApproval": {},
  "reason.projectMcpDisabled": {},
  "reason.projectMcpApproved": {},
  "reason.personalPrecedence": {},
  "reason.compatibilityDirectory": {},
  "reason.projectTrust": {},
  "reason.skillDisabled": {},
  "errors.invalidProject": {},
  "errors.notDirectory": {},
  "errors.pathNotFound": {},
  "errors.permissionDenied": {},
  "errors.symlinkLoop": {},
  "errors.fileUnreadable": {
    "limitMB": "number"
  },
  "errors.localOnly": {},
  "errors.originForbidden": {},
  "errors.sessionExpired": {},
  "errors.invalidRequest": {},
  "errors.payloadTooLarge": {},
  "errors.unsupportedContentType": {},
  "errors.notFound": {},
  "errors.operationFailed": {},
  "errors.connectionFailed": {},
  "errors.requestFailed": {},
  "errors.invalidResponse": {},
  "errors.invalidSender": {},
  "errors.directoryPicker": {},
  "errors.resourceNotFound": {},
  "errors.revealFailed": {}
} as const;

export type MessageCode = keyof typeof messageParameters;
type ParametersFor<C extends MessageCode> = {
  [K in keyof typeof messageParameters[C]]: typeof messageParameters[C][K] extends 'number' ? number : string;
};
export type Message = { [C in MessageCode]: { code: C; params: ParametersFor<C> } }[MessageCode];
// Strings are accepted for legacy snapshots and external adapters, and displayed verbatim.
export type MessageText = Message | string;

export function message<C extends MessageCode>(code: C, ...args: keyof ParametersFor<C> extends never ? [] : [ParametersFor<C>]): Extract<Message, { code: C }> {
  return { code, params: args[0] ?? {} } as Extract<Message, { code: C }>;
}

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const { code, params } = value as { code?: unknown; params?: unknown };
  if (typeof code !== 'string' || !Object.hasOwn(messageParameters, code) || !params || typeof params !== 'object' || Array.isArray(params)) return false;
  const expected = messageParameters[code as MessageCode];
  return Object.keys(params).length === Object.keys(expected).length && Object.entries(expected).every(([key, type]) =>
    Object.hasOwn(params, key) && typeof (params as Record<string, unknown>)[key] === type && (type !== 'number' || Number.isFinite((params as Record<string, unknown>)[key])));
}

export class InventoryError extends Error {
  constructor(public readonly detail: MessageText) {
    super(typeof detail === 'string' ? detail : detail.code);
    this.name = 'InventoryError';
  }
}

export function errorMessage(error: unknown, fallback: Message = message('errors.operationFailed')): MessageText {
  if (error instanceof InventoryError) return error.detail;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENOENT': return message('errors.pathNotFound');
    case 'ENOTDIR': return message('errors.notDirectory');
    case 'EACCES': case 'EPERM': return message('errors.permissionDenied');
    case 'ELOOP': return message('errors.symlinkLoop');
    default: return fallback;
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: MessageText };

// Electron only reliably transports Error.message on rejected invokes. Use an explicit envelope.
export async function captureResult<T>(operation: () => T | Promise<T>, fallback?: Message): Promise<Result<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: errorMessage(error, fallback) }; }
}

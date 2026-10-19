export type AgentId = 'claude' | 'codex';
export type Kind = 'skill' | 'plugin' | 'mcp' | 'subagent';
export type Status = 'available' | 'disabled' | 'shadowed' | 'conditional' | 'invalid' | 'unknown';
export type Scope = 'user' | 'project' | 'system';
export interface Binding {
  id: string; agent: AgentId; scope: Scope; path: string; status: Status;
  reason: string; plugin?: string; configPath?: string; appliesTo?: string;
}
export interface Resource {
  id: string; kind: Kind; name: string; description: string;
  path: string; version?: string; content: string; metadata: Record<string, unknown>;
  bindings: Binding[];
}
export interface Diagnostic { agent?: AgentId; path: string; message: string }
export interface AgentEnvironment { id: AgentId; name: string; configFound: boolean; executableFound: boolean }
export interface Snapshot {
  id: string; project: string | null; scannedAt: string; durationMs: number;
  resources: Resource[]; diagnostics: Diagnostic[]; agents: AgentEnvironment[];
}
export interface DirectoryListing { path: string; parent: string | null; entries: { name: string; path: string }[] }
export interface InventoryClient {
  scan(project?: string): Promise<Snapshot>;
  directories(path?: string): Promise<DirectoryListing>;
  chooseDirectory?(): Promise<string | null>;
  reveal?(id: string): Promise<void>;
}

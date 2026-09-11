import type { FileAction, FileResults } from "./files";
import type { Draft, DraftInput, DraftSummary } from "./drafts";
import type { Settings } from "./settings";
import type { EnvProfile } from "./env-profiles";
import type { Hook } from "./hooks";
import type { LaunchRecord, SessionMetadata } from "./models";
import type { DomainEvent, StopPolicy } from "./events";
import type { Failure } from "./errors";
export type { EnvProfile, Hook, SessionMetadata };
export interface Preset {
  id: string;
  name: string;
  command: string;
}
export interface LaunchRequest {
  command?: string;
  presetId?: string;
  label?: string;
  count?: number;
  cwd?: string;
  savePresetAs?: string;
  idempotencyKey?: string;
  envProfileId?: string;
  env?: Record<string, string>;
  promptAnchors?: string[];
  metadata?: Record<string, string>;
  originHookId?: string;
}
export interface LaunchResult extends Snapshot {
  launchId?: string;
  terminalIds: string[];
  launchErrors: { terminalId: string; error: string }[];
}
export interface TerminalRecord {
  id: string;
  label: string;
  cwd: string;
  command: string;
  createdAt: string;
  deleting?: boolean;
  deletionPolicy?: StopPolicy;
  launchError?: string;
  startedAt?: string;
  endedAt?: string;
  exitCode?: number;
  exitSignal?: string;
  metadata?: Record<string, string>;
  env?: Record<string, string>;
  envProfileId?: string;
  promptAnchors?: string[];
  launchState?: "starting" | "running" | "cancelled" | "failed";
  originHookId?: string;
}
export interface SessionRecord {
  id: string;
  name: string;
  directory: string;
  identity: string;
  createdAt: string;
  terminals: TerminalRecord[];
  deleting?: boolean;
  metadata?: SessionMetadata;
  deletionPolicy?: StopPolicy;
}
export interface State {
  version: 2;
  sessions: SessionRecord[];
  presets: Preset[];
  envProfiles: EnvProfile[];
  hooks: Hook[];
  launches: LaunchRecord[];
}
export interface TerminalView extends TerminalRecord {
  status: Extract<DomainEvent, {type: "terminal-status"}>["data"]["status"];
  pid?: number;
  process?: string;
  currentDirectory?: string;
  exitCode?: number;
}
export interface SessionView extends Omit<SessionRecord, "terminals"> {
  terminals: TerminalView[];
}
export interface Snapshot {
  sequence: number;
  sessions: SessionView[];
  presets: Preset[];
  engineError?: string;
  engineFailure?: Failure;
  envProfiles?: EnvProfile[];
  hooks?: Hook[];
  launches?: LaunchRecord[];
}
export type { FileEntry, FilePreview, FileAction } from "./files";
export interface API {
  getSettings(): Promise<Settings>;
  listDrafts(): Promise<DraftSummary[]>;
  readDraft(id: string): Promise<Draft>;
  saveDraft(input: DraftInput): Promise<DraftSummary>;
  removeDraft(id: string): Promise<void>;
  snapshot(): Promise<Snapshot>;
  chooseDirectory(): Promise<string | null>;
  createSession(name: string, directory: string): Promise<Snapshot>;
  renameSession(id: string, name: string): Promise<Snapshot>;
  deleteSession(id: string): Promise<Snapshot>;
  createTerminals(
    sessionId: string,
    presetId: string,
    count: number,
    cwd: string,
  ): Promise<Snapshot>;
  launchTerminals(
    sessionId: string,
    request: LaunchRequest,
  ): Promise<LaunchResult>;
  renameTerminal(
    sessionId: string,
    terminalId: string,
    label: string,
  ): Promise<Snapshot>;
  deleteTerminal(sessionId: string, terminalId: string): Promise<Snapshot>;
  savePresets(presets: Preset[]): Promise<Snapshot>;
  files<A extends FileAction>(sessionId: string, request: A): Promise<FileResults[A["action"]]>;
  attach(terminalId: string, cols: number, rows: number): Promise<string>;
  detach(token: string): Promise<void>;
  input(token: string, data: string): void;
  resize(token: string, cols: number, rows: number): void;
  acknowledge(token: string, bytes: number): void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  onOutput(listener: (token: string, data: string) => void): () => void;
  onExit(listener: (token: string) => void): () => void;
  onStartupRecovered(listener: (message: string) => void): () => void;
}
declare global {
  interface Window {
    minimal: API;
  }
}

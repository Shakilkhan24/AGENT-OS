import type { FileAction, FileResults } from "./files";
import type { Draft, DraftInput, DraftSummary } from "./drafts";
import type { Settings } from "./settings";
import type { EnvProfile } from "./env-profiles";
import type { Hook } from "./hooks";
import type { LaunchRecord, SessionMetadata } from "./models";
import type { DomainEvent, StopPolicy } from "./events";
import type { Failure } from "./errors";
import type { Result } from "./protocol";
import type { ManagedProjectionOrUnavailable } from "./managed-view";
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
  /**
   * M3c.1 — opt-in projection of M3a/M3b entities onto the snapshot.
   * Undefined when the runtime is degraded, the DB driver is opted-out,
   * or the projection itself can't be built for some other reason. The
   * renderer treats `undefined` as "managed work unavailable" and
   * switches to the existing M2 surface.
   */
  managed?: ManagedProjectionOrUnavailable;
}
export type { FileEntry, FilePreview, FileAction } from "./files";
export interface API {
  getAppInfo(): Promise<Result<"hello">>;
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
  input(token: string, data: string): Promise<{ admitted: number }>;
  cancelInput(token: string): Promise<{ dropped: number }>;
  resize(token: string, cols: number, rows: number): void;
  acknowledge(token: string, bytes: number): void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  /** M1.6: explicitly terminate the runtime child. Window close does not do this. */
  stopRuntime(): Promise<{ accepted: boolean }>;
  onOutput(listener: (token: string, data: string) => void): () => void;
  onExit(listener: (token: string) => void): () => void;
  onStartupRecovered(listener: (message: string) => void): () => void;
  onProtocolFailure(listener: (failure: Failure) => void): () => void;
  onWorkspaceChanged(listener: () => void): () => void;
  /**
   * M3c.2 — run the verifier for `taskId` against `recipeId` (or a one-off
   * command override). Returns the freshly minted `verificationId` and
   * `reviewId` on success, or a `conflict` reason when the task / workspace
   * is missing. The renderer's "Approve and run verifier" button is the only
   * legitimate caller today.
   */
  executeVerification(
    taskId: string,
    recipeId: string | null,
    override?: { command: string; argv?: string[]; env?: Record<string, string> } | null,
  ): Promise<
    | { kind: "ok"; verificationId: string; reviewId: string }
    | { kind: "conflict"; reason: string }
  >;
  /**
   * M3c.2 — accept or reject an open review. Acceptance requires every
   * backing verification to be `passed` AND every required check to be
   * `passed`; rejection is always allowed. Both paths return the
   * post-transition status.
   */
  recordReviewDecision(
    reviewId: string,
    decision: "accept" | "reject",
    decidedBy: string,
  ): Promise<
    | { kind: "ok"; reviewId: string; status: "accepted" | "rejected" | "open" | "invalidated" }
    | { kind: "conflict"; reason: string }
  >;
  /**
   * M3c.3 — flip an attention item to a new state. The single
   * state-transition seam (`snooze-attention` writes the deadline
   * atomically with the FSM flip). Returns the updated item view.
   */
  transitionAttention(
    id: string,
    to: "seen" | "snoozed" | "dismissed" | "resolved",
  ): Promise<{
    id: string; taskId: string | null; kind: "decision" | "conflict" | "review" | "stop";
    issueIdentity: string; revision: number;
    state: "new" | "seen" | "snoozed" | "dismissed" | "resolved";
    payloadJson: string; snoozedUntil: string | null;
    createdAt: string; updatedAt: string;
  }>;
  /**
   * M3c.3 — write the durable snooze deadline AND transition to
   * `snoozed` atomically. The runtime widens `new → seen` so the
   * renderer doesn't have to issue two calls.
   */
  snoozeAttention(
    id: string,
    until: string,
  ): Promise<{
    id: string; taskId: string | null; kind: "decision" | "conflict" | "review" | "stop";
    issueIdentity: string; revision: number;
    state: "new" | "seen" | "snoozed" | "dismissed" | "resolved";
    payloadJson: string; snoozedUntil: string | null;
    createdAt: string; updatedAt: string;
  }>;
  /**
   * M3c.3 — bounded artifact read. Requires an approved grant for
   * `(principal, sha256)` whose scope includes the artifact's kind;
   * the body is capped at 8 KiB. `truncated: true` indicates the
   * caller should re-fetch via a different path (M3c.4 wires that).
   */
  previewArtifact(
    id: string,
    principal: string,
    scopeJson?: string | null,
  ): Promise<{
    id: string; sha256: string; mime: string; bytes: number;
    truncated: boolean; truncatedBase64Content: string;
  }>;
  /**
   * M3c.4 — render the unified diff for a run's candidate. The
   * runtime shells out to `git diff` inside the run's worktree and
   * applies a 256 KiB cap. `truncated: true` means the diff overshot
   * the cap; the body is still bounded. The renderer surfaces a
   * "open the workspace" notice alongside.
   */
  renderCandidateDiff(runId: string): Promise<{
    runId: string; base: string; tree: string;
    bytes: number; truncated: boolean; body: string;
  }>;
}
declare global {
  interface Window {
    minimal: API;
  }
}

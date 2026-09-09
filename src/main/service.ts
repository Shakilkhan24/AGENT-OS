import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nameSchema, presetSchema, sessionMetadataSchema } from "../shared/models";
import { envProfileSchema } from "../shared/env-profiles";
import { hookSchema } from "../shared/hooks";
import { defaultSettings, type Settings } from "../shared/settings";
import { AppError, asFailure } from "../shared/errors";
import { stopPolicySchema, type StopPolicy } from "../shared/events";
import type { EngineAdapter } from "../shared/engine";
import type { FileAction, Preset, LaunchRequest, LaunchResult, SessionMetadata, EnvProfile, Hook } from "../shared/types";
import { Store } from "./store";
import { SessionFilesystem } from "./filesystem";
import { WorkspaceState, findSession, findTerminal } from "./workspace-state";
import { EventBus } from "./event-bus";
import { Reconciler } from "./reconciler";
import { LaunchCoordinator } from "./launch-coordinator";
import { StopCoordinator } from "./stop-coordinator";
import { log } from "./logging";

/** Public application facade; focused services own persistence, launch and engine observation. */
export class SessionService {
  readonly state: WorkspaceState;
  readonly events: EventBus;
  readonly reconciliation: Reconciler;
  readonly launches: LaunchCoordinator;
  private stops: StopCoordinator;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  constructor(store: Store, readonly engine: EngineAdapter, readonly filesystem: SessionFilesystem,
    private settings: Settings = defaultSettings) {
    this.state = new WorkspaceState(store);
    this.events = new EventBus(store.directory, settings.eventReplayLimit);
    this.reconciliation = new Reconciler(this.state, engine, this.events);
    const changed = () => this.reconciliation.invalidate();
    this.launches = new LaunchCoordinator(this.state, engine, filesystem, this.events, changed);
    this.stops = new StopCoordinator(this.state, engine, this.events, filesystem, this.launches, changed);
  }
  async initialize() {
    await this.state.initialize();
    await this.events.initialize();
    await this.engine.initialize();
    await this.launches.recover();
    await this.stops.recover();
  }
  start() {
    if (this.timer) return;
    const refresh = () => { void this.snapshot().catch(error => {
      log({ level: "error", source: "reconciliation", event: "refresh-failed", fields: { code: asFailure(error).code } });
    }); };
    this.unsubscribe = this.engine.onChange?.(refresh);
    this.timer = setInterval(refresh, this.settings.pollIntervalMs); this.timer.unref();
    refresh();
  }
  close() {
    clearInterval(this.timer); this.timer = undefined;
    this.unsubscribe?.(); this.engine.close?.(); this.launches.close();
  }
  snapshot() { return this.reconciliation.snapshot(); }
  async createSession(name: string, directory: string) {
    name = nameSchema.parse(name); directory = z.string().min(1).max(4096).parse(directory);
    const id = randomUUID();
    const binding = await this.filesystem.register(id, directory);
    try { await this.state.update(state => {
      state.sessions.push({ id, name, ...binding, createdAt: new Date().toISOString(), terminals: [], metadata: sessionMetadataSchema.parse({}) });
    }); } catch (error) { await this.filesystem.unregister(id); throw error; }
    await this.events.publish({ type: "session-changed", sourceId: "sessions", sessionId: id, data: { action: "created" } });
    return this.snapshot();
  }
  async renameSession(id: string, name: string) {
    name = nameSchema.parse(name);
    await this.state.update(state => { findSession(state, id).name = name; });
    await this.events.publish({ type: "session-changed", sourceId: "sessions", sessionId: id, data: { action: "updated" } });
    return this.snapshot();
  }
  async updateSessionMetadata(id: string, metadata: SessionMetadata) {
    metadata = sessionMetadataSchema.parse(metadata);
    await this.state.update(state => { findSession(state, id).metadata = metadata; });
    await this.events.publish({ type: "session-changed", sourceId: "sessions", sessionId: id, data: { action: "updated" } });
    return this.snapshot();
  }
  async deleteSession(id: string, policy: StopPolicy = "graceful") {
    await this.stops.session(id, stopPolicySchema.parse(policy));
    return this.snapshot();
  }
  createTerminals(sessionId: string, presetId: string, count: number, cwd: string) {
    return this.launchTerminals(sessionId, { presetId, count, cwd });
  }
  beginLaunch(sessionId: string, request: LaunchRequest) { return this.launches.begin(sessionId, request); }
  cancelLaunch(id: string) { return this.launches.cancel(id); }
  async launchTerminals(sessionId: string, request: LaunchRequest): Promise<LaunchResult> {
    const initial = await this.beginLaunch(sessionId, request);
    const record = await this.launches.wait(initial.id);
    return { ...(await this.snapshot()), launchId: record.id, terminalIds: record.terminalIds, launchErrors: record.errors };
  }
  async renameTerminal(sessionId: string, terminalId: string, label: string) {
    label = nameSchema.parse(label);
    await this.state.update(state => { findTerminal(state, sessionId, terminalId).label = label; });
    return this.snapshot();
  }
  async deleteTerminal(sessionId: string, terminalId: string, policy: StopPolicy = "graceful") {
    await this.stops.terminal(sessionId, terminalId, stopPolicySchema.parse(policy));
    return this.snapshot();
  }
  async savePresets(presets: Preset[]) {
    presets = z.array(presetSchema).min(1).max(100).parse(presets); this.unique(presets);
    await this.state.update(state => { state.presets = presets; });
    return this.snapshot();
  }
  async saveEnvProfiles(profiles: EnvProfile[]) {
    profiles = z.array(envProfileSchema).max(100).parse(profiles); this.unique(profiles);
    await this.state.update(state => { state.envProfiles = profiles; });
    return this.snapshot();
  }
  async saveHooks(hooks: Hook[]) {
    hooks = z.array(hookSchema).max(100).parse(hooks); this.unique(hooks);
    await this.state.update(state => { state.hooks = hooks; });
    return this.snapshot();
  }
  private unique(items: { id: string }[]) {
    if (new Set(items.map(item => item.id)).size !== items.length) throw new AppError("INVALID_REQUEST", "Record IDs must be unique");
  }
  files<A extends FileAction>(sessionId: string, request: A) { return this.filesystem.run(this.state.session(sessionId), request); }
  async requireTerminal(id: string) {
    const terminal = this.state.read().sessions.filter(s => !s.deleting).flatMap(s => s.terminals).find(t => t.id === id && !t.deleting);
    if (!terminal) throw new AppError("NOT_FOUND", "Terminal no longer exists");
    if (!(await this.engine.inspect()).has(id)) throw new AppError("NOT_FOUND", "This terminal is no longer running. Launch a new terminal to start work.");
    return terminal;
  }
}

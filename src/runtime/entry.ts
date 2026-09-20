/**
 * The runtime process entrypoint. Spawned by the desktop via
 * `helpers/runtime_lock.py` so it owns a stable OS lock and survives desktop
 * crashes. Validates argv, opens the runtime workspace, builds a ControlServer,
 * listens on the socket, and writes a 0600 `ready.json` next to the socket
 * containing the runtime's credential token. The desktop polls the ready file
 * and connects via `ControlClient` using the embedded token.
 *
 * argv: <socket-path> <data-dir> <runtime-dir> <helpers-dir>
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { Logger, configureLogging, log } from "../main/logging";
import { profilePaths } from "../main/profile-runtime";
import { prepareRuntimeStartup } from "./startup";
import { version as APP_VERSION } from "../../package.json";
import { AUTH_FRAME_BYTES, type RuntimeCredential } from "../shared/runtime-protocol";
import { ControlServer } from "./control-server";
import { RuntimeWorkspace } from "./workspace";

declare const process: NodeJS.Process & { env: Record<string, string | undefined> };


function fail(message: string, exitCode = 1): never {
  process.stderr.write(JSON.stringify({ code: "UNAVAILABLE", message }) + "\n");
  process.exit(exitCode);
}

async function main() {
  const socketPath = process.argv[2];
  const dataDir = process.argv[3];
  const runtimeDir = process.argv[4];
  const helpersDir = process.argv[5];
  if (!socketPath || !dataDir || !runtimeDir || !helpersDir)
    fail(`Missing arguments: <socket-path> <data-dir> <runtime-dir> <helpers-dir> required`);
  await prepareRuntimeStartup(dataDir, runtimeDir, socketPath);
  configureLogging(new Logger(path.join(dataDir, "logs", "runtime")));
  const workspace = await RuntimeWorkspace.open(dataDir, helpersDir, APP_VERSION);
  const credential: RuntimeCredential = {
    profileKey: profilePaths(dataDir).key,
    token: randomBytes(32).toString("hex"),
  };
  const server = new ControlServer(credential, workspace.incarnation, APP_VERSION,
    (peer, send) => workspace.connect(peer, send), 8, 3000);
  try {
    await server.listen(socketPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await workspace.close().catch(() => {});
    fail(message);
  }
  const readyPath = path.join(runtimeDir, "ready.json");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(readyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const payload = JSON.stringify({
      token: credential.token,
      incarnation: workspace.incarnation,
      socket: socketPath,
      appVersion: APP_VERSION,
      pid: process.pid,
      authFrameBytes: AUTH_FRAME_BYTES,
    });
    await handle.writeFile(payload);
    await handle.sync();
  } catch (error) {
    await server.close().catch(() => {});
    await workspace.close().catch(() => {});
    fail(`Could not write ready file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close();
  }
  log({ level: "info", source: "runtime-entry", event: "ready",
    fields: { socket: socketPath, pid: process.pid } });
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log({ level: "info", source: "runtime-entry", event: "stopping", fields: { signal } });
    await server.close().catch(() => {});
    await workspace.close().catch(() => {});
    try { await unlink(readyPath); } catch { /* already gone */ }
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  process.once("SIGINT", () => { void stop("SIGINT"); });
  process.once("SIGHUP", () => { void stop("SIGHUP"); });
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(JSON.stringify({ code: "UNAVAILABLE", message }) + "\n");
  process.exit(1);
});

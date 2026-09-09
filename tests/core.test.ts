import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  symlink,
  link,
  rm,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { Store } from "../src/main/store";
import { TmuxEngine } from "../src/main/engine";
import { SessionFilesystem } from "../src/main/filesystem";
import { SessionService } from "../src/main/service";
const helper = (name: string) => path.resolve("helpers", name);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForFile(file: string) {
  for (let i = 0; i < 200; i++) {
    const contents = await readFile(file, "utf8").catch(() => undefined);
    if (contents !== undefined) return contents;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${file}`);
}
async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-test-"));
  const root = path.join(base, "project");
  await mkdir(root);
  const store = new Store(path.join(base, "data"));
  const filesystem = new SessionFilesystem(helper("filesystem.py"));
  const engine = new TmuxEngine(store.directory, helper("pty_bridge.py"));
  const service = new SessionService(store, engine, filesystem);
  await service.initialize();
  const cleanup = async () => {
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    filesystem.close();
    await rm(base, { recursive: true, force: true });
  };
  return { base, root, store, filesystem, engine, service, cleanup };
}
test("sessions, bulk presets, independent working directories and reconciliation use live tmux state", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await mkdir(path.join(f.root, "nested"));
  const session = (await f.service.createSession("Project", f.root))
    .sessions[0];
  const preset = {
    id: randomUUID(),
    name: "Worker",
    command: 'printf "READY\\n"; sleep 120',
  };
  await f.service.savePresets([preset]);
  const launched = await f.service.createTerminals(
    session.id,
    preset.id,
    12,
    "nested",
  );
  assert.equal(launched.sessions[0].terminals.length, 12);
  assert.equal(
    new Set(launched.sessions[0].terminals.map((t) => t.pid)).size,
    12,
  );
  assert.ok(
    launched.sessions[0].terminals.every(
      (t) => t.status === "running" && t.cwd === path.join(f.root, "nested"),
    ),
  );
  assert.equal(launched.sessions[0].terminals[11].label, "Worker 12");
  const before = launched.sessions[0].terminals.map((t) => t.pid);
  const reopened = new SessionService(f.store, f.engine, f.filesystem);
  await reopened.initialize();
  assert.deepEqual(
    (await reopened.snapshot()).sessions[0].terminals.map((t) => t.pid),
    before,
  );
  const terminalId = launched.sessions[0].terminals[0].id;
  await reopened.renameSession(session.id, "Renamed");
  await reopened.renameTerminal(session.id, terminalId, "API server");
  assert.equal((await reopened.snapshot()).sessions[0].name, "Renamed");
  assert.equal(
    (await reopened.snapshot()).sessions[0].terminals[0].label,
    "API server",
  );
  await f.engine.remove(terminalId);
  assert.equal(
    (await reopened.snapshot()).sessions[0].terminals[0].status,
    "missing",
  );
  assert.equal((await f.engine.inspect()).size, 11);
  const started = performance.now();
  for (let i = 0; i < 5; i++) await reopened.snapshot();
  assert.ok(
    performance.now() - started < 3000,
    "12-terminal reconciliation stays responsive",
  );
  await reopened.deleteTerminal(session.id, terminalId);
  await reopened.deleteSession(session.id);
  assert.equal((await f.engine.inspect()).size, 0);
  assert.equal((await reopened.snapshot()).sessions.length, 0);
  assert.ok(await readFile(path.join(f.store.directory, "state.json"), "utf8"));
});
test("PTY attachment supports input, Unicode, resize, and leaves the process alive on detach", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Interactive", f.root))
    .sessions[0];
  const presetId = (await f.service.snapshot()).presets[0].id;
  const terminal = (
    await f.service.createTerminals(session.id, presetId, 1, "")
  ).sessions[0].terminals[0];
  let output = "";
  let exited = false;
  const attachment = f.engine.attach(
    terminal.id,
    80,
    24,
    (_token, data) => {
      output += data;
      attachment.acknowledge(data.length);
    },
    () => {
      exited = true;
    },
  );
  t.after(() => attachment.close());
  await delay(200);
  attachment.resize(101, 31);
  await attachment.input("printf 'UNICODE-λ-✓\\n'; stty size\r");
  for (let i = 0; i < 40 && !output.includes("31 101"); i++) await delay(50);
  assert.match(output, /UNICODE-λ-✓/);
  assert.match(output, /31 101/);
  assert.equal(exited, false);
  attachment.close();
  await delay(100);
  assert.equal((await f.engine.inspect()).get(terminal.id)?.pid, terminal.pid);
  assert.equal((await f.engine.inspect()).get(terminal.id)?.dead, false);
});
test("a fast command retains its exit code and is never rerun after restart", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Exit", f.root)).sessions[0];
  const preset = {
    id: randomUUID(),
    name: "Once",
    command: "echo once >> marker; exit 7",
  };
  await f.service.savePresets([preset]);
  await f.service.createTerminals(session.id, preset.id, 1, "");
  let terminal = (await f.service.snapshot()).sessions[0].terminals[0];
  for (let i = 0; i < 100 && terminal.status === "running"; i++) {
    await delay(50);
    terminal = (await f.service.snapshot()).sessions[0].terminals[0];
  }
  assert.equal(terminal.status, "exited");
  assert.equal(terminal.exitCode, 7);
  const reopened = new SessionService(f.store, f.engine, f.filesystem);
  await reopened.initialize();
  await reopened.snapshot();
  assert.equal(await readFile(path.join(f.root, "marker"), "utf8"), "once\n");
});
test("filesystem CRUD and containment reject traversal, links, special files and root mutation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Files", f.root)).sessions[0];
  const run = (request: any) => f.service.files(session.id, request);
  await writeFile(path.join(f.base, "outside"), "DO NOT CHANGE");
  await run({ action: "create", path: "folder", kind: "directory" });
  await run({ action: "create", path: "hello.txt", kind: "file" });
  await run({ action: "write", path: "hello.txt", content: "Hello λ\n" });
  assert.equal(await run({ action: "read", path: "hello.txt" }), "Hello λ\n");
  assert.equal(
    (await run({ action: "preview", path: "hello.txt" })).kind,
    "text",
  );
  await writeFile(
    path.join(f.root, "binary.dat"),
    Buffer.from([0, 255, 127, 10]),
  );
  assert.equal(
    (await run({ action: "preview", path: "binary.dat" })).kind,
    "binary",
  );
  await writeFile(
    path.join(f.root, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  assert.match(
    (await run({ action: "preview", path: "image.png" })).content,
    /^data:image\/png;base64,/,
  );
  await run({
    action: "move",
    path: "hello.txt",
    destination: "folder/renamed.txt",
  });
  await run({ action: "create", path: "exists", kind: "file" });
  await assert.rejects(
    run({ action: "move", path: "folder/renamed.txt", destination: "exists" }),
  );
  await symlink(f.base, path.join(f.root, "escape"));
  await symlink(
    path.join(f.base, "outside"),
    path.join(f.root, "external-link"),
  );
  await link(path.join(f.base, "outside"), path.join(f.root, "hard-link"));
  for (const relative of [
    "../outside",
    "/etc/passwd",
    "folder/../../outside",
    "escape/outside",
    "external-link",
    "hard-link",
  ]) {
    await assert.rejects(run({ action: "read", path: relative }), relative);
    await assert.rejects(
      run({ action: "write", path: relative, content: "BAD" }),
      relative,
    );
    await assert.rejects(run({ action: "preview", path: relative }), relative);
  }
  for (const relative of ["", ".", "/", "..", "escape/outside"])
    await assert.rejects(run({ action: "delete", path: relative }));
  await assert.rejects(
    run({ action: "create", path: "escape/new", kind: "file" }),
  );
  await assert.rejects(
    run({ action: "move", path: "exists", destination: "escape/outside" }),
  );
  await assert.rejects(
    f.service.createTerminals(
      session.id,
      (await f.service.snapshot()).presets[0].id,
      1,
      "../",
    ),
  );
  const entries = await run({ action: "list", path: "" });
  assert.equal(entries.find((e: any) => e.name === "escape").kind, "blocked");
  assert.equal(
    await readFile(path.join(f.base, "outside"), "utf8"),
    "DO NOT CHANGE",
  );
  await run({ action: "delete", path: "folder" });
  await assert.rejects(run({ action: "read", path: "folder/renamed.txt" }));
  await writeFile(path.join(f.root, "large"), "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(run({ action: "read", path: "large" }), /2 MiB/);
  assert.equal(
    (await run({ action: "preview", path: "large" })).kind,
    "binary",
  );
  execFileSync("mkfifo", [path.join(f.root, "pipe")]);
  await assert.rejects(
    run({ action: "preview", path: "pipe" }),
    /ordinary files/,
  );
  const machine = (
    await f.service.createSession("Mount boundary test", "/")
  ).sessions.at(-1)!;
  await assert.rejects(
    f.service.files(machine.id, { action: "read", path: "proc/version" }),
    /cross-device/i,
  );
  await f.filesystem.unregister(session.id);
  await rename(f.root, `${f.root}-old`);
  await mkdir(f.root);
  await assert.rejects(run({ action: "list", path: "" }), /replaced/);
});
test("write-ahead records and deletion tombstones recover without resurrecting work", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Recovery", f.root))
    .sessions[0];
  const state = await f.store.load();
  const pending = {
    id: randomUUID(),
    label: "Never launched",
    cwd: f.root,
    command: "touch should-not-exist",
    createdAt: new Date().toISOString(),
  };
  state.sessions[0].terminals.push(pending);
  await f.store.save(state);
  let service = new SessionService(f.store, f.engine, f.filesystem);
  await service.initialize();
  assert.equal(
    (await service.snapshot()).sessions[0].terminals[0].status,
    "missing",
  );
  await assert.rejects(readFile(path.join(f.root, "should-not-exist")));
  const terminal = (
    await service.createTerminals(session.id, state.presets[0].id, 1, "")
  ).sessions[0].terminals[1];
  const deleting = await f.store.load();
  deleting.sessions[0].deleting = true;
  await f.store.save(deleting);
  service = new SessionService(f.store, f.engine, f.filesystem);
  await service.initialize();
  assert.equal((await service.snapshot()).sessions.length, 0);
  assert.equal((await f.engine.inspect()).has(terminal.id), false);
});
test("a corrupt state file fails visibly and is preserved", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const file = path.join(f.store.directory, "state.json");
  await writeFile(file, "{broken");
  await assert.rejects(f.store.load(), /preserved/);
  assert.equal(await readFile(file, "utf8"), "{broken");
});
test("twelve independent sessions keep running while snapshots and file operations remain responsive", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const preset = (await f.service.snapshot()).presets[0];
  for (let i = 0; i < 12; i++) {
    const sessions = (await f.service.createSession(`Project ${i + 1}`, f.root))
      .sessions;
    await f.service.createTerminals(sessions.at(-1)!.id, preset.id, 1, "");
  }
  const start = performance.now();
  const snapshot = await f.service.snapshot();
  await Promise.all(
    snapshot.sessions.map((session) =>
      f.service.files(session.id, { action: "list", path: "" }),
    ),
  );
  assert.equal(snapshot.sessions.length, 12);
  assert.ok(
    snapshot.sessions.every(
      (session) => session.terminals[0].status === "running",
    ),
  );
  assert.equal(
    new Set(snapshot.sessions.map((session) => session.terminals[0].pid)).size,
    12,
  );
  assert.ok(performance.now() - start < 2000);
});
test("file operations work on the actual workspace filesystem, including WSL Windows mounts", async (t) => {
  const root = await mkdtemp(path.join(process.cwd(), ".minimal-fs-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Mounted project", root))
    .sessions[0];
  const run = (request: any) => f.service.files(session.id, request);
  await run({ action: "create", path: "example.txt", kind: "file" });
  await run({
    action: "write",
    path: "example.txt",
    content: "Mounted filesystem works.",
  });
  await run({
    action: "move",
    path: "example.txt",
    destination: "renamed.txt",
  });
  assert.equal(
    await run({ action: "read", path: "renamed.txt" }),
    "Mounted filesystem works.",
  );
  await run({ action: "create", path: "folder", kind: "directory" });
  await run({
    action: "move",
    path: "renamed.txt",
    destination: "folder/example.txt",
  });
  await run({ action: "move", path: "folder", destination: "renamed-folder" });
  await run({ action: "create", path: "existing", kind: "directory" });
  await assert.rejects(
    run({ action: "move", path: "renamed-folder", destination: "existing" }),
  );
  await run({ action: "create", path: "renamed.txt", kind: "file" });
  await assert.rejects(
    run({
      action: "move",
      path: "renamed-folder/example.txt",
      destination: "renamed.txt",
    }),
  );
  assert.equal(
    await run({ action: "read", path: "renamed-folder/example.txt" }),
    "Mounted filesystem works.",
  );
  await run({ action: "delete", path: "renamed.txt" });
});

test("direct commands launch in batches, save reusable presets and close independently", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Direct", f.root)).sessions[0];
  const command = "printf ready > worker-$$; sleep 120";
  const batch = await f.service.launchTerminals(session.id, {
    command,
    count: 6,
    label: "Agent",
    savePresetAs: "My agent",
  });
  assert.equal(batch.terminalIds.length, 6);
  assert.deepEqual(batch.launchErrors, []);
  const saved = batch.presets.find((p) => p.name === "My agent")!;
  assert.equal(saved.command, command);
  const added = await f.service.launchTerminals(session.id, {
    presetId: saved.id,
  });
  assert.equal(added.sessions[0].terminals.length, 7);
  assert.equal(added.sessions[0].terminals.at(-1)?.label, "My agent 1");
  assert.ok(added.sequence > batch.sequence);
  const removed = await f.service.deleteTerminal(
    session.id,
    batch.terminalIds[2],
  );
  assert.deepEqual(
    removed.sessions[0].terminals.map((t) => t.pid),
    added.sessions[0].terminals
      .filter((t) => t.id !== batch.terminalIds[2])
      .map((t) => t.pid),
  );
  const reopened = new SessionService(f.store, f.engine, f.filesystem);
  await reopened.initialize();
  assert.equal(
    (await reopened.snapshot()).presets.find((p) => p.id === saved.id)?.command,
    command,
  );
  for (const request of [
    { command, count: 0 },
    { command, count: 33 },
    { command: "bad\0command" },
    { command, cwd: "../" },
    {},
  ]) {
    await assert.rejects(f.service.launchTerminals(session.id, request));
  }
  assert.equal((await f.service.snapshot()).sessions[0].terminals.length, 6);
});

test("a partial launch preserves failed records while starting the remaining commands", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Partial", f.root))
    .sessions[0];
  const create = f.engine.create.bind(f.engine);
  let calls = 0;
  f.engine.create = async (terminal) => {
    if (++calls === 2) throw new Error("Simulated launch failure");
    return create(terminal);
  };
  const result = await f.service.launchTerminals(session.id, {
    command: "sleep 120",
    count: 3,
  });
  assert.equal(calls, 3);
  assert.equal(result.launchErrors.length, 1);
  assert.deepEqual(
    result.sessions[0].terminals.map((t) => t.status),
    ["running", "missing", "running"],
  );
  assert.match(result.sessions[0].terminals[1].launchError!, /Simulated/);
  const reopened = new SessionService(f.store, f.engine, f.filesystem);
  await reopened.initialize();
  assert.match(
    (await reopened.snapshot()).sessions[0].terminals[1].launchError!,
    /Simulated/,
  );
  assert.equal(calls, 3, "reopening never replays commands");
});

test("temporary engine failures preserve workspace metadata and recover on the next snapshot", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Recovery", f.root))
    .sessions[0];
  const before = await f.service.launchTerminals(session.id, {
    command: "sleep 120",
  });
  const inspect = f.engine.inspect.bind(f.engine);
  f.engine.inspect = async () => {
    throw new Error("Temporary connection failure");
  };
  const unavailable = await f.service.snapshot();
  f.engine.inspect = inspect;
  assert.equal(unavailable.sessions[0].id, session.id);
  assert.equal(unavailable.sessions[0].terminals[0].id, before.terminalIds[0]);
  assert.equal(unavailable.sessions[0].terminals[0].status, "unknown");
  assert.match(unavailable.engineError!, /Temporary/);
  const recovered = await f.service.snapshot();
  assert.equal(recovered.engineError, undefined);
  assert.equal(
    recovered.sessions[0].terminals[0].pid,
    before.sessions[0].terminals[0].pid,
  );
  assert.ok(
    recovered.sequence > unavailable.sequence &&
      unavailable.sequence > before.sequence,
  );
});

test("a file helper crash reconnects on the next operation and rechecks the root identity", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const session = (await f.service.createSession("Files", f.root)).sessions[0];
  await f.service.files(session.id, {
    action: "create",
    path: "kept.txt",
    kind: "file",
  });
  const stopHelper = async () => {
    const child = (f.filesystem as any).child;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  await stopHelper();
  const entries = await f.service.files(session.id, {
    action: "list",
    path: "",
  });
  assert.ok(
    entries.some((entry: { name: string }) => entry.name === "kept.txt"),
  );
  await stopHelper();
  await rename(f.root, `${f.root}-old`);
  await mkdir(f.root);
  await assert.rejects(
    f.service.files(session.id, { action: "list", path: "" }),
    /replaced/,
  );
});

test(
  "large terminal input arrives intact while the PTY continues delivering output",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const payload = "abc0123456789λ✓".repeat(80000);
    const size = Buffer.byteLength(payload);
    await writeFile(
      path.join(f.root, "receive.py"),
      `import os, tty, hashlib\ntty.setraw(0)\nopen('ready', 'w').close()\nremaining = ${size}\ndigest = hashlib.sha256()\nwhile remaining:\n    data = os.read(0, min(65536, remaining))\n    digest.update(data)\n    remaining -= len(data)\n    os.write(1, b'.')\nopen('received', 'w').write(digest.hexdigest())\n`,
    );
    const session = (await f.service.createSession("Paste", f.root))
      .sessions[0];
    const terminal = (
      await f.service.launchTerminals(session.id, {
        command: "python3 receive.py",
      })
    ).sessions[0].terminals[0];
    await waitForFile(path.join(f.root, "ready"));
    let output = "";
    const attachment = f.engine.attach(
      terminal.id,
      80,
      24,
      (_token, data) => {
        output += data;
        attachment.acknowledge(data.length);
      },
      () => {},
    );
    t.after(() => attachment.close());
    await delay(150);
    for (let offset = 0; offset < payload.length; offset += 16384)
      await attachment.input(payload.slice(offset, offset + 16384));
    assert.equal(
      await waitForFile(path.join(f.root, "received")),
      createHash("sha256").update(payload).digest("hex"),
    );
    assert.ok(output.includes("."));
  },
);

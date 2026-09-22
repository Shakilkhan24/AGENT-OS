/**
 * M5.6 — env-profile + hook IPC tests.
 *
 * Coverage (7 focused tests):
 *  - saveEnvProfilesInputSchema rejects non-env-profile entries
 *  - saveEnvProfilesInputSchema accepts a single env profile
 *  - saveEnvProfilesInputSchema enforces min/max counts (1..100)
 *  - saveHooksInputSchema rejects non-Hook entries
 *  - saveHooksInputSchema accepts an empty hook list (zero is allowed)
 *  - saveHooksInputSchema enforces max 100 hooks
 *  - saveHooksInputSchema rejects a hook with unknown action.type
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  saveEnvProfilesInputSchema,
  saveHooksInputSchema,
} from "../../src/shared/workspace6-schema";

function envProfile(id = randomUUID()) {
  return { id, name: "default", variables: { FOO: "bar" } };
}
function hook(id = randomUUID()) {
  return { id, name: "on-create", enabled: true, event: "session-changed", action: { type: "notify", message: "hi" } };
}

test("saveEnvProfilesInputSchema rejects non-object entries", () => {
  assert.throws(() => saveEnvProfilesInputSchema.parse({ profiles: [123] }));
  assert.throws(() => saveEnvProfilesInputSchema.parse({ profiles: ["foo"] }));
});

test("saveEnvProfilesInputSchema accepts a single env profile", () => {
  const out = saveEnvProfilesInputSchema.parse({ profiles: [envProfile()] });
  assert.equal(out.profiles.length, 1);
});

test("saveEnvProfilesInputSchema rejects > 100 profiles", () => {
  const tooMany = Array.from({ length: 101 }, () => envProfile());
  assert.throws(() => saveEnvProfilesInputSchema.parse({ profiles: tooMany }));
});

test("saveEnvProfilesInputSchema rejects 'profiles' as missing", () => {
  assert.throws(() => saveEnvProfilesInputSchema.parse({}));
});

test("saveHooksInputSchema rejects non-Hook entries", () => {
  assert.throws(() => saveHooksInputSchema.parse({ hooks: [{ id: "1" }] }));
});

test("saveHooksInputSchema accepts an empty hooks list (zero is allowed)", () => {
  const out = saveHooksInputSchema.parse({ hooks: [] });
  assert.equal(out.hooks.length, 0);
});

test("saveHooksInputSchema rejects > 100 hooks", () => {
  const tooMany = Array.from({ length: 101 }, () => hook());
  assert.throws(() => saveHooksInputSchema.parse({ hooks: tooMany }));
});

test("saveHooksInputSchema rejects a hook with an unknown action.type", () => {
  assert.throws(() => saveHooksInputSchema.parse({
    hooks: [{ id: randomUUID(), name: "h", enabled: true, event: "session-changed", action: { type: "delete-everything" } }],
  }));
});

test("saveHooksInputSchema accepts a minimal valid hook", () => {
  const out = saveHooksInputSchema.parse({ hooks: [hook()] });
  assert.equal(out.hooks.length, 1);
  assert.equal(out.hooks[0].action.type, "notify");
});

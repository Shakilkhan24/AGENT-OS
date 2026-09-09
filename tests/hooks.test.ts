import test from "node:test";
import assert from "node:assert/strict";
import { hookSchema } from "../src/shared/hooks";
test("hook definitions are disabled by default and restricted to supported actions", () => {
  const hook = {
    id: crypto.randomUUID(),
    name: "Finished",
    event: "terminal-status",
    action: { type: "notify", message: "Done" },
  };
  assert.equal(hookSchema.parse(hook).enabled, false);
  assert.throws(() =>
    hookSchema.parse({ ...hook, action: { type: "schedule", at: "tomorrow" } }),
  );
  assert.throws(() =>
    hookSchema.parse({
      ...hook,
      action: { type: "open-file", path: "../outside" },
    }),
  );
});

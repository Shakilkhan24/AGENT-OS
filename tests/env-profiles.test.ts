import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveEnvironment,
  envProfileSchema,
} from "../src/shared/env-profiles";
test("environment precedence is explicit and reserved engine keys cannot be overridden", () => {
  const profile = envProfileSchema.parse({
    id: crypto.randomUUID(),
    name: "Development",
    variables: { A: "profile", B: "profile" },
  });
  assert.deepEqual(
    resolveEnvironment(
      { A: "inherited", C: "inherited", TMUX: "foreign", D: undefined },
      profile,
      { B: "launch" },
    ),
    { A: "profile", B: "launch", C: "inherited" },
  );
  assert.throws(() =>
    resolveEnvironment({}, undefined, { TMUX_TMPDIR: "/elsewhere" }),
  );
  assert.throws(() =>
    resolveEnvironment({}, undefined, { VALUE: "bad\0value" }),
  );
});

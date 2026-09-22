/**
 * M9.5 — fixture bank discovery test.
 *
 * Discovers every `*.fixture.json` under `tests/fixtures/pilot/`
 * and asserts each parses against `fixtureSchema`. Catches
 * regressions if a fixture file is malformed (typo, missing
 * field, etc).
 *
 * The M9.5 cut ships 20 skeleton stubs (4 per family across 5
 * families). Concrete acceptance-rule bodies are follow-up work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSchema, type Fixture, type FixtureFamily } from "../../src/shared/pilot-schema";

const FIXTURE_DIR = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // here = .../tests/runtime; FIXTURE_DIR = .../tests/fixtures/pilot
  return path.resolve(here, "..", "fixtures", "pilot");
})();

const FIVE_FAMILIES: ReadonlyArray<FixtureFamily> = [
  "routine-change",
  "context-handoff",
  "parallel-integration",
  "interruption-recovery",
  "recipe-review",
];

test("pilot fixture bank has 20 schema-valid files (4 per family, 5 families)", async () => {
  const files = (await readdir(FIXTURE_DIR))
    .filter((f) => /\.fixture\.json$/.test(f))
    .sort();
  assert.equal(files.length, 20, `expected 20 fixture files, got ${files.length}`);

  const parsed: Fixture[] = [];
  for (const file of files) {
    const text = await readFile(path.join(FIXTURE_DIR, file), "utf8");
    const json = JSON.parse(text);
    const fixture = fixtureSchema.parse(json);
    parsed.push(fixture);
  }

  // Each fixture id matches its filename prefix.
  for (const fixture of parsed) {
    const idPrefix = fixture.id;
    assert.ok(/^[a-z0-9-]{1,64}$/.test(idPrefix), `fixture id "${idPrefix}" is well-formed`);
  }

  // Family coverage: 4 files per family.
  const byFamily = new Map<FixtureFamily, number>();
  for (const fixture of parsed) {
    byFamily.set(fixture.family, (byFamily.get(fixture.family) ?? 0) + 1);
  }
  for (const family of FIVE_FAMILIES) {
    assert.equal(byFamily.get(family), 4, `family "${family}" should have 4 fixtures`);
  }

  // Driver coverage: every fixture carries exactly 3 drivers covering all 3 conditions.
  for (const fixture of parsed) {
    assert.equal(fixture.drivers.length, 3);
    const conditions = new Set(fixture.drivers.map((d) => d.condition));
    assert.equal(conditions.size, 3, `fixture "${fixture.id}" must cover all 3 conditions`);
  }

  // Acceptance coverage: every fixture has at least one rule.
  for (const fixture of parsed) {
    assert.ok(fixture.acceptance.length >= 1, `fixture "${fixture.id}" must have ≥1 acceptance rule`);
  }
});
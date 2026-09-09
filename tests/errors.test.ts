import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError, asFailure, failureSchema } from "../src/shared/errors";
test("structured failures retain uncertainty and do not echo invalid request values", () => {
  const id = crypto.randomUUID();
  const result = asFailure(
    new AppError("TIMEOUT", "File request timed out", { outcomeUnknown: true }),
    "files",
    id,
  );
  assert.equal(result.correlationId, id);
  assert.equal(result.outcomeUnknown, true);
  const invalid = z.number().safeParse("private input");
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.equal(
      asFailure(invalid.error).message,
      "Invalid request or saved data",
    );
  assert.throws(() => failureSchema.parse({ ...result, code: "bad" }));
});

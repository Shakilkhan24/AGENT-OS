import { z } from "zod";

export const failureSchema = z.object({
  code: z.enum([
    "INVALID_REQUEST",
    "NOT_FOUND",
    "CONFLICT",
    "CANCELLED",
    "TIMEOUT",
    "BUSY",
    "UNAVAILABLE",
    "VERSION_MISMATCH",
    "IO_ERROR",
    "INTERNAL",
  ]),
  message: z.string().max(4096),
  sourceId: z.string().max(200),
  correlationId: z.string().uuid(),
  retryable: z.boolean(),
  outcomeUnknown: z.boolean().default(false),
});
export type Failure = z.infer<typeof failureSchema>;
export class AppError extends Error {
  readonly failure: Failure;
  constructor(
    code: Failure["code"],
    message: string,
    options: Partial<Omit<Failure, "code" | "message">> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.failure = failureSchema.parse({
      code,
      message,
      sourceId: "application",
      correlationId: crypto.randomUUID(),
      retryable: false,
      ...options,
    });
  }
}
export function asFailure(
  error: unknown,
  sourceId = "application",
  correlationId = crypto.randomUUID(),
): Failure {
  if (error instanceof AppError)
    return { ...error.failure, sourceId, correlationId };
  return {
    code: error instanceof z.ZodError ? "INVALID_REQUEST" : "INTERNAL",
    message: (error instanceof z.ZodError
      ? "Invalid request or saved data"
      : error instanceof Error
        ? error.message
        : String(error)
    ).slice(0, 4096),
    sourceId,
    correlationId,
    retryable: false,
    outcomeUnknown: false,
  };
}

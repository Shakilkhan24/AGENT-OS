import { z } from "zod";
const owned = new Set(["TMUX", "TMUX_TMPDIR", "MINIMAL_TMUX_CONF"]);
export const environmentSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .refine((key) => !owned.has(key), "Reserved environment variable"),
    z
      .string()
      .max(8192)
      .refine((value) => !value.includes("\0")),
  )
  .refine(
    (value) => Object.keys(value).length <= 128,
    "Too many environment variables",
  )
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 65536,
    "Environment exceeds 64 KiB",
  );
export const envProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  variables: environmentSchema,
});
export type EnvProfile = z.infer<typeof envProfileSchema>;
/** Inherited environment < named profile < explicit launch overrides. Engine-owned keys are separate. */
export function resolveEnvironment(
  inherited: Record<string, string | undefined>,
  profile?: EnvProfile,
  overrides: Record<string, string> = {},
) {
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (pair): pair is [string, string] =>
        pair[1] !== undefined && !owned.has(pair[0]),
    ),
  );
  return {
    ...base,
    ...(profile ? environmentSchema.parse(profile.variables) : {}),
    ...environmentSchema.parse(overrides),
  };
}

import { z } from "zod";
import { failureSchema } from "./errors";
import { requestSchema, responseSchema, signalEnvelopeSchema } from "./protocol";

export const AUTH_FRAME_BYTES = 64 * 1024;
export const authenticationSchema = z.object({
  type: z.literal("authenticate"), apiVersion: z.number().int(),
  profileKey: z.string().regex(/^[a-f0-9]{20}$/), token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RuntimeCredential = Pick<z.infer<typeof authenticationSchema>, "profileKey" | "token">;
export const welcomeSchema = z.discriminatedUnion("ok", [
  z.object({ type: z.literal("welcome"), apiVersion: z.number().int(), ok: z.literal(true),
    incarnation: z.string().uuid(), appVersion: z.string().max(100) }).strict(),
  z.object({ type: z.literal("welcome"), apiVersion: z.number().int(), ok: z.literal(false), error: failureSchema }).strict(),
]);
export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request"), request: requestSchema }).strict(),
  z.object({ type: z.literal("cancel"), apiVersion: z.number().int(), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("signal"), name: z.enum(["resize", "acknowledge"]), envelope: signalEnvelopeSchema }).strict(),
]);
export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("response"), response: responseSchema }).strict(),
  z.object({ type: z.literal("signal"), name: z.enum(["workspace-changed", "terminal-output", "terminal-exit"]), envelope: signalEnvelopeSchema }).strict(),
]);
export type ClientSignal = Extract<z.infer<typeof clientMessageSchema>, { type: "signal" }>;
export type ServerSignal = Extract<z.infer<typeof serverMessageSchema>, { type: "signal" }>;
/** Scope is supplied by the authenticated server, never by an operation payload. */
export interface RuntimePeer {
  readonly connectionId: string;
  readonly profileKey: string;
  readonly principal: "desktop";
}

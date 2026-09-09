/** A useful default for arbitrary tools; callers can supply their own label. */
export function commandLabel(command: string): string {
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = first?.[1] || first?.[2] || first?.[3] || "";
  return (executable.split("/").at(-1) || "Shell").slice(0, 70);
}

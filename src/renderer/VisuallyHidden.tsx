/**
 * M9.3 — visually hidden helper.
 *
 * Used by the terminal status mirror and any future aria-live region.
 * The element occupies a 1px box but is invisible to sighted users, so
 * screen readers still announce its content updates.
 */
import type { ReactNode } from "react";

export function VisuallyHidden({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className="visually-hidden" {...rest}>
      {children}
    </span>
  );
}

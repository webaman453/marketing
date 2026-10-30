/**
 * Plain-anchor `next/link`. Use with:
 *   vi.mock("next/link", () => import("@/test-utils/next-link"));
 */
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

type Href = string | { pathname?: string; query?: Record<string, string> };

const toHref = (href: Href) => {
  if (typeof href === "string") return href;
  const qs = href.query ? `?${new URLSearchParams(href.query).toString()}` : "";
  return `${href.pathname ?? ""}${qs}`;
};

const Link = forwardRef<HTMLAnchorElement, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { href: Href; children?: ReactNode; prefetch?: boolean; replace?: boolean; scroll?: boolean }>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Next-only props, dropped from the <a>
  function Link({ href, prefetch: _prefetch, replace: _replace, scroll: _scroll, children, ...rest }, ref) {
    return (
      <a ref={ref} href={toHref(href)} {...rest}>
        {children}
      </a>
    );
  },
);

export default Link;

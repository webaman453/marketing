/**
 * Stand-in for `next/navigation`. Use in a test file with:
 *   vi.mock("next/navigation", () => import("@/test-utils/next-navigation"));
 * and steer it through `navigation` (pathname, search params, router spies).
 */
import { vi } from "vitest";

function makeRouter() {
  return { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
}

export const navigation = {
  pathname: "/w/ws_1/overview",
  search: new URLSearchParams(),
  params: { workspaceId: "ws_1" } as Record<string, string>,
  router: makeRouter(),
  /** Puts everything back between tests. */
  reset(opts: { pathname?: string; search?: string | Record<string, string> } = {}) {
    navigation.pathname = opts.pathname ?? "/w/ws_1/overview";
    navigation.search = new URLSearchParams(opts.search ?? "");
    navigation.params = { workspaceId: "ws_1" };
    navigation.router = makeRouter();
  },
};

export const useRouter = () => navigation.router;
export const usePathname = () => navigation.pathname;
export const useSearchParams = () => navigation.search;
export const useParams = () => navigation.params;
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export const redirect = vi.fn();
export const notFound = vi.fn();

/**
 * Browser APIs that Radix, cmdk and the sidebar expect but jsdom lacks.
 * Imported by every helper in this folder, so a test file only needs
 * `import { ... } from "@/test-utils"`.
 */
import { vi } from "vitest";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const g = globalThis as unknown as Record<string, unknown>;
if (!g.ResizeObserver) g.ResizeObserver = ResizeObserverStub;

/** In-memory Web Storage; newer Node versions ship a global localStorage that is undefined without a flag. */
class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  let ok = false;
  try {
    ok = typeof (globalThis as unknown as Record<string, Storage | undefined>)[name]?.setItem === "function";
  } catch {
    ok = false;
  }
  if (!ok) {
    const store = new MemoryStorage();
    Object.defineProperty(globalThis, name, { configurable: true, value: store });
    if (typeof window !== "undefined" && window !== (globalThis as unknown)) Object.defineProperty(window, name, { configurable: true, value: store });
  }
}

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  }
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!proto.scrollIntoView) proto.scrollIntoView = function scrollIntoView() {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  // jsdom logs "Not implemented" for window.scrollTo; the builder calls it on every node switch.
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  }
}

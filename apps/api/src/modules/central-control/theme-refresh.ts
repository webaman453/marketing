import { EventEmitter } from "node:events";

/**
 * In-process theme refresh bus.
 * Central Control SSE → API → browser SSE (/api/central-control/theme/stream).
 */
class ThemeRefreshBus extends EventEmitter {
  notify(reason = "theme_updated") {
    this.emit("refresh", { reason, at: new Date().toISOString() });
  }
}

export const themeRefreshBus = new ThemeRefreshBus();
themeRefreshBus.setMaxListeners(100);

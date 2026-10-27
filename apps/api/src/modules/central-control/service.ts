import { themeRefreshBus } from "./theme-refresh";

export type CentralControlRuntime = {
  product: { id: string; slug: string; name: string };
  environment: string;
  theme: { id: string; versionNumber: number; tokens: Record<string, unknown> } | null;
  featureFlags: Record<string, unknown>;
  config: Record<string, unknown>;
  publishedAt: string | null;
  source: "central-control" | "local-fallback";
};

type CcEnv = {
  url: string;
  installationId: string;
  serverSecret: string;
  productSlug: string;
  environment: string;
  connectorVersion: string;
  heartbeatMs: number;
  enableLegacyApiKey: boolean;
  legacyApiKey?: string;
};

function readCcEnv(): CcEnv | null {
  const enable = process.env.CENTRAL_CONTROL_ENABLE_SDK === "true";
  const url = process.env.CENTRAL_CONTROL_URL?.trim();
  const installationId = process.env.CENTRAL_CONTROL_INSTALLATION_ID?.trim();
  const serverSecret = process.env.CENTRAL_CONTROL_SERVER_SECRET?.trim();
  if (!enable || !url || !installationId || !serverSecret) return null;
  return {
    url: url.replace(/\/$/, ""),
    installationId,
    serverSecret,
    productSlug: process.env.CENTRAL_CONTROL_PRODUCT_SLUG?.trim() || "marketing",
    environment: process.env.CENTRAL_CONTROL_ENVIRONMENT?.trim() || "development",
    connectorVersion: process.env.CENTRAL_CONTROL_CONNECTOR_VERSION?.trim() || "1.0.0",
    heartbeatMs: Number(process.env.CENTRAL_CONTROL_HEARTBEAT_INTERVAL_MS || 30000),
    enableLegacyApiKey: process.env.CENTRAL_CONTROL_ENABLE_LEGACY_API_KEY === "true",
    legacyApiKey: process.env.CENTRAL_CONTROL_LEGACY_API_KEY?.trim() || undefined,
  };
}

function themeFingerprint(theme: CentralControlRuntime["theme"]): string {
  if (!theme) return "null";
  return `${theme.id}:${theme.versionNumber}:${JSON.stringify(theme.tokens ?? {})}`;
}

function shouldFetchBundleAfterThemeEvent(event: any, hasCache: boolean): boolean {
  const payload = event?.payload || {};
  const hasTokens = Boolean(payload.tokens || payload.theme?.tokens);
  return !hasCache || !hasTokens;
}

class CentralControlService {
  private cache: CentralControlRuntime | null = null;
  private lastError: string | null = null;
  private connected = false;
  private sseConnected = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sseAbort: AbortController | null = null;
  private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  isEnabled() {
    return Boolean(readCcEnv());
  }

  getStatus() {
    const env = readCcEnv();
    return {
      enabled: Boolean(env),
      connected: this.connected,
      sseConnected: this.sseConnected,
      productSlug: env?.productSlug ?? null,
      environment: env?.environment ?? null,
      lastError: this.lastError,
      hasTheme: Boolean(this.cache?.theme),
      themeVersion: this.cache?.theme?.versionNumber ?? null,
    };
  }

  async start() {
    if (this.started || !this.isEnabled()) return;
    this.started = true;
    try {
      this.cache = await this.fetchBundleFromControl();
      this.connected = true;
      this.lastError = null;
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : "bootstrap failed";
      console.warn(`[Central Control] bootstrap failed: ${this.lastError}`);
    }
    this.startHeartbeat();
    this.startPolling();
    this.startRealtimeStream();
  }

  async getSafeRuntime(): Promise<CentralControlRuntime | null> {
    if (!this.isEnabled()) return null;
    try {
      const fresh = await this.fetchBundleFromControl();
      this.applyRuntimeUpdate(fresh, false);
      return fresh;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "runtime fetch failed";
      return this.cache;
    }
  }

  private authHeaders(): Record<string, string> {
    const env = readCcEnv()!;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.serverSecret}`,
      "Content-Type": "application/json",
      "X-Connector-Version": env.connectorVersion,
      "X-Installation-Id": env.installationId,
    };
    if (env.enableLegacyApiKey && env.legacyApiKey) {
      headers["X-API-Key"] = env.legacyApiKey;
    }
    return headers;
  }

  private async fetchBundleFromControl(): Promise<CentralControlRuntime> {
    const env = readCcEnv()!;
    // Same contract as Carelix Meet: POST /api/v1/runtime/bundle (installation bearer auth).
    const response = await fetch(`${env.url}/api/v1/runtime/bundle`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({
        installationId: env.installationId,
        environment: env.environment,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Central Control ${response.status}: ${text.slice(0, 200)}`);
    }
    const json = (await response.json()) as any;
    const data = json.data || json;
    const theme = data.theme
      ? {
          id: String(data.theme.id || data.theme.themeId || "theme"),
          versionNumber: Number(data.theme.versionNumber ?? data.theme.version ?? 0),
          tokens: (data.theme.tokens || {}) as Record<string, unknown>,
        }
      : null;
    this.connected = true;
    this.lastError = null;
    return {
      product: {
        id: String(data.product?.id || env.productSlug),
        slug: String(data.product?.slug || env.productSlug),
        name: String(data.product?.name || env.productSlug),
      },
      environment: env.environment,
      theme,
      featureFlags: (data.featureFlags || data.flags || {}) as Record<string, unknown>,
      config: (data.config || data.remoteConfig || {}) as Record<string, unknown>,
      publishedAt: data.publishedAt || data.theme?.publishedAt || null,
      source: "central-control",
    };
  }

  private applyRuntimeUpdate(next: CentralControlRuntime, forceNotify: boolean) {
    const prevFp = themeFingerprint(this.cache?.theme ?? null);
    const nextFp = themeFingerprint(next.theme);
    this.cache = next;
    this.connected = true;
    if (forceNotify || prevFp !== nextFp) {
      themeRefreshBus.notify("theme_updated");
    }
  }

  private startHeartbeat() {
    const env = readCcEnv();
    if (!env) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const tick = async () => {
      try {
        await fetch(`${env.url}/api/v1/installations/${env.installationId}/heartbeat`, {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ metadata: { connectorVersion: env.connectorVersion } }),
        }).catch(() => undefined);
        this.connected = true;
      } catch (error) {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : "heartbeat failed";
      }
    };
    void tick();
    this.heartbeatTimer = setInterval(() => void tick(), env.heartbeatMs);
  }

  private startPolling() {
    const env = readCcEnv();
    if (!env) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      void this.getSafeRuntime().catch(() => undefined);
    }, Math.max(env.heartbeatMs, 15000));
  }

  private startRealtimeStream() {
    if (this.sseReconnectTimer) clearTimeout(this.sseReconnectTimer);
    this.sseReconnectTimer = null;
    this.sseAbort?.abort();
    this.sseAbort = null;
    void this.connectSSE(0);
  }

  private calculateReconnectDelay(attempt: number): number {
    const baseDelay = 1000;
    const maxDelay = 16000;
    const exponentialDelay = baseDelay * Math.pow(2, Math.min(attempt, 4));
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private async connectSSE(reconnectAttempt: number) {
    const env = readCcEnv();
    if (!env) return;

    const abort = new AbortController();
    this.sseAbort = abort;

    const url = `${env.url}/api/v1/runtime/${env.productSlug}/${env.environment}/stream`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.serverSecret}`,
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Connector-Version": env.connectorVersion,
        },
        signal: abort.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(`Central Control SSE ${response.status}: ${text.slice(0, 160)}`);
      }

      this.sseConnected = true;
      this.connected = true;
      this.lastError = null;
      console.log(`[Central Control] SSE connected → ${env.productSlug}/${env.environment}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const rawFrame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          this.handleSseFrame(rawFrame);
        }
      }

      this.sseConnected = false;
      if (!abort.signal.aborted) throw new Error("Central Control SSE stream closed");
    } catch (error) {
      this.sseConnected = false;
      if (abort.signal.aborted) return;
      this.lastError = error instanceof Error ? error.message : "SSE failed";
      console.warn(`[Central Control] SSE disconnected: ${this.lastError}`);
      const delay = this.calculateReconnectDelay(reconnectAttempt);
      this.sseReconnectTimer = setTimeout(() => {
        void this.connectSSE(reconnectAttempt + 1);
      }, delay);
    }
  }

  private handleSseFrame(rawFrame: string) {
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith(":") || !line.trim()) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;

    let parsed: any;
    try {
      parsed = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }

    if (parsed?.type === "CONNECTED") {
      this.connected = true;
      return;
    }

    if (parsed?.event === "THEME_UPDATED" || parsed?.event === "RUNTIME_UPDATED") {
      void this.onRemoteThemeEvent(parsed);
    }
  }

  private async onRemoteThemeEvent(event: any) {
    const payload = event.payload || {};
    const themeTokens = payload.tokens || payload.theme?.tokens;
    const versionNumber = payload.versionNumber ?? payload.theme?.versionNumber;
    const themeId = payload.themeId || payload.theme?.id || payload.id;

    if (!shouldFetchBundleAfterThemeEvent(event, Boolean(this.cache)) && this.cache && themeTokens) {
      this.applyRuntimeUpdate(
        {
          ...this.cache,
          theme: {
            id: String(themeId || this.cache.theme?.id || "theme"),
            versionNumber: Number(versionNumber ?? this.cache.theme?.versionNumber ?? 0),
            tokens: themeTokens as Record<string, unknown>,
          },
          publishedAt: new Date().toISOString(),
          source: "central-control",
        },
        false
      );
      return;
    }

    try {
      const fresh = await this.fetchBundleFromControl();
      this.applyRuntimeUpdate(fresh, false);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "post-SSE bundle refresh failed";
    }
  }
}

export const centralControlService = new CentralControlService();

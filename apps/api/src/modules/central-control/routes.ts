import { Router, type Request, type Response } from "express";
import { centralControlService } from "./service";
import { themeRefreshBus } from "./theme-refresh";

export function createCentralControlRouter() {
  const router = Router();

  router.get("/runtime", async (_req: Request, res: Response) => {
    try {
      if (!centralControlService.isEnabled()) {
        return res.json({
          enabled: false,
          theme: null,
          source: "local-fallback",
          message: "Central Control SDK disabled — set CENTRAL_CONTROL_ENABLE_SDK=true",
        });
      }
      const runtime = await centralControlService.getSafeRuntime();
      return res.json({ enabled: true, ...(runtime || { theme: null, source: "local-fallback" }) });
    } catch (error) {
      return res.status(502).json({
        enabled: true,
        error: error instanceof Error ? error.message : "runtime unavailable",
      });
    }
  });

  router.get("/status", (_req: Request, res: Response) => {
    res.json(centralControlService.getStatus());
  });

  /** Browser SSE — notifies NexusThemeProvider to re-fetch /runtime after publish. */
  router.get("/theme/stream", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    res.write(`data: ${JSON.stringify({ type: "CONNECTED" })}\n\n`);

    const onRefresh = (payload: unknown) => {
      res.write(`data: ${JSON.stringify({ event: "THEME_REFRESH", payload })}\n\n`);
    };
    themeRefreshBus.on("refresh", onRefresh);

    const heartbeat = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      themeRefreshBus.off("refresh", onRefresh);
    });
  });

  return router;
}

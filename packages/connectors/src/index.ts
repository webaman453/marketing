import type { Platform } from "@ashniva/shared";
import { DemoConnector } from "./demo";
import { ConnectorError } from "./errors";
import { GoogleAdsConnector, type GoogleConfig } from "./google";
import { LinkedInConnector, type LinkedInConfig } from "./linkedin";
import { MetaConnector, type MetaConfig } from "./meta";
import { MicrosoftAdsConnector, type MicrosoftConfig } from "./microsoft";
import { PinterestConnector, type PinterestConfig } from "./pinterest";
import { SnapchatConnector, type SnapchatConfig } from "./snapchat";
import { TikTokConnector, type TikTokConfig } from "./tiktok";
import { AmazonAdsConnector, type AmazonConfig } from "./amazon";
import { AppleAdsConnector, type AppleConfig } from "./apple";
import { CriteoConnector, type CriteoConfig } from "./criteo";
import { OutbrainConnector, type OutbrainConfig } from "./outbrain";
import { SpotifyAdsConnector, type SpotifyConfig } from "./spotify";
import { TaboolaConnector, type TaboolaConfig } from "./taboola";
import { TradeDeskConnector, type TradeDeskConfig } from "./tradedesk";
import { XAdsConnector, type XConfig } from "./x";
import { YahooDspConnector, type YahooConfig } from "./yahoo";
import type { AdPlatformConnector } from "./types";

export * from "./types";
export * from "./errors";
export { MetaConnector } from "./meta";
export { GoogleAdsConnector } from "./google";
export { TikTokConnector } from "./tiktok";
export { LinkedInConnector } from "./linkedin";
export { MicrosoftAdsConnector } from "./microsoft";
export { SnapchatConnector } from "./snapchat";
export { PinterestConnector } from "./pinterest";
export { AmazonAdsConnector } from "./amazon";
export { XAdsConnector } from "./x";
export { AppleAdsConnector } from "./apple";
export { SpotifyAdsConnector } from "./spotify";
export { CriteoConnector } from "./criteo";
export { TaboolaConnector } from "./taboola";
export { OutbrainConnector } from "./outbrain";
export { TradeDeskConnector } from "./tradedesk";
export { YahooDspConnector } from "./yahoo";
export { DemoConnector, DEMO_ACCOUNTS, DEMO_PLATFORMS, generateDemoMetrics, generateDemoStructure } from "./demo";

export interface ConnectorsConfig {
  meta: MetaConfig;
  google: GoogleConfig;
  tiktok: TikTokConfig;
  linkedin: LinkedInConfig;
  microsoft: MicrosoftConfig;
  snapchat: SnapchatConfig;
  pinterest: PinterestConfig;
  amazon: AmazonConfig;
  x: XConfig;
  apple: AppleConfig;
  spotify: SpotifyConfig;
  criteo: CriteoConfig;
  taboola: TaboolaConfig;
  outbrain: OutbrainConfig;
  tradedesk: TradeDeskConfig;
  yahoo: YahooConfig;
}

export interface ConnectorRegistry {
  /** Live connector for a platform, or throws if that platform is not supported yet. */
  get(platform: Platform, mode?: "LIVE" | "DEMO"): AdPlatformConnector;
  /** Platforms with a live connector implementation. */
  livePlatforms(): Platform[];
  isConfigured(platform: Platform): boolean;
}

export function createConnectorRegistry(config: ConnectorsConfig): ConnectorRegistry {
  const live: Partial<Record<Platform, AdPlatformConnector>> = {
    META: new MetaConnector(config.meta),
    GOOGLE: new GoogleAdsConnector(config.google),
    TIKTOK: new TikTokConnector(config.tiktok),
    LINKEDIN: new LinkedInConnector(config.linkedin),
    MICROSOFT: new MicrosoftAdsConnector(config.microsoft),
    SNAPCHAT: new SnapchatConnector(config.snapchat),
    PINTEREST: new PinterestConnector(config.pinterest),
    AMAZON: new AmazonAdsConnector(config.amazon),
    X: new XAdsConnector(config.x),
    APPLE: new AppleAdsConnector(config.apple),
    SPOTIFY: new SpotifyAdsConnector(config.spotify),
    CRITEO: new CriteoConnector(config.criteo),
    TABOOLA: new TaboolaConnector(config.taboola),
    OUTBRAIN: new OutbrainConnector(config.outbrain),
    TRADEDESK: new TradeDeskConnector(config.tradedesk),
    YAHOO: new YahooDspConnector(config.yahoo),
  };
  const demo = new Map<Platform, DemoConnector>();

  return {
    get(platform, mode = "LIVE") {
      if (mode === "DEMO") {
        if (!demo.has(platform)) demo.set(platform, new DemoConnector(platform));
        return demo.get(platform)!;
      }
      const c = live[platform];
      if (!c) throw new ConnectorError("UNSUPPORTED", `${platform} integration is coming soon.`);
      return c;
    },
    livePlatforms: () => Object.keys(live) as Platform[],
    isConfigured: (platform) => live[platform]?.isConfigured() ?? false,
  };
}

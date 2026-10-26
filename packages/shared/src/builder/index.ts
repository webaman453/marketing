import type { Platform } from "../platforms";
import { googleSpec } from "./specs/google";
import { linkedinSpec } from "./specs/linkedin";
import { metaSpec } from "./specs/meta";
import { microsoftSpec } from "./specs/microsoft";
import { pinterestSpec } from "./specs/pinterest";
import { snapchatSpec } from "./specs/snapchat";
import { tiktokSpec } from "./specs/tiktok";
import { amazonSpec } from "./specs/amazon";
import { appleSpec } from "./specs/apple";
import { criteoSpec } from "./specs/criteo";
import { outbrainSpec } from "./specs/outbrain";
import { spotifySpec } from "./specs/spotify";
import { taboolaSpec } from "./specs/taboola";
import { tradeDeskSpec } from "./specs/tradedesk";
import { xSpec } from "./specs/x";
import { yahooSpec } from "./specs/yahoo";
import type { PlatformBuilderSpec } from "./types";

export * from "./types";
export * from "./engine";
export * from "./common";
export * from "./geo";
export * from "./preview";
export * from "./drafts";
export { META_OBJECTIVES, META_PLACEMENT_GROUPS, metaGoals, metaLocations } from "./specs/meta";
export { GOOGLE_GOALS, googleCampaignTypes } from "./specs/google";
export { TIKTOK_BILLING, TIKTOK_OBJECTIVES } from "./specs/tiktok";
export { LINKEDIN_JOB_FUNCTIONS, LINKEDIN_OBJECTIVES, linkedinFormats } from "./specs/linkedin";
export { SNAP_OBJECTIVES } from "./specs/snapchat";
export { PINTEREST_OBJECTIVES } from "./specs/pinterest";

export const BUILDER_SPECS: Record<Platform, PlatformBuilderSpec> = {
  META: metaSpec,
  GOOGLE: googleSpec,
  TIKTOK: tiktokSpec,
  LINKEDIN: linkedinSpec,
  MICROSOFT: microsoftSpec,
  SNAPCHAT: snapchatSpec,
  PINTEREST: pinterestSpec,
  AMAZON: amazonSpec,
  X: xSpec,
  APPLE: appleSpec,
  SPOTIFY: spotifySpec,
  CRITEO: criteoSpec,
  TABOOLA: taboolaSpec,
  OUTBRAIN: outbrainSpec,
  TRADEDESK: tradeDeskSpec,
  YAHOO: yahooSpec,
};

export const builderSpec = (platform: Platform) => BUILDER_SPECS[platform];

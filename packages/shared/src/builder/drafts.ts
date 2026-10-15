import { z } from "zod";
import type { Platform } from "../platforms";

/** Drafts are saved as the user types, so the payload isn't validated until launch. */
export const draftSchema = z.object({
  name: z.string().trim().max(400).default("Untitled campaign"),
  payload: z.record(z.string(), z.unknown()),
});

export interface DraftResult {
  adAccountId: string;
  platform: Platform;
  ok: boolean;
  campaignId?: string;
  externalId?: string;
  error?: string;
  /** Ad groups/ads created before a failure, so a retry can say what exists. */
  created?: { adGroups: number; ads: number };
  /** Things that were created with a caveat */
  warnings?: string[];
}

/**
 * Metered AI: checks the organization's token balance, makes the call and
 * deducts the tokens it used.
 */
import { assertAiTokens, chargeAiUsage } from "@ashniva/core";
import type { AiFeatureKey } from "@ashniva/shared";
import type { z } from "zod";
import { HttpError } from "../errors";
import { aiAvailable, generateJson, type AiImage } from "./client";

export { aiAvailable, aiModelName } from "./client";

export interface AiCaller {
  orgId: string;
  userId?: string | null;
  workspaceId?: string | null;
}

export async function runAi<S extends z.ZodType>(
  caller: AiCaller,
  feature: AiFeatureKey,
  opts: { schema: S; system: string; prompt: string; images?: AiImage[]; maxTokens?: number },
): Promise<z.infer<S>> {
  if (!aiAvailable()) {
    throw new HttpError(503, "AI_NOT_CONFIGURED", "AI isn't available on this deployment yet. Ask the platform administrator to add an AI key.");
  }
  await assertAiTokens(caller.orgId);
  const result = await generateJson(opts);
  await chargeAiUsage({
    orgId: caller.orgId,
    feature,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    userId: caller.userId,
    workspaceId: caller.workspaceId,
  });
  return result.data;
}

/** Shared guidance for anything that writes ad copy. */
export const COPYWRITER_SYSTEM =
  "You are a senior performance-marketing copywriter who writes ads for Meta, Google, YouTube, TikTok, LinkedIn, Microsoft, Snapchat and Pinterest. Write distinct, specific copy that follows each platform's advertising policies: no unverifiable superlatives (\"best\", \"#1\") without proof, no misleading claims, no references to the viewer's personal attributes (\"Are you diabetic?\"), no excessive capitals or punctuation, no clickbait. Vary the angles (benefit, offer, social proof, urgency, problem/solution). Character limits are hard limits; count spaces and stay under them. Write in the language requested.";

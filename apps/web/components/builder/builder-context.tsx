"use client";

import type { AiStatusDTO, BuilderOptions, CreativeDTO, Platform } from "@ashniva/shared";
import { createContext, useContext } from "react";

/** The ad's subject, reused by every AI suggestion in the builder. */
export interface BriefState {
  product: string;
  audience: string;
  offer: string;
  tone: string;
  language: string;
}

export const emptyBrief = (): BriefState => ({ product: "", audience: "", offer: "", tone: "", language: "English" });

export interface BuilderEnv {
  workspaceId: string;
  platform: Platform;
  adAccountId: string;
  currency: string;
  options: BuilderOptions;
  optionsLoading: boolean;
  creatives: CreativeDTO[];
  ai: AiStatusDTO | undefined;
  brief: BriefState;
  setBrief: (b: BriefState) => void;
  /** Opens the brief dialog when an AI action needs one first. */
  requestBrief: (then: (brief: BriefState) => void) => void;
  /** Summary of the ad being edited, given to AI suggestions as context. */
  adContext: string;
  onAiUsed: () => void;
}

const Ctx = createContext<BuilderEnv | null>(null);

export const BuilderEnvProvider = Ctx.Provider;

export function useBuilderEnv() {
  const env = useContext(Ctx);
  if (!env) throw new Error("useBuilderEnv must be used inside the campaign builder");
  return env;
}

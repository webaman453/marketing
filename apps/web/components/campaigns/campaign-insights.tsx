"use client";

import { AiInsights } from "@/components/dashboard/ai-insights";

/** AI read-out of one campaign: trend, ad groups and ads compared, next steps. */
export function CampaignInsights({ campaignId }: { campaignId: string }) {
  return (
    <AiInsights
      path={`/ai/campaigns/${campaignId}/insights`}
      title="AI campaign analysis"
      intro="Compare this campaign's ad sets and ads, spot the trend, and get concrete next steps."
    />
  );
}

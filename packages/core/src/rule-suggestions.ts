import { prisma, type RuleSuggestion } from "@ashniva/db";
import { ruleActionSchema, type RuleAction } from "@ashniva/shared";
import { z } from "zod";
import { audit } from "./audit";
import { campaignWithConnection } from "./campaign-actions";
import { isOrgLocked } from "./entitlements";
import { applyRuleAction } from "./rules";

export class SuggestionError extends Error {}

const actionsOf = (s: Pick<RuleSuggestion, "actions">): RuleAction[] => z.array(ruleActionSchema).parse(s.actions);

/** Approves a suggestion: applies its actions to the campaign now, as that person. */
export async function approveSuggestion(workspaceId: string, suggestionId: string, userId: string) {
  const s = await prisma.ruleSuggestion.findFirst({ where: { id: suggestionId, workspaceId }, include: { rule: true } });
  if (!s) throw new SuggestionError("That suggestion no longer exists.");
  if (s.status !== "PENDING") throw new SuggestionError(s.status === "APPLIED" ? "This suggestion was already applied." : "This suggestion is no longer open.");
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: s.orgId } });
  if (isOrgLocked(org)) throw new SuggestionError("Your organization is read-only until a plan is active.");

  const campaign = await prisma.campaign.findFirst({ where: { id: s.campaignId }, include: campaignWithConnection });
  if (!campaign) {
    await prisma.ruleSuggestion.update({ where: { id: s.id }, data: { status: "FAILED", error: "The campaign is gone.", resolvedAt: new Date(), resolvedById: userId } });
    throw new SuggestionError("That campaign is no longer in your account.");
  }

  const actor = { orgId: s.orgId, workspaceId: s.workspaceId, userId, via: `Rule: ${s.rule.name} (approved)` };
  const done: string[] = [];
  try {
    for (const action of actionsOf(s)) {
      const note = await applyRuleAction(campaign, action, actor);
      done.push(note ? `${action.type}: ${note}` : action.type);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.ruleSuggestion.update({ where: { id: s.id }, data: { status: "FAILED", error: message.slice(0, 500), resolvedAt: new Date(), resolvedById: userId } });
    throw new SuggestionError(message);
  }
  await prisma.ruleSuggestion.update({ where: { id: s.id }, data: { status: "APPLIED", resolvedAt: new Date(), resolvedById: userId } });
  await audit({ orgId: s.orgId, workspaceId: s.workspaceId, userId, action: "rule_suggestion.approved", entityType: "campaign", entityId: s.campaignId, entityName: s.campaignName, changes: { actions: { from: null, to: done }, rule: { from: null, to: s.rule.name } } });
  return { applied: done };
}

export async function dismissSuggestion(workspaceId: string, suggestionId: string, userId: string) {
  const s = await prisma.ruleSuggestion.findFirst({ where: { id: suggestionId, workspaceId } });
  if (!s) throw new SuggestionError("That suggestion no longer exists.");
  if (s.status !== "PENDING") return;
  await prisma.ruleSuggestion.update({ where: { id: s.id }, data: { status: "DISMISSED", resolvedAt: new Date(), resolvedById: userId } });
}

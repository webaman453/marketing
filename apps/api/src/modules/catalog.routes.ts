/**
 * Public price list (plans, trial, AI token packs) as the platform owner set
 * it in the admin console. Used by the pricing page, billing and AI settings.
 */
import { FEATURE_LABELS, PAID_PLANS, currentCatalog } from "@ashniva/shared";
import { Router } from "express";

export const catalogRouter = Router();

catalogRouter.get("/", (_req, res) => {
  // Not cached: a price the owner just saved should show up immediately.
  res.set("Cache-Control", "no-cache");
  res.json({ ...currentCatalog(), paidPlans: PAID_PLANS, featureLabels: FEATURE_LABELS });
});

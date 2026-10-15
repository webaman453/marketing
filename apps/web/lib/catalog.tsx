"use client";

import { applyCatalog, type Catalog } from "@ashniva/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * The owner's price list. Loading it applies it to the shared PLANS,
 * AI_TOKEN_PACKS and PRICING objects, so prices and feature gates match the
 * server. Components that show prices or gate features call this hook so
 * they re-render once it arrives.
 */
export function useCatalog() {
  return useQuery({
    queryKey: ["catalog"],
    queryFn: async () => {
      const c = await api<Catalog>("/catalog");
      applyCatalog(c);
      return c;
    },
    staleTime: 60_000,
  });
}

/** Loads the price list early, before any page needs it. */
export function CatalogLoader() {
  useCatalog();
  return null;
}

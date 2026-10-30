import { AI_TOKEN_PACKS, PLANS, PRICING, applyCatalog, defaultCatalog, type Catalog } from "@ashniva/shared";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", async (orig) => ({ ...(await orig<typeof import("@/lib/api")>()), api: vi.fn() }));

import { api } from "@/lib/api";
import { makeQueryClient, routeApi } from "@/test-utils";
import { CatalogLoader, useCatalog } from "./catalog";
import { render } from "@testing-library/react";

afterEach(() => applyCatalog(defaultCatalog()));

function custom(): Catalog {
  const c = defaultCatalog();
  c.trialDays = 30;
  c.gstPercent = 12;
  c.plans.STARTER.priceMonthly = 4999;
  c.plans.STARTER.limits.workspaces = null;
  c.plans.GROWTH.popular = false;
  c.plans.AGENCY.popular = true;
  c.plans.TRIAL.priceMonthly = 999;
  c.tokenPacks = [{ id: "pack_one", name: "One", tokens: 50_000, price: 199 }];
  return c;
}

describe("useCatalog", () => {
  it("loads /catalog and applies it to the shared PLANS, PRICING and token packs", async () => {
    routeApi(api, { "GET /catalog": custom() });
    const client = makeQueryClient();
    const { result } = renderHook(() => useCatalog(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(PRICING.trialDays).toBe(30);
    expect(PRICING.gstPercent).toBe(12);
    expect(PLANS.STARTER.priceMonthly).toBe(4999);
    expect(PLANS.STARTER.limits.workspaces).toBe(Number.POSITIVE_INFINITY);
    expect(PLANS.AGENCY.popular).toBe(true);
    expect(PLANS.GROWTH.popular).toBe(false);
    // The trial is always free, whatever the catalog says.
    expect(PLANS.TRIAL.priceMonthly).toBe(0);
    expect(AI_TOKEN_PACKS.map((p) => p.id)).toEqual(["pack_one"]);
  });

  it("CatalogLoader fetches the catalog without rendering anything", async () => {
    routeApi(api, { "GET /catalog": custom() });
    const client = makeQueryClient();
    const { container } = render(
      <QueryClientProvider client={client}>
        <CatalogLoader />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(PRICING.trialDays).toBe(30));
  });

  it("leaves the defaults alone when /catalog fails", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("down"));
    const client = makeQueryClient();
    const { result } = renderHook(() => useCatalog(), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(PRICING.trialDays).toBe(defaultCatalog().trialDays);
  });
});

import type { AdPreviewData, PlacementPreview, PreviewMedia } from "@ashniva/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import "@/test-utils/polyfills";
import { AdPlacement, PLACEMENT_LABEL, PreviewPanel, fallbackPreview, normalizeAd, placementLabel } from "./index";
import { youtubeThumb, type NormalizedAd } from "./normalize";
import { searchCombo } from "./google";

const img = (id: string, o: Partial<PreviewMedia> = {}): PreviewMedia => ({ id, url: `https://cdn.example.com/${id}.jpg`, type: "IMAGE", width: 1080, height: 1080, name: `${id}.jpg`, ...o });

function data(o: Partial<AdPreviewData> = {}): AdPreviewData {
  return { platform: "META", setup: {}, campaign: {}, adGroup: {}, ad: {}, media: {}, identity: { name: "Acme Store" }, ...o };
}

describe("normalizeAd", () => {
  it("reads Meta-style text lists, media ids and the CTA", () => {
    const ad = normalizeAd(
      data({
        ad: { primaryTexts: ["  Festive sale is live  ", "Second"], headlines: ["Up to 40% off"], descriptions: ["Free delivery"], url: "https://www.acme.in/sale?x=1", cta: "SHOP_NOW", media: ["m1", "missing"] },
        media: { m1: img("m1") },
      }),
    );
    expect(ad.primaryText).toBe("Festive sale is live");
    expect(ad.headline).toBe("Up to 40% off");
    expect(ad.description).toBe("Free delivery");
    expect(ad.cta).toBe("Shop now");
    expect(ad.domain).toBe("acme.in");
    expect(ad.media.map((m) => m.id)).toEqual(["m1"]);
    expect(ad.brand).toBe("Acme Store");
  });

  it("puts pasted image URLs first and de-duplicates uploads with the same URL", () => {
    const ad = normalizeAd(
      data({
        ad: { imageUrl: "https://cdn.example.com/m1.jpg", thumbnailUrl: "ftp://not-a-web-url", images: ["m1", "m2"] },
        media: { m1: img("m1"), m2: img("m2") },
      }),
    );
    expect(ad.media.map((m) => m.url)).toEqual(["https://cdn.example.com/m1.jpg", "https://cdn.example.com/m2.jpg"]);
    expect(ad.media[0]).toMatchObject({ id: "https://cdn.example.com/m1.jpg", type: "IMAGE", width: null });
  });

  it("takes the brand from the ad, then the ad group, then the campaign, then the identity", () => {
    expect(normalizeAd(data({ campaign: { businessName: "Campaign Co" } })).brand).toBe("Campaign Co");
    expect(normalizeAd(data({ campaign: { businessName: "Campaign Co" }, adGroup: { brandName: "Group Co" } })).brand).toBe("Group Co");
    expect(normalizeAd(data({ adGroup: { brandName: "Group Co" }, ad: { displayName: "Ad Co" } })).brand).toBe("Ad Co");
    expect(normalizeAd(data({ ad: { brand: "  " } })).brand).toBe("Acme Store");
  });

  it("handles CTA special cases", () => {
    expect(normalizeAd(data({ ad: { cta: "NO_BUTTON" } })).cta).toBeNull();
    expect(normalizeAd(data({ ad: { cta: "AUTOMATED", buttonLabel: "Order" } })).cta).toBe("Order");
    expect(normalizeAd(data({ ad: {} })).cta).toBe("Learn more");
    expect(normalizeAd(data({ ad: { cta: "BOOK_TRAVEL" } })).cta).toBe("Book now");
  });

  it("reads pinned search assets, paths, sitelinks, callouts and keywords", () => {
    const ad = normalizeAd(
      data({
        platform: "GOOGLE",
        adGroup: { keywords: [{ text: "silk saree", matchType: "PHRASE" }], finalUrl: "https://acme.in" },
        ad: {
          headlines: [{ text: "Pinned one", pin: "H1" }, "Free", { text: "  " }],
          descriptions: ["Desc"],
          path1: "sarees",
          path2: "silk",
          sitelinks: [{ text: "Offers", description1: "Up to 40%", description2: "" }, { text: "" }],
          callouts: ["Free shipping", ""],
          displayLink: "acme.in/sale",
        },
      }),
    );
    expect(ad.headlines).toEqual([
      { text: "Pinned one", pin: "H1" },
      { text: "Free", pin: null },
    ]);
    expect(ad.paths).toEqual(["sarees", "silk"]);
    expect(ad.sitelinks).toEqual([{ text: "Offers", description1: "Up to 40%", description2: "" }]);
    expect(ad.callouts).toEqual(["Free shipping"]);
    expect(ad.domain).toBe("acme.in/sale");
    expect(ad.url).toBe("https://acme.in");
    // Keywords are objects; their text is what the search mockup shows.
    expect(ad.keyword).toBe("silk saree");
  });

  it("builds carousel cards and falls back to the first card's URL", () => {
    const ad = normalizeAd(
      data({
        ad: { cards: [{ media: ["m1"], headline: "Card A", url: "https://acme.in/a" }, { image: ["m2"], headline: "Card B", description: "Two" }, { headline: "No media" }] },
        media: { m1: img("m1"), m2: img("m2") },
      }),
    );
    expect(ad.cards.map((c) => [c.media?.id ?? null, c.headline])).toEqual([
      ["m1", "Card A"],
      ["m2", "Card B"],
      [null, "No media"],
    ]);
    expect(ad.url).toBe("https://acme.in/a");
    expect(ad.domain).toBe("acme.in");
  });

  it("reads logos, story media, YouTube links, Amazon ASINs, size and variant", () => {
    const ad = normalizeAd(
      data({
        platform: "AMAZON",
        setup: { adProduct: "SPONSORED_BRANDS" },
        campaign: { logos: ["logo"] },
        ad: { storyMedia: ["st"], youtubeVideos: ["https://youtu.be/abcdef123", ""], asin: "B0001", asins: "B0002, B0003", size: "300x250", format: "VIDEO" },
        media: { logo: img("logo"), st: img("st", { type: "VIDEO" }) },
      }),
    );
    expect(ad.logo?.id).toBe("logo");
    expect(ad.storyMedia?.id).toBe("st");
    expect(ad.youtube).toEqual(["https://youtu.be/abcdef123"]);
    expect(ad.asins).toEqual(["B0001", "B0002", "B0003"]);
    expect(ad.size).toBe("300x250");
    expect(ad.format).toBe("VIDEO");
    expect(ad.variant).toBe("SPONSORED_BRANDS");
  });

  it("uses LinkedIn/Snap/other text keys and defaults to yourstore.com", () => {
    const ad = normalizeAd(data({ ad: { introText: "Hello pros", title: "Hire faster", tagline: "Since 1999", longHeadline: "Long one" } }));
    expect(ad.primaryText).toBe("Hello pros");
    expect(ad.headline).toBe("Hire faster");
    expect(ad.description).toBe("Since 1999");
    expect(ad.longHeadline).toBe("Long one");
    expect(ad.domain).toBe("yourstore.com");
    expect(ad.media).toEqual([]);
    expect(ad.cards).toEqual([]);
  });

  it("youtubeThumb understands watch, short and embed links", () => {
    expect(youtubeThumb("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
    expect(youtubeThumb("https://youtube.com/shorts/abcdefg")).toBe("https://i.ytimg.com/vi/abcdefg/hqdefault.jpg");
    expect(youtubeThumb("https://example.com/video")).toBeNull();
  });

  it("fallbackPreview turns a synced ad into preview data", () => {
    const d = fallbackPreview("META", { name: "Ad", headline: "Synced headline", body: "Synced body", finalUrl: "https://acme.in", thumbnailUrl: "https://cdn.example.com/t.jpg" }, "Acme");
    const ad = normalizeAd(d);
    expect(ad.headline).toBe("Synced headline");
    expect(ad.primaryText).toBe("Synced body");
    expect(ad.media[0]?.url).toBe("https://cdn.example.com/t.jpg");
    const empty = normalizeAd(fallbackPreview("GOOGLE", { name: "Ad", headline: null, body: null, finalUrl: null, thumbnailUrl: null }, "Acme"));
    expect(empty.media).toEqual([]);
    expect(empty.headline).toBe("");
  });
});

describe("searchCombo", () => {
  it("rotates free headlines and honours pins", () => {
    const ad = { headlines: [{ text: "Pin", pin: "H1" }, { text: "A", pin: null }, { text: "B", pin: null }], descriptions: [] } as unknown as NormalizedAd;
    expect(searchCombo(ad, 0).headlines).toEqual(["Pin", "A", "B"]);
    expect(searchCombo(ad, 1).headlines).toEqual(["Pin", "B", "A"]);
    expect(searchCombo(ad, 0).descriptions[0]).toMatch(/Your description appears here/);
  });
});

const ALL = Object.keys(PLACEMENT_LABEL) as PlacementPreview[];

const full = normalizeAd(
  data({
    ad: {
      primaryTexts: ["Festive sale"],
      headlines: ["Up to 40% off", "Free delivery", "Shop now"],
      descriptions: ["All sizes", "Ships in 3 days"],
      url: "https://acme.in",
      cta: "SHOP_NOW",
      media: ["m1", "v1"],
      cards: [{ media: ["m1"], headline: "Card" }],
      youtubeVideos: ["https://youtu.be/abcdef123"],
      sitelinks: [{ text: "Offers" }],
      callouts: ["Free shipping"],
      asin: "B0001",
      size: "300x250",
    },
    media: { m1: img("m1"), v1: img("v1", { type: "VIDEO", url: "https://cdn.example.com/v1.mp4", width: 1080, height: 1920 }) },
  }),
);
const blank = normalizeAd(data());

describe("AdPlacement", () => {
  it.each(ALL)("renders %s with a full ad and with an empty one", (p) => {
    const a = render(<AdPlacement ad={full} placement={p} />);
    expect(a.container.firstChild).not.toBeNull();
    a.unmount();
    const b = render(<AdPlacement ad={blank} placement={p} device="desktop" combo={3} />);
    expect(b.container.firstChild).not.toBeNull();
  });

  it("falls back to a neutral card for a placement this build doesn't know", () => {
    const unknown = render(<AdPlacement ad={full} placement={"future_placement" as PlacementPreview} />);
    const native = render(<AdPlacement ad={full} placement="native_feed" />);
    expect(unknown.container.innerHTML).toBe(native.container.innerHTML);
  });

  it("labels unknown placements readably", () => {
    expect(placementLabel("fb_feed")).toBe("Facebook Feed");
    expect(placementLabel("future_placement_x")).toBe("Future placement x");
  });
});

describe("PreviewPanel", () => {
  const d = data({ ad: { headlines: ["H one", "H two"], descriptions: ["D one"], primaryTexts: ["Body"], url: "https://acme.in" } });

  it("switches between placements", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel data={d} placements={["fb_feed", "google_search_mobile"]} />);
    expect(screen.getByRole("button", { name: "Facebook Feed" })).toHaveClass("bg-primary");
    expect(screen.queryByRole("button", { name: /Another combination/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Google Search · mobile" }));
    expect(screen.getByRole("button", { name: "Google Search · mobile" })).toHaveClass("bg-primary");
    await user.click(screen.getByRole("button", { name: /Another combination/ }));
    expect(screen.queryByRole("button", { name: "desktop" })).not.toBeInTheDocument();
  });

  it("Bing search offers a mobile/desktop switch", async () => {
    const user = userEvent.setup();
    render(<PreviewPanel data={d} placements={["bing_search"]} compact />);
    await user.click(screen.getByRole("button", { name: "desktop" }));
    expect(screen.getByRole("button", { name: "desktop" })).toHaveClass("bg-muted");
  });

  it("uses the native card when no placements apply", () => {
    const { container } = render(<PreviewPanel data={d} placements={[]} />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText(/Previews are approximate/)).toBeInTheDocument();
  });
});

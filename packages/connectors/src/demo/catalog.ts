import type { Platform } from "@ashniva/shared";

/** Shape of a simulated campaign. Rates drive the generated daily metrics. */
export interface DemoCampaignSpec {
  key: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  objective: string;
  dailyBudget: number;
  /** Cost per 1,000 impressions */
  cpm: number;
  ctr: number;
  /** Conversions per click */
  cvr: number;
  /** Average order value; 0 for lead campaigns with no revenue tracking */
  aov: number;
  /** Share of impressions that become video views */
  videoRate?: number;
  startedDaysAgo: number;
  groups: string[];
  ads: { name: string; headline: string; body: string }[];
  /** Lead-gen campaigns: the instant form their conversions are submitted through. */
  leadForm?: DemoLeadForm;
}

/** A sample instant form. Each lead answers the contact questions plus every listed question. */
export interface DemoLeadForm {
  name: string;
  /** "meta" forms ask for full_name and come from fb/ig; "linkedin" ones ask for name, company and title. */
  style: "meta" | "linkedin";
  /** Meta only: share of leads from Instagram (the rest from Facebook). */
  instagramShare?: number;
  questions: { key: string; options: string[] }[];
}

/** External ids of a sample campaign and its ad groups and ads. */
export const demoIds = (account: Pick<DemoAccountSpec, "externalId">, c: Pick<DemoCampaignSpec, "key">) => ({
  campaign: `${account.externalId}-${c.key}`,
  group: (gi: number) => `${account.externalId}-${c.key}-g${gi}`,
  ad: (gi: number, ai: number) => `${account.externalId}-${c.key}-g${gi}-a${ai}`,
});

export interface DemoAccountSpec {
  externalId: string;
  name: string;
  currency: string;
  timezone: string;
  campaigns: DemoCampaignSpec[];
}

function sample(externalId: string, name: string, objective: string, group: string, ad: { name: string; headline: string; body: string }): DemoAccountSpec {
  return {
    externalId,
    name,
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "a1",
        name: `${name.split("·").pop()?.trim() ?? name} · Prospecting`,
        status: "ACTIVE",
        objective,
        dailyBudget: 4000,
        cpm: 120,
        ctr: 0.008,
        cvr: 0.02,
        aov: 900,
        startedDaysAgo: 40,
        groups: [group],
        ads: [ad],
      },
    ],
  };
}

const fashionAds = [
  { name: "Reel – Festive Collection 15s", headline: "The Festive Edit is here", body: "Handcrafted ethnic wear, delivered in 48 hours." },
  { name: "Carousel – Bestsellers", headline: "Our 10 most-loved styles", body: "Swipe through the pieces everyone is wearing this season." },
  { name: "Static – Flat 30% Off", headline: "Flat 30% off sitewide", body: "Limited period offer. Free shipping above ₹999." },
];

export const DEMO_ACCOUNTS: Partial<Record<Platform, DemoAccountSpec>> = {
  META: {
    externalId: "demo-meta-1001",
    name: "Ashniva Retail · Meta",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "m1",
        name: "Festive Sale – Prospecting | Advantage+",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
        dailyBudget: 18000,
        cpm: 165,
        ctr: 0.014,
        cvr: 0.028,
        aov: 1500,
        videoRate: 0.08,
        startedDaysAgo: 120,
        groups: ["Broad 18–45 · India", "Lookalike 1% · Purchasers", "Interest · Ethnic fashion"],
        ads: fashionAds,
      },
      {
        key: "m2",
        name: "Retargeting – Cart Abandoners (7d)",
        status: "ACTIVE",
        objective: "OUTCOME_SALES",
        dailyBudget: 6500,
        cpm: 240,
        ctr: 0.026,
        cvr: 0.065,
        aov: 1400,
        startedDaysAgo: 150,
        groups: ["Added to cart · 7 days", "Viewed product · 14 days"],
        ads: [
          { name: "Dynamic – Product catalogue", headline: "Still thinking it over?", body: "Your picks are waiting. Complete your order today." },
          { name: "Static – Free shipping reminder", headline: "Free shipping on your cart", body: "Checkout in the next 24 hours to save on delivery." },
        ],
      },
      {
        key: "m3",
        name: "Lead Gen – Free Style Consultation",
        status: "ACTIVE",
        objective: "OUTCOME_LEADS",
        dailyBudget: 5000,
        cpm: 140,
        ctr: 0.011,
        cvr: 0.09,
        aov: 0,
        startedDaysAgo: 75,
        groups: ["Women 25–44 · Metro cities", "Bridal interest"],
        ads: [
          { name: "Instant form – Book a stylist", headline: "Book a free 1:1 styling session", body: "Our stylists help you plan the perfect wedding wardrobe." },
          { name: "Video – Stylist testimonial", headline: "Meet your personal stylist", body: "See how 5,000+ brides found their look with us." },
        ],
        leadForm: {
          name: "Free Style Consultation – Booking form",
          style: "meta",
          instagramShare: 0.42,
          questions: [
            { key: "city", options: ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Pune", "Chennai", "Kolkata", "Ahmedabad", "Jaipur", "Lucknow"] },
            { key: "occasion", options: ["My wedding", "Family wedding", "Engagement", "Reception", "Festive season"] },
            { key: "budget", options: ["Under ₹25,000", "₹25,000–₹50,000", "₹50,000–₹1,00,000", "Above ₹1,00,000"] },
            { key: "preferred_time", options: ["Weekday morning", "Weekday evening", "Weekend"] },
          ],
        },
      },
      {
        key: "m4",
        name: "Brand Awareness – Reels Video",
        status: "PAUSED",
        objective: "OUTCOME_AWARENESS",
        dailyBudget: 4000,
        cpm: 72,
        ctr: 0.006,
        cvr: 0.004,
        aov: 1200,
        videoRate: 0.42,
        startedDaysAgo: 100,
        groups: ["Broad · India 18–55"],
        ads: [
          { name: "Reel – Brand film 30s", headline: "Made in India, worn everywhere", body: "The story behind every thread." },
          { name: "Reel – Behind the scenes", headline: "From loom to look", body: "Meet the artisans who make your favourite pieces." },
        ],
      },
      {
        key: "m5",
        name: "Instagram – Profile Engagement",
        status: "ACTIVE",
        objective: "OUTCOME_ENGAGEMENT",
        dailyBudget: 2500,
        cpm: 90,
        ctr: 0.018,
        cvr: 0.005,
        aov: 900,
        videoRate: 0.2,
        startedDaysAgo: 60,
        groups: ["Followers of similar brands"],
        ads: fashionAds.slice(0, 2),
      },
    ],
  },
  GOOGLE: {
    externalId: "demo-google-7781",
    name: "Ashniva Retail · Google Ads",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "g1",
        name: "Search – Brand | Exact",
        status: "ACTIVE",
        objective: "SEARCH",
        dailyBudget: 4000,
        cpm: 900,
        ctr: 0.09,
        cvr: 0.08,
        aov: 1800,
        startedDaysAgo: 200,
        groups: ["Brand – exact", "Brand + product"],
        ads: [
          { name: "RSA – Official store", headline: "Ashniva® Official Store", body: "Shop the new festive collection. Easy 7-day returns." },
          { name: "RSA – Offers", headline: "Flat 30% Off | Ashniva", body: "Free shipping above ₹999. Cash on delivery available." },
        ],
      },
      {
        key: "g2",
        name: "Search – Generic | Ethnic Wear",
        status: "ACTIVE",
        objective: "SEARCH",
        dailyBudget: 12000,
        cpm: 650,
        ctr: 0.045,
        cvr: 0.032,
        aov: 1450,
        startedDaysAgo: 160,
        groups: ["Kurta sets", "Sarees online", "Lehenga for wedding"],
        ads: [
          { name: "RSA – Category", headline: "Designer Ethnic Wear Online", body: "500+ new styles. Delivered in 48 hours across India." },
          { name: "RSA – Price led", headline: "Kurta Sets from ₹999", body: "Premium fabrics, festive prices. Shop now." },
        ],
      },
      {
        key: "g3",
        name: "Performance Max – All Products",
        status: "ACTIVE",
        objective: "PERFORMANCE_MAX",
        dailyBudget: 20000,
        cpm: 180,
        ctr: 0.012,
        cvr: 0.035,
        aov: 1500,
        videoRate: 0.05,
        startedDaysAgo: 140,
        groups: ["Asset group – Festive", "Asset group – Everyday"],
        ads: [
          { name: "Asset set – Lifestyle", headline: "Celebrate in style", body: "Festive looks for every occasion." },
          { name: "Asset set – Product", headline: "Bestsellers are back", body: "Restocked in all sizes." },
        ],
      },
      {
        key: "g4",
        name: "YouTube – Festive Collection Launch",
        status: "ACTIVE",
        objective: "VIDEO",
        dailyBudget: 9000,
        cpm: 110,
        ctr: 0.004,
        cvr: 0.015,
        aov: 1300,
        videoRate: 0.32,
        startedDaysAgo: 45,
        groups: ["In-stream · Affinity fashion", "Shorts · Custom intent"],
        ads: [
          { name: "Video – Launch film 20s", headline: "The Festive Edit", body: "Watch the collection come to life." },
          { name: "Shorts – Styling in 15s", headline: "3 ways to style one saree", body: "Quick looks for every celebration." },
        ],
      },
      {
        key: "g5",
        name: "Display – Remarketing 30d",
        status: "PAUSED",
        objective: "DISPLAY",
        dailyBudget: 3000,
        cpm: 60,
        ctr: 0.007,
        cvr: 0.02,
        aov: 1300,
        startedDaysAgo: 110,
        groups: ["Site visitors · 30 days"],
        ads: [
          { name: "Responsive display – Offer", headline: "Come back for 30% off", body: "Your favourites are on sale." },
        ],
      },
    ],
  },
  TIKTOK: {
    externalId: "demo-tiktok-5520",
    name: "Ashniva Retail · TikTok",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "t1",
        name: "Spark Ads – Creator UGC",
        status: "ACTIVE",
        objective: "CONVERSIONS",
        dailyBudget: 6000,
        cpm: 95,
        ctr: 0.01,
        cvr: 0.016,
        aov: 1200,
        videoRate: 0.45,
        startedDaysAgo: 70,
        groups: ["Gen Z · Fashion interest", "Creators lookalike"],
        ads: [
          { name: "Spark – @stylebyriya haul", headline: "My festive haul 🛍️", body: "Everything under ₹2,000." },
          { name: "Spark – Outfit transition", headline: "1 kurta, 4 looks", body: "Tap to shop the look." },
        ],
      },
      {
        key: "t2",
        name: "In-Feed – Diwali Lookbook",
        status: "ACTIVE",
        objective: "TRAFFIC",
        dailyBudget: 4500,
        cpm: 80,
        ctr: 0.012,
        cvr: 0.011,
        aov: 1100,
        videoRate: 0.38,
        startedDaysAgo: 30,
        groups: ["Broad · 18–34"],
        ads: [
          { name: "Video – Lookbook 12s", headline: "Diwali Lookbook 2026", body: "New drops every week." },
        ],
      },
    ],
  },
  LINKEDIN: {
    externalId: "demo-linkedin-3307",
    name: "Ashniva B2B · LinkedIn",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "l1",
        name: "Sponsored Content – Wholesale Partners",
        status: "ACTIVE",
        objective: "LEAD_GENERATION",
        dailyBudget: 5500,
        cpm: 650,
        ctr: 0.0055,
        cvr: 0.07,
        aov: 9000,
        startedDaysAgo: 90,
        groups: ["Retail owners · India", "Procurement managers"],
        ads: [
          { name: "Single image – Partner program", headline: "Stock India's fastest-growing ethnic brand", body: "Margins up to 45% for retail partners." },
          { name: "Document – Wholesale catalogue", headline: "Download the 2026 wholesale catalogue", body: "800+ SKUs with partner pricing." },
        ],
        leadForm: {
          name: "Retail Partner Program – Enquiry",
          style: "linkedin",
          questions: [
            { key: "city", options: ["Mumbai", "Delhi", "Bengaluru", "Hyderabad", "Pune", "Chennai", "Surat", "Indore"] },
            { key: "number_of_stores", options: ["1", "2–5", "6–20", "More than 20"] },
          ],
        },
      },
      {
        key: "l2",
        name: "Lead Gen Form – Bulk Corporate Gifting",
        status: "ACTIVE",
        objective: "LEAD_GENERATION",
        dailyBudget: 3500,
        cpm: 720,
        ctr: 0.0048,
        cvr: 0.09,
        aov: 14000,
        startedDaysAgo: 40,
        groups: ["HR & Admin leaders"],
        ads: [
          { name: "Lead form – Diwali gifting", headline: "Corporate Diwali gifting, sorted", body: "Curated hampers from ₹1,500 per employee." },
        ],
        leadForm: {
          name: "Corporate Gifting – Quote request",
          style: "linkedin",
          questions: [
            { key: "number_of_employees", options: ["50–200", "200–1,000", "1,000–5,000", "More than 5,000"] },
            { key: "budget_per_employee", options: ["₹1,500–₹2,500", "₹2,500–₹5,000", "Above ₹5,000"] },
            { key: "delivery_by", options: ["Before Dhanteras", "Before Diwali", "After Diwali"] },
          ],
        },
      },
    ],
  },
  MICROSOFT: {
    externalId: "demo-microsoft-4410",
    name: "Ashniva Retail · Microsoft Ads",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "b1",
        name: "Bing Search – Brand",
        status: "ACTIVE",
        objective: "SEARCH",
        dailyBudget: 2000,
        cpm: 800,
        ctr: 0.075,
        cvr: 0.07,
        aov: 1700,
        startedDaysAgo: 120,
        groups: ["Brand exact", "Brand + category"],
        ads: [
          { name: "RSA – Official store", headline: "Ashniva® Official Store", body: "New festive collection. Easy returns." },
        ],
      },
      {
        key: "b2",
        name: "Audience Network – Remarketing",
        status: "ACTIVE",
        objective: "AUDIENCE",
        dailyBudget: 1800,
        cpm: 70,
        ctr: 0.008,
        cvr: 0.018,
        aov: 1300,
        startedDaysAgo: 50,
        groups: ["Site visitors · 30 days"],
        ads: [{ name: "Multimedia – Bestsellers", headline: "Your favourites are back", body: "Shop the restock." }],
      },
    ],
  },
  SNAPCHAT: {
    externalId: "demo-snapchat-8812",
    name: "Ashniva Retail · Snapchat",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "s1",
        name: "Snap Ads – Gen Z Festive",
        status: "ACTIVE",
        objective: "WEB_CONVERSION",
        dailyBudget: 3000,
        cpm: 60,
        ctr: 0.009,
        cvr: 0.012,
        aov: 1000,
        videoRate: 0.5,
        startedDaysAgo: 35,
        groups: ["18–24 · Metro cities"],
        ads: [
          { name: "Story – Try-on lens", headline: "Try the look", body: "Swipe up to shop." },
          { name: "Single video – 6s bumper", headline: "Festive drop", body: "Limited stock." },
        ],
      },
    ],
  },
  PINTEREST: {
    externalId: "demo-pinterest-2203",
    name: "Ashniva Retail · Pinterest",
    currency: "INR",
    timezone: "Asia/Kolkata",
    campaigns: [
      {
        key: "p1",
        name: "Shopping – Wedding Inspiration",
        status: "ACTIVE",
        objective: "CATALOG_SALES",
        dailyBudget: 2500,
        cpm: 85,
        ctr: 0.011,
        cvr: 0.02,
        aov: 1600,
        startedDaysAgo: 80,
        groups: ["Wedding boards", "Ethnic fashion interest"],
        ads: [
          { name: "Pin – Bridal collection", headline: "Bridal edit 2026", body: "Save ideas for your big day." },
          { name: "Idea pin – Styling guide", headline: "5 lehenga looks", body: "From mehendi to reception." },
        ],
      },
    ],
  },
  AMAZON: sample("demo-amazon-3001", "Ashniva Retail · Amazon", "SPONSORED_PRODUCTS", "Brand keywords", { name: "Sponsored product", headline: "Festive lehenga", body: "Shop the edit on Amazon." }),
  X: sample("demo-x-3002", "Ashniva Retail · X", "WEBSITE_CLICKS", "Timeline · India", { name: "Festive post", headline: "The festive edit is live", body: "Shop the collection." }),
  APPLE: sample("demo-apple-3003", "Ashniva Retail · Apple", "SEARCH", "Brand keywords", { name: "Search results", headline: "Ashniva", body: "Shop ethnic wear." }),
  SPOTIFY: sample("demo-spotify-3004", "Ashniva Retail · Spotify", "REACH", "Music listeners", { name: "30s audio", headline: "Festive edit", body: "Listen, then shop." }),
  CRITEO: sample("demo-criteo-3005", "Ashniva Retail · Criteo", "RETARGETING", "Site visitors", { name: "Homepage banner", headline: "Still thinking it over?", body: "Your picks are waiting." }),
  TABOOLA: sample("demo-taboola-3006", "Ashniva Retail · Taboola", "TRAFFIC", "News readers", { name: "Native story", headline: "5 festive looks", body: "Ideas for the season." }),
  OUTBRAIN: sample("demo-outbrain-3007", "Ashniva Retail · Outbrain", "Traffic", "Publisher network", { name: "Promoted link", headline: "The festive edit", body: "Open the lookbook." }),
  TRADEDESK: sample("demo-ttd-3008", "Ashniva Retail · The Trade Desk", "DISPLAY", "Prospecting", { name: "300×250", headline: "Festive sale", body: "Up to 30% off." }),
  YAHOO: sample("demo-yahoo-3009", "Ashniva Retail · Yahoo DSP", "DISPLAY", "India desktop", { name: "Display line", headline: "Festive sale", body: "Shop the edit." }),
};

/**
 * LinkedIn Campaign Manager flow: Campaign group → Campaign → Creative
 * (Marketing API, versioned REST).
 */
import { adGroupIs, any, budgetFields, ctaOptions, launchSection, locationsField, nameField, opts, scheduleFields, setupIs, urlField } from "../common";
import type { Option, PlatformBuilderSpec } from "../types";

export const LINKEDIN_OBJECTIVES = opts([
  ["BRAND_AWARENESS", "Brand awareness", "Get more people talking about your brand."],
  ["WEBSITE_VISIT", "Website visits", "Drive visitors to your website or landing page."],
  ["ENGAGEMENT", "Engagement", "Get more clicks, likes, comments, shares and followers."],
  ["VIDEO_VIEW", "Video views", "Get more people to watch your videos."],
  ["LEAD_GENERATION", "Lead generation", "Collect leads with forms pre-filled from LinkedIn profiles."],
  ["WEBSITE_CONVERSION", "Website conversions", "Drive purchases, sign-ups or downloads on your site."],
  ["JOB_APPLICANT", "Job applicants", "Promote your job openings."],
]);

const FORMAT_INFO: Record<string, Option> = {
  SINGLE_IMAGE: { value: "SINGLE_IMAGE", label: "Single image ad", description: "An image in the LinkedIn feed.", icon: "Image" },
  VIDEO: { value: "VIDEO", label: "Video ad", description: "A video in the feed.", icon: "Film" },
  CAROUSEL: { value: "CAROUSEL", label: "Carousel image ad", description: "2–10 swipeable image cards.", icon: "GalleryHorizontal" },
  TEXT_AD: { value: "TEXT_AD", label: "Text ad", description: "A small ad on the right of desktop LinkedIn.", icon: "Type" },
  MESSAGE: { value: "MESSAGE", label: "Message ad", description: "A direct message in members' inboxes.", icon: "Mail" },
};

const FORMATS_BY_OBJECTIVE: Record<string, string[]> = {
  BRAND_AWARENESS: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL", "TEXT_AD"],
  WEBSITE_VISIT: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL", "TEXT_AD", "MESSAGE"],
  ENGAGEMENT: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL"],
  VIDEO_VIEW: ["VIDEO"],
  LEAD_GENERATION: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL", "MESSAGE"],
  WEBSITE_CONVERSION: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL", "TEXT_AD", "MESSAGE"],
  JOB_APPLICANT: ["SINGLE_IMAGE"],
};

const GOALS: Record<string, Option[]> = {
  BRAND_AWARENESS: opts([["MAX_REACH", "Reach", "Show ads to as many unique members as possible."], ["MAX_IMPRESSION", "Impressions"]]),
  WEBSITE_VISIT: opts([["MAX_CLICK", "Landing page clicks"], ["MAX_IMPRESSION", "Impressions"]]),
  ENGAGEMENT: opts([["MAX_CLICK", "Engagement clicks"], ["MAX_IMPRESSION", "Impressions"]]),
  VIDEO_VIEW: opts([["MAX_VIDEO_VIEW", "Video views"], ["MAX_IMPRESSION", "Impressions"]]),
  LEAD_GENERATION: opts([["MAX_LEAD", "Leads"], ["MAX_CLICK", "Clicks"], ["MAX_IMPRESSION", "Impressions"]]),
  WEBSITE_CONVERSION: opts([["MAX_CONVERSION", "Website conversions"], ["MAX_CLICK", "Landing page clicks"], ["MAX_IMPRESSION", "Impressions"]]),
  JOB_APPLICANT: opts([["MAX_CLICK", "Landing page clicks"], ["MAX_IMPRESSION", "Impressions"]]),
};

export const LINKEDIN_CTAS = ["LEARN_MORE", "APPLY", "DOWNLOAD", "VIEW_QUOTE", "SIGN_UP", "SUBSCRIBE", "REGISTER", "JOIN", "ATTEND", "REQUEST_DEMO", "SEE_MORE", "BUY_NOW", "SHOP_NOW"];

export const LINKEDIN_JOB_FUNCTIONS = [
  "Accounting", "Administrative", "Arts and Design", "Business Development", "Community and Social Services", "Consulting", "Education",
  "Engineering", "Entrepreneurship", "Finance", "Healthcare Services", "Human Resources", "Information Technology", "Legal", "Marketing",
  "Media and Communication", "Military and Protective Services", "Operations", "Product Management", "Program and Project Management",
  "Purchasing", "Quality Assurance", "Real Estate", "Research", "Sales", "Customer Success and Support",
];

export const LINKEDIN_SENIORITIES = opts([
  ["1", "Unpaid"], ["2", "Training"], ["3", "Entry"], ["4", "Senior"], ["5", "Manager"], ["6", "Director"], ["7", "VP"], ["8", "CXO"], ["9", "Partner"], ["10", "Owner"],
]);

export const LINKEDIN_COMPANY_SIZES = opts([
  ["(1,1)", "Self-employed"], ["(2,10)", "2–10"], ["(11,50)", "11–50"], ["(51,200)", "51–200"], ["(201,500)", "201–500"],
  ["(501,1000)", "501–1,000"], ["(1001,5000)", "1,001–5,000"], ["(5001,10000)", "5,001–10,000"], ["(10001,2147483647)", "10,001+"],
]);

const format = (...f: string[]) => setupIs("format", ...f);
const isLeadGen = setupIs("objective", "LEAD_GENERATION");

export const linkedinSpec: PlatformBuilderSpec = {
  platform: "LINKEDIN",
  setup: [
    { key: "objective", label: "Objective", description: "What results do you want from this campaign?", options: LINKEDIN_OBJECTIVES },
    {
      key: "format",
      label: "Ad format",
      description: "Every creative in the campaign uses this format.",
      showIf: (s) => Boolean(s.objective),
      options: (s) => linkedinFormats(String(s.objective ?? "")),
    },
  ],
  campaign: {
    label: "Campaign group",
    sections: [
      {
        id: "details",
        title: "Campaign group",
        description: "Groups related campaigns so you can manage budget and schedule together.",
        fields: [nameField("Campaign group name", "Q4 Pipeline – India")],
      },
      {
        id: "budget",
        title: "Group budget",
        fields: [
          { key: "groupBudget", type: "toggle", label: "Set a total budget for the group", description: "Optional cap across every campaign in the group.", default: false },
          { key: "groupBudgetAmount", type: "money", label: "Total group budget", required: true, min: 100, showIf: (ctx) => ctx.campaign.groupBudget === true, width: "half" },
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Campaign",
    sections: [
      {
        id: "details",
        title: "Campaign",
        fields: [
          nameField("Campaign name", "Decision makers · IT · India"),
          {
            key: "locale",
            type: "select",
            label: "Profile language",
            help: "Members whose LinkedIn profile is in this language.",
            options: opts([["en_US", "English"], ["fr_FR", "French"], ["de_DE", "German"], ["es_ES", "Spanish"], ["pt_BR", "Portuguese"], ["ar_AE", "Arabic"], ["hi_IN", "Hindi"]]),
            default: "en_US",
            width: "half",
          },
        ],
      },
      {
        id: "audience",
        title: "Audience",
        description: "LinkedIn needs at least 300 members; 50,000+ is recommended for feed ads.",
        fields: [
          locationsField({ help: "Where members live or were recently located." }),
          { key: "jobTitles", type: "targeting", kind: "jobTitle", label: "Job titles", max: 100, ai: { purpose: "LinkedIn job titles of the buyers" } },
          { key: "jobFunctions", type: "multiSelect", label: "Job functions", options: LINKEDIN_JOB_FUNCTIONS.map((f) => ({ value: f, label: f })) },
          { key: "seniorities", type: "checkboxes", label: "Seniority", options: LINKEDIN_SENIORITIES },
          { key: "industries", type: "targeting", kind: "industry", label: "Company industries", max: 100, ai: { purpose: "LinkedIn industries to target" } },
          { key: "companySizes", type: "checkboxes", label: "Company size", options: LINKEDIN_COMPANY_SIZES },
          { key: "companies", type: "targeting", kind: "company", label: "Company names", max: 100, advanced: true },
          { key: "skills", type: "targeting", kind: "skill", label: "Member skills", max: 100, advanced: true, ai: { purpose: "LinkedIn member skills" } },
          { key: "ageRanges", type: "checkboxes", label: "Member age", options: opts([["(18,24)", "18–24"], ["(25,34)", "25–34"], ["(35,54)", "35–54"], ["(55,2147483647)", "55+"]]), advanced: true },
          { key: "genders", type: "segmented", label: "Member gender", options: opts([["ALL", "All"], ["FEMALE", "Female"], ["MALE", "Male"]]), default: "ALL", advanced: true },
          { key: "audienceExpansion", type: "toggle", label: "Audience expansion", description: "Reach people similar to your target audience.", default: false },
          {
            key: "audienceNetwork",
            type: "toggle",
            label: "LinkedIn Audience Network",
            description: "Also show ads on partner apps and sites.",
            default: true,
            showIf: (ctx) => !isLeadGen(ctx) && !format("TEXT_AD", "MESSAGE")(ctx) && !format("CAROUSEL")(ctx),
          },
        ],
      },
      {
        id: "budget",
        title: "Budget & schedule",
        fields: [
          ...budgetFields({ min: 1, help: "LinkedIn's minimum is about USD 10 per day or USD 100 lifetime. It may spend up to 50% more on some days." }),
          ...scheduleFields({ endRequired: adGroupIs("budgetType", "LIFETIME") }),
        ],
      },
      {
        id: "bidding",
        title: "Bidding",
        fields: [
          { key: "optimizationGoal", type: "radio", label: "Optimization goal", options: (ctx) => GOALS[String(ctx.setup.objective)] ?? GOALS.WEBSITE_VISIT!, default: (ctx) => (GOALS[String(ctx.setup.objective)] ?? GOALS.WEBSITE_VISIT!)[0]!.value },
          {
            key: "bidStrategy",
            type: "radio",
            label: "Bidding strategy",
            options: opts([
              ["MAXIMUM_DELIVERY", "Maximum delivery", "LinkedIn spends your budget for the most results. Recommended."],
              ["COST_CAP", "Cost cap", "Keep the average cost per result at or below a cap."],
              ["MANUAL", "Manual bidding", "Set your own maximum bid."],
            ]),
            default: "MAXIMUM_DELIVERY",
          },
          { key: "bidAmount", type: "money", label: "Bid or cost cap", required: true, min: 0.01, showIf: adGroupIs("bidStrategy", "COST_CAP", "MANUAL"), width: "half" },
          { key: "conversions", type: "accountOption", source: "conversionActions", label: "Conversions", multiple: true, required: setupIs("objective", "WEBSITE_CONVERSION"), showIf: any(setupIs("objective", "WEBSITE_CONVERSION"), adGroupIs("optimizationGoal", "MAX_CONVERSION")) },
          {
            key: "rotation",
            type: "segmented",
            label: "Ad rotation",
            options: opts([["OPTIMIZED", "Optimize for performance"], ["ROUND_ROBIN", "Rotate evenly"]]),
            default: "OPTIMIZED",
            advanced: true,
          },
          {
            key: "politicalIntent",
            type: "radio",
            label: "Political ads",
            help: "LinkedIn asks every campaign whether it contains political content.",
            options: opts([["NOT_POLITICAL", "Not political"], ["POLITICAL", "Contains political content"]]),
            default: "NOT_POLITICAL",
            advanced: true,
          },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Creative",
    sections: [
      {
        id: "creative",
        title: "Ad content",
        fields: [
          nameField("Creative name", "Image ad · Free audit offer"),
          { key: "organizationId", type: "accountOption", source: "organizations", label: "Company page", required: (ctx) => ctx.setup.format !== "MESSAGE", autoSelect: true, help: "The LinkedIn Page the ad runs from." },
          { key: "introText", type: "textarea", label: "Introductory text", placeholder: "Struggling to track ad spend across platforms? See every channel in one dashboard.", required: true, maxLength: 600, recommendedLength: 150, rows: 4, showIf: format("SINGLE_IMAGE", "VIDEO", "CAROUSEL"), ai: { purpose: "LinkedIn intro text, professional tone, value in the first 150 characters" } },
          { key: "image", type: "media", label: "Image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["1.91:1", "1:1", "4:5"], showIf: format("SINGLE_IMAGE"), specs: "1200×628 (1.91:1), 1200×1200 (1:1) or 720×900 (4:5). JPG or PNG, up to 5 MB." },
          { key: "video", type: "media", label: "Video", accept: ["VIDEO"], min: 1, max: 1, required: true, ratios: ["16:9", "1:1", "9:16", "4:5"], showIf: format("VIDEO"), specs: "MP4, 3 seconds to 30 minutes (under 30 seconds works best)." },
          {
            key: "cards",
            type: "repeater",
            label: "Cards",
            itemLabel: "Card",
            min: 2,
            max: 10,
            required: true,
            showIf: format("CAROUSEL"),
            fields: [
              { key: "image", type: "media", label: "Card image", accept: ["IMAGE"], min: 1, max: 1, required: true, ratios: ["1:1"], specs: "1080×1080 px" },
              { key: "headline", type: "text", label: "Card headline", placeholder: "Free 20-minute audit", required: true, maxLength: 45, ai: { purpose: "carousel card headline" } },
              { key: "url", type: "url", label: "Card URL", placeholder: "https://yourstore.com/offer", required: true },
            ],
          },
          { key: "headline", type: "text", label: "Headline", placeholder: "Get a free ad account audit", required: true, maxLength: 200, recommendedLength: 70, showIf: format("SINGLE_IMAGE", "VIDEO"), ai: { purpose: "LinkedIn headline under the image" } },
          { key: "description", type: "text", label: "Description", placeholder: "Find wasted spend in 20 minutes.", maxLength: 300, recommendedLength: 100, showIf: format("SINGLE_IMAGE"), advanced: true, help: "Shown on the LinkedIn Audience Network.", ai: { purpose: "short description" } },
          // Text ad
          { key: "textHeadline", type: "text", label: "Headline", placeholder: "Free ad audit", required: true, maxLength: 25, showIf: format("TEXT_AD"), ai: { purpose: "text ad headline" } },
          { key: "textDescription", type: "text", label: "Description", placeholder: "See where your budget goes. Book a call.", required: true, maxLength: 75, showIf: format("TEXT_AD"), ai: { purpose: "text ad description" } },
          { key: "textImage", type: "media", label: "Image (100×100)", accept: ["IMAGE"], min: 0, max: 1, ratios: ["1:1"], showIf: format("TEXT_AD") },
          // Message ad
          { key: "sender", type: "accountOption", source: "profiles", label: "Sender", required: true, showIf: format("MESSAGE"), help: "A person on your team; they must approve sending from their profile in LinkedIn." },
          { key: "subject", type: "text", label: "Subject", placeholder: "Quick idea for your team", required: true, maxLength: 60, showIf: format("MESSAGE"), ai: { purpose: "message ad subject line" } },
          { key: "messageBody", type: "textarea", label: "Message", placeholder: "Hi %FIRSTNAME%, I noticed your team runs ads on several platforms…", required: true, maxLength: 1500, rows: 6, showIf: format("MESSAGE"), ai: { purpose: "personal, conversational message ad body" } },
          { key: "buttonLabel", type: "text", label: "Button text", required: true, maxLength: 20, showIf: format("MESSAGE"), placeholder: "Book a demo" },
          { key: "banner", type: "media", label: "Banner (desktop)", accept: ["IMAGE"], min: 0, max: 1, ratios: ["6:5"], showIf: format("MESSAGE"), specs: "300×250 px" },
          urlField({ label: "Destination URL", showIf: (ctx) => !isLeadGen(ctx) && !format("CAROUSEL")(ctx) }),
          { key: "leadFormId", type: "accountOption", source: "leadForms", label: "Lead gen form", required: true, showIf: isLeadGen, help: "Created in LinkedIn Campaign Manager." },
          { key: "cta", type: "select", label: "Call to action", options: ctaOptions(LINKEDIN_CTAS), default: "LEARN_MORE", showIf: format("SINGLE_IMAGE", "VIDEO", "CAROUSEL") },
        ],
      },
    ],
  }),
  maxAdGroups: 5,
  maxAds: 15,
  apiCreatable: (setup) =>
    setup.format === "MESSAGE" ? "Message ads need the sender's approval inside LinkedIn, so they can't be published from here yet. Choose another format, or create the message in Campaign Manager." : true,
  previews: (ctx) => {
    const f = String(ctx.setup.format);
    if (f === "TEXT_AD") return ["linkedin_text"];
    if (f === "MESSAGE") return ["linkedin_message"];
    return ["linkedin_feed"];
  },
};

export const linkedinFormats = (objective: string) => (FORMATS_BY_OBJECTIVE[objective] ?? []).map((f) => FORMAT_INFO[f]!);

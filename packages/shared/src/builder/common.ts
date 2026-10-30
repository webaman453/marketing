/** Field factories reused across platform specs. */
import { LANGUAGES } from "./geo";
import type { Condition, Field, Option, Section } from "./types";

/** Builds options from [value, label, description?] tuples. */
export const opts = (list: [string, string, string?][]): Option[] => list.map(([value, label, description]) => ({ value, label, description }));

const CTA_LABEL_OVERRIDES: Record<string, string> = {
  APPLY_NOW: "Apply now",
  BOOK_NOW: "Book now",
  CONTACT_US: "Contact us",
  DOWNLOAD: "Download",
  GET_OFFER: "Get offer",
  GET_QUOTE: "Get quote",
  LEARN_MORE: "Learn more",
  SHOP_NOW: "Shop now",
  SIGN_UP: "Sign up",
  SUBSCRIBE: "Subscribe",
  WATCH_MORE: "Watch more",
  ORDER_NOW: "Order now",
  SEND_MESSAGE: "Send message",
  WHATSAPP_MESSAGE: "Send WhatsApp message",
  CALL_NOW: "Call now",
  GET_DIRECTIONS: "Get directions",
  INSTALL_MOBILE_APP: "Install now",
  INSTALL_NOW: "Install now",
  DOWNLOAD_NOW: "Download now",
  MORE: "More",
  VIEW: "View",
  VISIT_SITE: "Visit site",
};

/** "SHOP_NOW" → "Shop now" */
export function ctaLabel(value: string) {
  if (CTA_LABEL_OVERRIDES[value]) return CTA_LABEL_OVERRIDES[value]!;
  const words = value.toLowerCase().split("_");
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(" ");
}

export const ctaOptions = (values: string[]): Option[] => values.map((value) => ({ value, label: ctaLabel(value) }));

export const nameField = (label: string, placeholder: string, maxLength = 255): Field => ({
  key: "name",
  type: "text",
  label,
  placeholder,
  required: true,
  maxLength,
});

/** Daily / lifetime budget with an amount, as most platforms show it. */
export function budgetFields(opts: { min?: number; lifetime?: boolean; help?: string; showIf?: Condition; key?: string }): Field[] {
  const prefix = opts.key ?? "budget";
  const fields: Field[] = [];
  if (opts.lifetime !== false) {
    fields.push({
      key: `${prefix}Type`,
      type: "segmented",
      label: "Budget type",
      options: [
        { value: "DAILY", label: "Daily budget", description: "Average you'll spend every day." },
        { value: "LIFETIME", label: "Lifetime budget", description: "Total for the whole schedule; needs an end date." },
      ],
      default: "DAILY",
      showIf: opts.showIf,
    });
  }
  fields.push({
    key: prefix,
    type: "money",
    label: "Budget",
    placeholder: "1000",
    required: true,
    min: opts.min ?? 1,
    max: 100_000_000,
    help: opts.help,
    showIf: opts.showIf,
    width: "half",
  });
  return fields;
}

export const lifetimeNeedsEnd: Condition = (ctx) => ctx.campaign.budgetType === "LIFETIME" || ctx.adGroup.budgetType === "LIFETIME";

export const scheduleFields = (opts: { endRequired?: Condition; datetime?: boolean; showIf?: Condition } = {}): Field[] => [
  {
    key: "startDate",
    type: opts.datetime ? "datetime" : "date",
    label: "Start date",
    help: "Leave empty to start as soon as it's approved.",
    width: "half",
    showIf: opts.showIf,
  },
  {
    key: "endDate",
    type: opts.datetime ? "datetime" : "date",
    label: "End date",
    required: opts.endRequired,
    help: "Optional unless you use a lifetime budget.",
    width: "half",
    showIf: opts.showIf,
  },
];

/** Pass copy overrides for platforms where "approves the ads" doesn't fit (e.g. Shopify). */
export const launchSection = (
  copy: { paused?: { label?: string; description?: string }; active?: { label?: string; description?: string } } = {},
): Section => ({
  id: "publish",
  title: "When it's published",
  fields: [
    {
      key: "launchStatus",
      type: "radio",
      label: "Status after publishing",
      options: [
        { value: "PAUSED", label: copy.paused?.label ?? "Create paused", description: copy.paused?.description ?? "Check it on the platform, then switch it on here. Recommended." },
        { value: "ACTIVE", label: copy.active?.label ?? "Start delivering", description: copy.active?.description ?? "Goes live as soon as the platform approves the ads." },
      ],
      default: "PAUSED",
    },
  ],
});

export const locationsField = (opts: { help?: string; allowExclude?: boolean } = {}): Field => ({
  key: "locations",
  type: "targeting",
  kind: "location",
  label: "Locations",
  required: true,
  allowExclude: opts.allowExclude ?? true,
  max: 250,
  help: opts.help ?? "Countries, regions or cities. Search and add as many as you need.",
  default: [{ id: "IN", name: "India", type: "country" }],
});

export const languagesField = (opts: { help?: string; showIf?: Condition; required?: boolean } = {}): Field => ({
  key: "languages",
  type: "multiSelect",
  label: "Languages",
  options: LANGUAGES.map((l) => ({ value: l.code, label: l.name })),
  help: opts.help ?? "Leave empty to reach people in any language.",
  showIf: opts.showIf,
  required: opts.required,
});

export const genderField = (options: Option[] = opts([["ALL", "All"], ["FEMALE", "Women"], ["MALE", "Men"]])): Field => ({
  key: "gender",
  type: "segmented",
  label: "Gender",
  options,
  default: "ALL",
});

export const urlField = (opts: { key?: string; label?: string; help?: string; required?: boolean | Condition; showIf?: Condition } = {}): Field => ({
  key: opts.key ?? "url",
  type: "url",
  label: opts.label ?? "Website URL",
  placeholder: "https://yourstore.com/sale",
  required: opts.required ?? true,
  maxLength: 2048,
  help: opts.help,
  showIf: opts.showIf,
});

export const urlParamsField = (): Field => ({
  key: "urlParams",
  type: "text",
  label: "URL parameters",
  placeholder: "utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}",
  help: "Added to the end of your website URL for tracking.",
  advanced: true,
  maxLength: 1000,
});

export const infoField = (key: string, label: string, help: string, tone: "info" | "warning" = "info", showIf?: Condition): Field => ({
  key,
  type: "info",
  label,
  help,
  tone,
  showIf,
});

export const setupIs = (key: string, ...values: string[]): Condition => (ctx) => values.includes(String(ctx.setup[key] ?? ""));
export const campaignIs = (key: string, ...values: string[]): Condition => (ctx) => values.includes(String(ctx.campaign[key] ?? ""));
export const adGroupIs = (key: string, ...values: string[]): Condition => (ctx) => values.includes(String(ctx.adGroup[key] ?? ""));
export const adIs = (key: string, ...values: string[]): Condition => (ctx) => values.includes(String(ctx.ad[key] ?? ""));
export const not = (c: Condition): Condition => (ctx) => !c(ctx);
export const all = (...cs: Condition[]): Condition => (ctx) => cs.every((c) => c(ctx));
export const any = (...cs: Condition[]): Condition => (ctx) => cs.some((c) => c(ctx));

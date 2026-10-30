/** Naukri job post: Hot vacancy or Classified. Publishing needs Naukri's partner API. */
import { infoField, launchSection, nameField, not, opts, setupIs } from "../common";
import type { BuilderIssue, PlatformBuilderSpec } from "../types";

const CLASSIFIED_LIMIT = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const classified = setupIs("posting", "CLASSIFIED");

export const naukriSpec: PlatformBuilderSpec = {
  platform: "NAUKRI",
  setup: [
    {
      key: "posting",
      label: "Posting type",
      description: "Hot vacancy is the branded listing. Classified is the short text listing.",
      options: opts([
        ["HOT", "Hot vacancy", "Logo, long description and job alerts."],
        ["CLASSIFIED", "Classified", "Short fields, about 254 characters."],
      ]),
    },
  ],
  campaign: {
    label: "Job",
    sections: [
      {
        id: "role",
        title: "Job",
        fields: [
          nameField("Job title", "Senior backend engineer", 120),
          { key: "description", type: "textarea", label: "Description", required: true, rows: 5, maxLength: 4000, showIf: not(classified) },
          { key: "description", type: "textarea", label: "Description", required: true, rows: 3, maxLength: CLASSIFIED_LIMIT, showIf: classified, help: `Classified posts allow up to ${CLASSIFIED_LIMIT} characters.` },
          { key: "minExperience", type: "number", label: "Minimum experience (years)", required: true, min: 0, max: 50, width: "half" },
          { key: "maxExperience", type: "number", label: "Maximum experience (years)", required: true, min: 0, max: 50, width: "half" },
          { key: "minSalary", type: "number", label: "Minimum salary", required: true, min: 0, width: "half" },
          { key: "maxSalary", type: "number", label: "Maximum salary", required: true, min: 0, width: "half" },
          { key: "currency", type: "text", label: "Salary currency", placeholder: "INR", required: true, maxLength: 8, width: "half", default: "INR" },
          { key: "vacancies", type: "number", label: "Vacancies", required: true, min: 1, max: 999, width: "half" },
          infoField("naukriNote", "Publish with a Naukri key", "Naukri shares a Zwayam Amplify key only with a paid recruiter subscription. This form cannot post the job until that API is opened for this account.", "warning"),
        ],
      },
      launchSection(),
    ],
  },
  adGroup: {
    label: "Location",
    sections: [
      {
        id: "place",
        title: "Where and what",
        fields: [
          nameField("Location name", "Bengaluru"),
          { key: "city", type: "text", label: "City", required: true },
          { key: "industry", type: "text", label: "Industry", required: true },
          { key: "functionalArea", type: "text", label: "Functional area", required: true },
        ],
      },
    ],
  },
  ad: () => ({
    label: "Posting",
    sections: [
      {
        id: "contact",
        title: "Contact",
        fields: [
          nameField("Posting name", "Careers page"),
          { key: "contact", type: "text", label: "Contact email", placeholder: "careers@yourcompany.com", required: true, maxLength: 120, help: "The recruiter email Naukri should show." },
        ],
      },
    ],
  }),
  maxAdGroups: 5,
  maxAds: 1,
  previews: () => ["linkedin_feed"],
  apiCreatable: () => "Naukri has no public ads API, so campaigns can't be published from here yet.",
  validate: (draft) => {
    const issues: BuilderIssue[] = [];
    const c = draft.campaign;
    const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
    const pairs: [string, string, string][] = [
      ["minExperience", "maxExperience", "Maximum experience must be at least the minimum."],
      ["minSalary", "maxSalary", "Maximum salary must be at least the minimum."],
    ];
    for (const [lo, hi, message] of pairs) {
      const a = n(c[lo]);
      const b = n(c[hi]);
      if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && a > b) issues.push({ level: "campaign", field: hi, message });
    }
    for (const g of draft.adGroups) {
      for (const a of g.ads) {
        const email = typeof a.values.contact === "string" ? a.values.contact.trim() : "";
        if (email && !EMAIL.test(email)) issues.push({ level: "ad", nodeKey: a.key, field: "contact", message: "Enter a valid contact email." });
      }
    }
    return issues;
  },
};

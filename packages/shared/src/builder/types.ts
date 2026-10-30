/**
 * Campaign builder specs. Each platform describes its native creation flow
 * (campaign → ad set/ad group → ad) as data: sections of typed fields with
 * limits, defaults and conditions. The same spec drives the form, validation
 * on both client and server, the AI fill, and what each connector reads.
 */
import type { Platform } from "../platforms";

export type Values = Record<string, unknown>;

/** The values a field's conditions and validators can see. */
export interface FieldContext {
  setup: Values;
  campaign: Values;
  adGroup: Values;
  ad: Values;
}

export type Condition = (ctx: FieldContext) => boolean;

export interface Option {
  value: string;
  label: string;
  description?: string;
  /** lucide icon name the UI may show next to the option */
  icon?: string;
  badge?: string;
}

/** Account-level things the builder loads from the platform (pages, pixels, identities…). */
export type AccountOptionKind =
  | "pages"
  | "instagramAccounts"
  | "pixels"
  | "conversionEvents"
  | "conversionActions"
  | "leadForms"
  | "identities"
  | "organizations"
  | "profiles"
  | "youtubeChannels"
  | "apps"
  | "catalogs"
  | "merchantCenters"
  | "audiences"
  | "boards";

export const TARGETING_KINDS = ["location", "interest", "behavior", "jobTitle", "industry", "skill", "company", "language"] as const;
export type TargetingKind = (typeof TARGETING_KINDS)[number];

interface FieldBase {
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
  /** Required unless the condition says otherwise. */
  required?: boolean | Condition;
  showIf?: Condition;
  /** Hidden behind "More options" in its section. */
  advanced?: boolean;
  /** Layout hint */
  width?: "full" | "half" | "third";
  /** The AI fill may write this field; `purpose` steers what it writes. */
  ai?: { purpose: string };
}

export interface TextField extends FieldBase {
  type: "text" | "textarea" | "url";
  maxLength?: number;
  /** Shown as a soft warning above this length (platforms truncate). */
  recommendedLength?: number;
  minLength?: number;
  rows?: number;
  default?: string;
  /** Prefix shown inside the input, e.g. "yourstore.com/" */
  prefix?: string;
}

export interface TextListField extends FieldBase {
  type: "textList";
  maxLength: number;
  recommendedLength?: number;
  min: number;
  max: number;
  /** Rows shown when the list is empty */
  initial?: number;
  itemLabel: string;
  multiline?: boolean;
  /** Per-item pinning (Google RSA headline positions) */
  pinnable?: { positions: string[] };
}

export interface NumberField extends FieldBase {
  type: "number" | "money" | "percent";
  min?: number;
  max?: number;
  step?: number;
  default?: number;
  suffix?: string;
}

export interface ChoiceField extends FieldBase {
  type: "select" | "radio" | "cards" | "segmented";
  options: Option[] | ((ctx: FieldContext) => Option[]);
  default?: string | ((ctx: FieldContext) => string);
}

export interface MultiChoiceField extends FieldBase {
  type: "multiSelect" | "chips" | "checkboxes";
  options: Option[] | ((ctx: FieldContext) => Option[]);
  default?: string[];
  min?: number;
  max?: number;
}

export interface ToggleField extends FieldBase {
  type: "toggle";
  default?: boolean;
  /** Text next to the switch */
  description?: string;
}

export interface DateField extends FieldBase {
  type: "date" | "datetime";
}

export interface AccountOptionField extends FieldBase {
  type: "accountOption";
  source: AccountOptionKind;
  /** Pick the only option automatically */
  autoSelect?: boolean;
  multiple?: boolean;
}

export interface TargetingField extends FieldBase {
  type: "targeting";
  kind: TargetingKind;
  max?: number;
  /** Include/exclude toggle (locations) */
  allowExclude?: boolean;
  default?: TargetingValue[];
}

export interface KeywordsField extends FieldBase {
  type: "keywords";
  matchTypes: ("BROAD" | "PHRASE" | "EXACT")[];
  max: number;
  min?: number;
  /** Negative keywords instead of positive ones */
  negative?: boolean;
}

export interface AgeRangeField extends FieldBase {
  type: "ageRange";
  min: number;
  max: number;
  /** Rendered as "65+" when max is selected */
  openEnded?: boolean;
  default?: { min: number; max: number };
}

export interface PlacementsField extends FieldBase {
  type: "placements";
  groups: { id: string; label: string; items: Option[] }[];
  /** Label for the automatic option, e.g. "Advantage+ placements" */
  autoLabel: string;
  autoDescription: string;
}

export interface MediaField extends FieldBase {
  type: "media";
  accept: ("IMAGE" | "VIDEO")[];
  min: number;
  max: number;
  /** Recommended aspect ratios, e.g. ["1:1", "4:5", "9:16"] */
  ratios?: string[];
  /** Hard-required ratio when the platform rejects anything else */
  requiredRatio?: string;
  specs?: string;
}

export interface RepeaterField extends FieldBase {
  type: "repeater";
  itemLabel: string;
  min: number;
  max: number;
  fields: Field[];
}

export interface ScheduleField extends FieldBase {
  type: "adSchedule";
}

export interface InfoField extends FieldBase {
  type: "info";
  tone?: "info" | "warning";
}

export type Field =
  | TextField
  | TextListField
  | NumberField
  | ChoiceField
  | MultiChoiceField
  | ToggleField
  | DateField
  | AccountOptionField
  | TargetingField
  | KeywordsField
  | AgeRangeField
  | PlacementsField
  | MediaField
  | RepeaterField
  | ScheduleField
  | InfoField;

export type FieldType = Field["type"];

export interface Section {
  id: string;
  title: string;
  description?: string;
  showIf?: Condition;
  fields: Field[];
}

export interface LevelSpec {
  /** Platform naming, e.g. "Ad set" */
  label: string;
  sections: Section[];
}

export type SetupOption = Option & { disabled?: boolean; disabledReason?: string };

export interface SetupChoice {
  key: string;
  label: string;
  description: string;
  options: SetupOption[] | ((setup: Values) => SetupOption[]);
  showIf?: (setup: Values) => boolean;
}

export type PlacementPreview =
  | "fb_feed"
  | "ig_feed"
  | "ig_story"
  | "ig_reels"
  | "fb_reels"
  | "fb_right_column"
  | "messenger_inbox"
  | "google_search_mobile"
  | "google_search_desktop"
  | "google_display"
  | "google_display_native"
  | "gmail"
  | "discover"
  | "youtube_instream"
  | "youtube_infeed"
  | "youtube_shorts"
  | "youtube_bumper"
  | "google_shopping"
  | "tiktok_feed"
  | "linkedin_feed"
  | "linkedin_text"
  | "linkedin_message"
  | "bing_search"
  | "bing_audience"
  | "snap_story"
  | "pinterest_grid"
  | "pinterest_closeup"
  | "x_feed"
  | "app_store_search"
  | "amazon_shopping"
  | "spotify_audio"
  | "native_feed"
  | "display_banner"
  | "video_instream";

export interface PlatformBuilderSpec {
  platform: Platform;
  /** Choices made on the start screen (objective, campaign type…). */
  setup: SetupChoice[];
  campaign: LevelSpec;
  adGroup: LevelSpec;
  /** null when ads live inside the ad group (e.g. Performance Max asset groups). */
  ad: (setup: Values) => LevelSpec | null;
  maxAdGroups: number;
  maxAds: number;
  /** Which previews apply to an ad, most important first. */
  previews: (ctx: FieldContext) => PlacementPreview[];
  /** Cross-field checks the field rules can't express. */
  validate?: (draft: BuilderDraft) => BuilderIssue[];
  /** Whether the real platform API can create this setup; false = sample/demo only. */
  apiCreatable?: (setup: Values) => boolean | string;
}

// ───────── Draft ─────────

export interface AdNode {
  key: string;
  values: Values;
}

export interface AdGroupNode {
  key: string;
  values: Values;
  ads: AdNode[];
}

/** Stored in campaign_drafts.payload */
export interface BuilderDraft {
  version: 2;
  platform: Platform;
  adAccountId: string;
  setup: Values;
  campaign: Values;
  adGroups: AdGroupNode[];
}

export type IssueLevel = "setup" | "campaign" | "adGroup" | "ad";

export interface BuilderIssue {
  level: IssueLevel;
  /** AdGroupNode/AdNode key; absent for campaign-level issues */
  nodeKey?: string;
  field?: string;
  message: string;
}

// ───────── Value shapes for complex fields ─────────

export interface TargetingValue {
  id: string;
  name: string;
  /** e.g. "country", "region", "city" for locations */
  type?: string;
  /** ISO country of a region/city location */
  countryCode?: string;
  exclude?: boolean;
}

export interface KeywordValue {
  text: string;
  matchType: "BROAD" | "PHRASE" | "EXACT";
}

export interface PlacementsValue {
  mode: "AUTO" | "MANUAL";
  items: string[];
}

export interface PinnedText {
  text: string;
  pin?: string | null;
}

export interface AdScheduleValue {
  /** Day → [startHour, endHour) list; empty means all day */
  days: Partial<Record<"MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN", [number, number][]>>;
}

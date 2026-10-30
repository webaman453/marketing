/**
 * Sample form leads for the demo connector's lead-gen campaigns. Each ad gets as
 * many leads on a day as it had conversions that day, so cost per lead lines up
 * with the sample spend. Same account and day → same people on every sync.
 */
import { addDays } from "@ashniva/shared";
import { builderZone, dayIn } from "../builder-values";
import type { ExternalLead, ExternalMetricRow } from "../types";
import { demoIds, type DemoAccountSpec, type DemoLeadForm } from "./catalog";
import { between, pick, rand } from "./random";

/** Leads cover this many recent days. */
export const DEMO_LEAD_DAYS = 30;

const WOMEN = ["Aanya", "Priya", "Ananya", "Diya", "Isha", "Kavya", "Meera", "Neha", "Pooja", "Riya", "Sanya", "Shreya", "Tanvi", "Aditi", "Nisha", "Sneha", "Divya", "Anjali", "Ritika", "Swati", "Pallavi", "Bhavna", "Simran", "Zoya", "Fatima", "Lakshmi", "Deepika", "Harini"];
const MEN = ["Aarav", "Vivaan", "Arjun", "Rohan", "Karan", "Rahul", "Vikram", "Siddharth", "Aditya", "Nikhil", "Amit", "Rajesh", "Sameer", "Varun", "Manish", "Suresh", "Imran", "Gaurav", "Harsh", "Pranav"];
const SURNAMES = ["Sharma", "Verma", "Iyer", "Nair", "Reddy", "Patel", "Shah", "Mehta", "Gupta", "Kapoor", "Malhotra", "Agarwal", "Joshi", "Kulkarni", "Desai", "Banerjee", "Chatterjee", "Das", "Singh", "Khan", "Menon", "Pillai", "Rao", "Bhat", "Chopra", "Saxena", "Mishra", "Pandey"];
const COMPANIES = ["Sunrise Retail", "Kaveri Textiles", "Lotus Lifestyle", "Bluestone Traders", "Metro Fashion Hub", "Saffron Boutiques", "Northwind Apparel", "Zenith Infotech", "Pinnacle Finserv", "Orbit Software", "Greenleaf Pharma", "Vertex Logistics"];
const TITLES = ["Founder", "Owner", "Store Manager", "Procurement Manager", "Category Head", "HR Manager", "Admin Head", "Head of People", "Operations Manager", "Purchase Executive"];

// Share of a day's leads submitted in each local hour: evenings and lunch for people
// browsing on their phones, office hours for B2B forms.
const CONSUMER_HOURS = [1.1, 0.6, 0.3, 0.2, 0.2, 0.3, 0.6, 1.2, 2, 2.7, 3.2, 3.5, 3.6, 3.3, 3, 3, 3.1, 3.4, 3.9, 4.5, 4.9, 4.7, 3.6, 2.2];
const B2B_HOURS = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.9, 2, 3.6, 4.5, 4.6, 4.1, 3.4, 3.9, 4.2, 4, 3.5, 2.6, 1.8, 1.3, 1, 0.7, 0.4];

function pickHour(key: string, weights: number[]) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand(key) * total;
  for (let h = 0; h < weights.length; h++) {
    r -= weights[h]!;
    if (r < 0) return h;
  }
  return weights.length - 1;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
/** Minutes `timeZone` is ahead of UTC at `at`. */
function offsetMinutes(timeZone: string, at: Date) {
  let f = offsetFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    offsetFormats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  const local = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** The instant of a local wall-clock time on `date` (YYYY-MM-DD) in `timeZone`. */
function localTime(date: string, timeZone: string, hour: number, minute: number, second: number) {
  const wall = Date.parse(`${date}T00:00:00Z`) + ((hour * 60 + minute) * 60 + second) * 1000;
  return new Date(wall - offsetMinutes(timeZone, new Date(wall)) * 60_000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

/** A clearly fictional person: example.com email and a +91 98765 phone number. */
function person(key: string, form: DemoLeadForm) {
  const woman = rand(`${key}|w`) < (form.style === "meta" ? 0.88 : 0.45);
  const first = pick(`${key}|first`, woman ? WOMEN : MEN);
  const last = pick(`${key}|last`, SURNAMES);
  const n = Math.floor(between(`${key}|n`, 1, 99));
  const email = `${slug(first)}.${slug(last)}${n}@example.com`;
  const phone = `+91 98765 ${String(Math.floor(rand(`${key}|phone`) * 100_000)).padStart(5, "0")}`;
  return { first, last, email, phone };
}

function answers(key: string, form: DemoLeadForm): Record<string, string[]> {
  const p = person(key, form);
  const contact: Record<string, string[]> =
    form.style === "meta"
      ? { full_name: [`${p.first} ${p.last}`], email: [p.email], phone_number: [p.phone] }
      : {
          first_name: [p.first],
          last_name: [p.last],
          email: [p.email],
          phone_number: [p.phone],
          company_name: [pick(`${key}|company`, COMPANIES)],
          job_title: [pick(`${key}|title`, TITLES)],
        };
  for (const q of form.questions) contact[q.key] = [pick(`${key}|${q.key}`, q.options)];
  return contact;
}

/**
 * Leads for the account's lead-gen campaigns, given the account's ad-level metric rows
 * for the last DEMO_LEAD_DAYS days. Only leads submitted by `now` (and after `since`) are returned.
 */
export function generateDemoLeads(
  account: DemoAccountSpec,
  adRows: ExternalMetricRow[],
  opts: { since: Date | null; now?: Date },
): ExternalLead[] {
  const now = opts.now ?? new Date();
  // Metric dates are days in the account's zone, so the window starts on the account's day too.
  const from = addDays(dayIn(now, builderZone(account)), -(DEMO_LEAD_DAYS - 1));
  const byAd = new Map<string, ExternalMetricRow[]>();
  for (const r of adRows) {
    if (r.level !== "AD" || r.date < from) continue;
    byAd.set(r.externalId, [...(byAd.get(r.externalId) ?? []), r]);
  }

  const leads: ExternalLead[] = [];
  for (const c of account.campaigns) {
    const form = c.leadForm;
    if (!form) continue;
    const id = demoIds(account, c);
    const hours = form.style === "meta" ? CONSUMER_HOURS : B2B_HOURS;
    c.groups.forEach((groupName, gi) => {
      c.ads.forEach((ad, ai) => {
        const adId = id.ad(gi, ai);
        for (const row of byAd.get(adId) ?? []) {
          // Whole leads: the fractional part of the day's conversions becomes one more lead that often.
          const whole = Math.floor(row.conversions);
          const count = whole + (rand(`${adId}|${row.date}|extra`) < row.conversions - whole ? 1 : 0);
          for (let i = 0; i < count; i++) {
            const key = `${adId}|${row.date}|${i}`;
            const createdTime = localTime(
              row.date,
              account.timezone,
              pickHour(`${key}|h`, hours),
              Math.floor(rand(`${key}|m`) * 60),
              Math.floor(rand(`${key}|s`) * 60),
            );
            if (createdTime > now || (opts.since && createdTime <= opts.since)) continue;
            leads.push({
              externalId: `${adId}-${row.date}-${i}`,
              createdTime,
              source: form.style === "meta" ? (rand(`${key}|src`) < (form.instagramShare ?? 0.4) ? "ig" : "fb") : null,
              isOrganic: false,
              pageId: form.style === "meta" ? `${account.externalId}-page` : null,
              formId: `${id.campaign}-form`,
              formName: form.name,
              externalAdId: adId,
              externalAdGroupId: id.group(gi),
              externalCampaignId: id.campaign,
              adName: ad.name,
              adGroupName: groupName,
              campaignName: c.name,
              fields: answers(key, form),
            });
          }
        }
      });
    });
  }
  return leads.sort((a, b) => b.createdTime.getTime() - a.createdTime.getTime());
}

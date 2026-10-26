import { BRAND, PAID_PLANS, PLATFORM_INFO, VISIBLE_PLATFORMS, catalogSchema, defaultCatalog, money, type Catalog } from "@ashniva/shared";
import {
  ArrowRight,
  BarChart3,
  Bot,
  Building2,
  CheckCircle2,
  FileText,
  Rocket,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { ProductPreview } from "@/components/marketing/product-preview";
import { PlatformIcon } from "@/components/platform-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const FEATURES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: BarChart3,
    title: "One dashboard for every platform",
    body: "Spend, conversions, CPA and ROAS from Meta, Google, YouTube, TikTok, LinkedIn and more, side by side.",
  },
  {
    icon: Rocket,
    title: "Build once, launch everywhere",
    body: "Create a campaign one time and launch it on Meta and Google together, with per-platform checks before it goes live.",
  },
  {
    icon: Bot,
    title: "Automation rules",
    body: "Pause poor performers, scale winners and get alerts automatically, with previews and a full run history.",
  },
  {
    icon: FileText,
    title: "Client-ready reports",
    body: "White-label PDF and Excel reports, emailed on schedule or shared as a live link with your branding.",
  },
  {
    icon: Sparkles,
    title: "AI assistant",
    body: "Generate on-brand ad copy within each platform's limits, and get plain-language insights on what to change.",
  },
  {
    icon: Building2,
    title: "Built for agencies",
    body: "A workspace per client, roles and permissions, an audit trail for every change and a public API.",
  },
];

const STEPS = [
  { title: "Create your workspace", body: "Sign up in under a minute. Add a workspace for each brand or client." },
  { title: "Connect your ad accounts", body: "Sign in with Meta and Google once. Pick which accounts belong where." },
  { title: "Manage everything here", body: "Track performance, adjust budgets and keep your team aligned." },
];

/** The owner's price list from the API; the shipped defaults if the API can't be reached. */
async function loadCatalog(): Promise<Catalog> {
  try {
    const res = await fetch(`${process.env.API_URL ?? "http://localhost:4100"}/api/catalog`, { next: { revalidate: 60 } });
    const parsed = catalogSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : defaultCatalog();
  } catch {
    return defaultCatalog();
  }
}

export default async function LandingPage() {
  const catalog = await loadCatalog();
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_70%_50%_at_50%_-10%,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)]" />
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]" />
        <div className="mx-auto max-w-6xl px-5 pt-16 pb-20 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center animate-fade-up">
            <Badge variant="outline" className="mb-6 gap-1.5 bg-card px-3 py-1 text-xs font-medium">
              <span className="size-1.5 rounded-full bg-success" />
              7 ad platforms · campaign builder · AI assistant
            </Badge>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl">
              Every ad platform.
              <br />
              <span className="bg-gradient-to-r from-primary to-[oklch(0.55_0.2_300)] bg-clip-text text-transparent">
                One command center.
              </span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground text-pretty">
              {BRAND.name} brings your Meta, Google, YouTube and other ad accounts into one workspace, so your team can
              see what&apos;s working and act on it without switching tabs.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button asChild size="lg" className="h-11 px-6">
                <Link href="/signup">
                  Get started <ArrowRight />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="h-11 bg-card px-6">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">Choose a plan to start using your workspace</p>
          </div>
          <div className="mx-auto mt-16 max-w-5xl animate-fade-up [animation-delay:120ms]">
            <ProductPreview />
          </div>
        </div>
      </section>

      {/* Platforms */}
      <section id="platforms" className="scroll-mt-20 border-y bg-card">
        <div className="mx-auto max-w-6xl px-5 py-12">
          <p className="text-center text-sm font-medium text-muted-foreground">Works with the platforms your budget lives on</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {VISIBLE_PLATFORMS.map((p) => {
              const live = PLATFORM_INFO[p].availability === "live";
              return (
                <span key={p} className="inline-flex items-center gap-2.5 rounded-full border bg-background py-1.5 pr-4 pl-1.5 text-sm">
                  <PlatformIcon platform={p} size="md" className="rounded-full" />
                  <span className="font-medium">{PLATFORM_INFO[p].name}</span>
                  {!live && <span className="text-xs text-muted-foreground">soon</span>}
                </span>
              );
            })}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold text-primary">Why teams switch</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Less tab-switching. More decisions.</h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Everything a performance marketing team needs to run paid media across platforms.
            </p>
          </div>
          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-card p-7 transition-colors hover:bg-muted/30">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <f.icon className="size-5" />
                </span>
                <h3 className="mt-5 font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-20 border-y bg-card">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold text-primary">How it works</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Up and running in minutes</h2>
          </div>
          <ol className="mt-14 grid gap-8 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="relative rounded-2xl border bg-background p-7">
                <span className="flex size-9 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                  {i + 1}
                </span>
                <h3 className="mt-5 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="scroll-mt-20">
        <div className="mx-auto max-w-6xl px-5 py-24">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold text-primary">Pricing</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Plans that grow with your client list</h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Pick the plan that fits your team. Sign-up stays read-only until a plan is chosen.
              {catalog.gstPercent > 0 && ` Prices exclude ${catalog.gstPercent}% GST.`}
            </p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {PAID_PLANS.map((id) => {
              const p = catalog.plans[id];
              const featured = p.popular;
              return (
                <div
                  key={id}
                  className={`flex flex-col rounded-2xl border bg-card p-7 ${featured ? "shadow-xl shadow-primary/10 ring-2 ring-primary" : ""}`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">{p.name}</h3>
                    {featured && <Badge>Most popular</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{p.audience}</p>
                  <p className="mt-5">
                    <span className="text-3xl font-semibold tracking-tight">{money(p.priceMonthly, "INR")}</span>
                    <span className="text-sm text-muted-foreground"> /month</span>
                  </p>
                  <ul className="mt-6 space-y-3 text-sm">
                    {p.highlights.map((pt) => (
                      <li key={pt} className="flex items-center gap-2.5">
                        <CheckCircle2 className="size-4 text-primary" /> {pt}
                      </li>
                    ))}
                  </ul>
                  <Button asChild variant={featured ? "default" : "outline"} className="mt-8 w-full">
                    <Link href="/signup">Get started</Link>
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-5 pb-24">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl bg-[oklch(0.24_0.06_270)] px-8 py-16 text-center text-white sm:px-16">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_80%_at_50%_0%,oklch(0.5_0.2_266/0.55),transparent)]" />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Bring your ad accounts together today</h2>
            <p className="mx-auto mt-4 max-w-xl text-white/70">
              Set up your first workspace in minutes. Explore with sample data while your platform access is approved.
            </p>
            <Button asChild size="lg" className="mt-8 h-11 bg-white px-6 text-[oklch(0.24_0.06_270)] hover:bg-white/90">
              <Link href="/signup">
                Get started <ArrowRight />
              </Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}

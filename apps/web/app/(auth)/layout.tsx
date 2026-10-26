import { BRAND, PLATFORM_INFO, VISIBLE_PLATFORMS } from "@ashniva/shared";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { PlatformIcon } from "@/components/platform-icon";

const POINTS = [
  "Connect Meta, Google, YouTube and more in minutes",
  "One dashboard for spend, conversions and ROAS",
  "Pause campaigns and change budgets without switching tabs",
  "Workspaces, roles and an audit trail for every change",
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-10">
        <Link href="/" className="w-fit">
          <Logo />
        </Link>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[380px] animate-fade-up">{children}</div>
        </div>
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} {BRAND.company} ·{" "}
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>{" "}
          ·{" "}
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
        </p>
      </div>

      <aside className="relative hidden overflow-hidden bg-[oklch(0.24_0.06_270)] lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_70%_10%,oklch(0.5_0.2_266/0.55),transparent_70%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgb(255_255_255/0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.04)_1px,transparent_1px)] bg-[size:44px_44px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_80%)]" />
        <div className="relative z-10 flex w-full flex-col justify-between p-12 text-white xl:p-16">
          <div className="flex flex-wrap gap-2">
            {VISIBLE_PLATFORMS.map((p) => (
              <span
                key={p}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] py-1 pr-3 pl-1 text-xs text-white/80 backdrop-blur"
              >
                <PlatformIcon platform={p} size="sm" className="rounded-full" />
                {PLATFORM_INFO[p].name.replace(" Ads", "")}
              </span>
            ))}
          </div>

          <div className="max-w-md">
            <h2 className="text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">
              Every ad platform.
              <br />
              <span className="text-white/60">One command center.</span>
            </h2>
            <ul className="mt-8 space-y-3.5">
              {POINTS.map((p) => (
                <li key={p} className="flex items-start gap-3 text-[15px] text-white/80">
                  <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-[oklch(0.78_0.12_266)]" />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <div className="flex max-w-md items-start gap-3 rounded-xl border border-white/10 bg-white/[0.05] p-5 backdrop-blur">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-[oklch(0.78_0.12_266)]" />
            <div>
              <p className="text-sm font-medium text-white/90">Secure by design</p>
              <p className="mt-1 text-sm leading-relaxed text-white/65">
                Platform access tokens are encrypted at rest, every action is permission-checked, and every change is
                recorded in your activity log.
              </p>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

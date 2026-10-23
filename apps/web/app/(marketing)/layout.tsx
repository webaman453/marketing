import { BRAND } from "@ashniva/shared";
import Link from "next/link";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-transparent bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/65">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
          <Link href="/" aria-label={`${BRAND.name} home`}>
            <Logo />
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <Link href="/#features" className="transition-colors hover:text-foreground">Features</Link>
            <Link href="/#platforms" className="transition-colors hover:text-foreground">Platforms</Link>
            <Link href="/#how" className="transition-colors hover:text-foreground">How it works</Link>
            <Link href="/#pricing" className="transition-colors hover:text-foreground">Pricing</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href="/login">Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/signup">Get started</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t bg-card">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3 lg:col-span-2">
            <Logo />
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              Run, measure and report on every ad platform from one place. Built for marketing teams and agencies.
            </p>
          </div>
          <div className="space-y-3 text-sm">
            <h3 className="font-semibold">Product</h3>
            <ul className="space-y-2 text-muted-foreground">
              <li><Link href="/#features" className="hover:text-foreground">Features</Link></li>
              <li><Link href="/#platforms" className="hover:text-foreground">Integrations</Link></li>
              <li><Link href="/#pricing" className="hover:text-foreground">Pricing</Link></li>
            </ul>
          </div>
          <div className="space-y-3 text-sm">
            <h3 className="font-semibold">Company</h3>
            <ul className="space-y-2 text-muted-foreground">
              <li><Link href="/privacy" className="hover:text-foreground">Privacy policy</Link></li>
              <li><Link href="/terms" className="hover:text-foreground">Terms of service</Link></li>
              <li><a href={`mailto:${BRAND.supportEmail}`} className="hover:text-foreground">{BRAND.supportEmail}</a></li>
            </ul>
          </div>
        </div>
        <div className="border-t">
          <p className="mx-auto max-w-6xl px-5 py-5 text-xs text-muted-foreground">
            © {new Date().getFullYear()} {BRAND.company}. All rights reserved. Meta, Google, YouTube, TikTok and LinkedIn
            are trademarks of their respective owners.
          </p>
        </div>
      </footer>
    </div>
  );
}

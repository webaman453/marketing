/** Typography wrapper for long-form legal content. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <header className="mb-10 border-b pb-8">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-muted-foreground">Last updated {updated}</p>
      </header>
      <div className="space-y-8 text-[15px] leading-7 text-foreground/85 [&_a]:font-medium [&_a]:text-primary [&_a]:underline-offset-4 hover:[&_a]:underline [&_h2]:mb-3 [&_h2]:scroll-mt-24 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_p+p]:mt-3 [&_ul]:mt-3 [&_ul]:space-y-1.5">
        {children}
      </div>
    </article>
  );
}

# Ashniva Ads

Multi-tenant SaaS for running and measuring ads across Meta, Google (incl. YouTube) and more from one dashboard.

**Stack:** Next.js 16 (web) · Node.js + Express 5 (API) · PostgreSQL + Prisma 7 · Redis + BullMQ (sync worker) · TypeScript everywhere · Tailwind 4 + shadcn/ui.

## Project layout

```
apps/
  web/        Next.js app: marketing site, auth pages, dashboard (port 3100)
  api/        Express REST API (port 4100), proxied by web at /api/*
  worker/     BullMQ worker: platform data sync + scheduled re-syncs
packages/
  db/         Prisma schema, migrations, client
  shared/     Types, zod schemas, platform catalogue, roles, metric math
  connectors/ Ad platform adapters: meta/, google/, demo/ (sample data)
  core/       Server logic shared by api + worker: sync engine, token crypto, queue
```

Every platform implements one `AdPlatformConnector` interface (`packages/connectors/src/types.ts`). Adding TikTok or LinkedIn means adding one folder there and registering it in `packages/connectors/src/index.ts`.

## Run locally

Requirements: Node 22+, pnpm 9, PostgreSQL 15+, Redis 6+.

```bash
pnpm install
cp .env.example .env          # then fill DATABASE_URL and the secrets (see comments)
pnpm db:migrate               # create tables
pnpm db:seed                  # demo org + sample data
pnpm dev                      # web + api + worker together
```

Open http://localhost:3100 and sign in with the seeded demo account: `demo@ashniva.com` / `Demo@12345`.

> This checkout currently uses a project-local Postgres in `.data/postgres` on port 5434 (started with `pnpm localdb:start`). To use your own Postgres instead, change `DATABASE_URL` in `.env` and run `pnpm db:migrate && pnpm db:seed`.

### Useful scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Runs web, api and worker in watch mode |
| `pnpm build` | Production builds (Next.js + bundled api/worker) |
| `pnpm typecheck` | Type-checks every package |
| `pnpm db:migrate` | Creates/applies Prisma migrations |
| `pnpm db:studio` | Opens Prisma Studio |
| `pnpm db:seed` | Seeds the demo org and syncs sample data |

## What's built

**Phase 0–1: foundation and unified dashboard**
- Auth (sign up with org + workspace + 14-day trial, sign in, rotating refresh tokens with reuse detection, password reset, invitations), organizations → workspaces, roles with per-workspace access.
- Integrations with encrypted token storage, ad account assignment, manual + scheduled sync, sample-data mode.
- Overview dashboard, unified campaigns table with pause/activate and budget edits pushed to each platform, campaign detail, activity log, team and workspace settings, landing page, privacy and terms.

**Phase 2: create and report**
- **Campaign builder** (`/campaigns/new`): each platform's native creation flow with the same options as its own ads manager. Pick platform → ad account → objective/campaign type, then edit a Campaign → Ad set/Ad group → Ad tree with a live preview of every placement (Facebook/Instagram feed, Stories, Reels; Google Search, Display, Gmail, Discover, YouTube in-stream/in-feed/Shorts; TikTok; LinkedIn feed/text/message; Bing; Snapchat; Pinterest). Autosaved drafts, field-level validation against each platform's limits, a pre-publish review with "Fix" links, and published ads keep their preview on the campaign page ("How it looks").
  - Specs live in `packages/shared/src/builder/specs/*` (one file per platform): fields, limits, defaults and conditions, shared by the form, the validator, the AI fill and the connectors.
  - Real creation via each API: Meta (campaign → ad sets → creatives/ads, placement customization, multiple text options), Google (Search, Performance Max, Display, Demand Gen for YouTube, Shopping, App in one atomic mutate), TikTok, LinkedIn, Microsoft (Search, PMax, Audience), Snapchat (incl. Story ads) and Pinterest. Google Video campaigns can't be created through Google's API, so YouTube runs through Demand Gen.
- **Creative library**: drag-and-drop image/video uploads, format badges (1:1, 4:5, 9:16…), local disk or S3-compatible storage; Meta image hashes cached per ad account.
- **Reports**: builder with live preview, metrics/breakdown/period/platform filters, period comparison, branded **PDF** and **CSV** export, **scheduled email** delivery (daily/weekly/monthly in the workspace timezone) and **public share links** (`/r/<token>`).
- **Billing**: plans with limits (workspaces, ad accounts, members) and feature gates, Razorpay subscriptions (checkout, signature verification, webhook), read-only lock when a trial or subscription lapses.

**Phase 3: more platforms and automation**
- Connectors for **TikTok, LinkedIn, Microsoft Advertising, Snapchat and Pinterest** (OAuth, account discovery, structure + daily metrics sync, pause/activate, budgets where the platform supports campaign-level budgets).
- **Automation rules**: if/then conditions over a lookback window (ROAS, CPA, CPC, CTR, spend…), actions (pause, activate, raise/lower budget with a cap, notify/email), scope by platform or campaign, cooldowns, dry-run preview and run history. Evaluated by the worker every 5 minutes.
- **Notifications**: in-app bell for rule matches and expired integrations, with optional email.

**Phase 4: pro**
- **White-label branding**: logo, colour, display name and footer on PDFs, emails and shared links.
- **AI assistant (platform key, metered in tokens)**: fill a whole ad from a brief, per-field suggestions, keyword and negative-keyword ideas, audience ideas matched to real platform targeting, a pre-launch review (score + policy/copy/targeting fixes), workspace and per-campaign analysis, and automation rules from a sentence. One key for the deployment (Gemini, OpenAI, Claude or any OpenAI-compatible provider). Every organization gets free tokens (`AI_FREE_TOKENS`, default 100K), then buys token packs (Settings → AI tokens, Razorpay one-time orders); usage is deducted per call from the provider's real token counts and listed in a ledger. Admins can grant tokens from `/admin`.
- **Public REST API** (`/api/v1`, docs at `/docs/api`) with org API keys, rate limiting and usage tracking.
- **Super admin panel** (`/admin`): MRR, orgs, plans, trial extensions, sync failures. Access via `SUPER_ADMIN_EMAILS`.

## Going live with real ad accounts

The app works end to end with sample data today. Real accounts need platform approval, which takes time, so start these now.

**Where the keys go.** Sign in as a super admin (`SUPER_ADMIN_EMAILS`) and open **Admin → API keys & integrations**. Each platform has a card with the exact setup steps, the redirect URL to copy, and fields for its keys; AI, Razorpay and email (any SMTP server, or Resend) are set up there too, with a Test button. Keys are encrypted in the database and override `.env`, and they apply to every organization within a few seconds without a restart. Customers never see these keys: on their Integrations page they just click **Connect** and sign in. (Settings → Developer API is something else: read-only keys customers create to pull their own data into BI tools.)

**Prices.** **Admin → Plans & pricing** sets plan names, monthly prices, limits and features, the trial length, GST, the free AI tokens for new organizations and the AI token packs. The pricing page, billing, AI tokens page and server-side limits all read from it. Razorpay subscription plans are created automatically for each price, so no plan setup is needed in the Razorpay dashboard.

**Meta (Facebook / Instagram)**
1. Create an app at developers.facebook.com (type: Business) and add *Marketing API*.
2. Complete Business Verification for your company.
3. Add the OAuth redirect URL: `https://<your-domain>/api/oauth/meta/callback` (local: `http://localhost:3100/api/oauth/meta/callback`).
4. Request Advanced Access for `ads_management`, `ads_read`, `business_management` via App Review (needs the privacy policy URL `/privacy`, data deletion URL `/privacy#data-deletion`, and a screencast).
5. Paste the App ID and App secret in Admin → API keys (or `META_APP_ID` / `META_APP_SECRET` in `.env`).

**Google Ads (also covers YouTube)**
1. In Google Cloud Console, create a project and enable the Google Ads API. Enabling it gives Test access, which only reaches Google's test accounts.
2. On that project's Google Ads API overview page, apply for Explorer access for real ad accounts (2,880 operations a day). For 15,000 a day, complete brand verification and apply for Basic access. API Center in a Google Ads manager account no longer issues developer tokens.
3. Configure the OAuth consent screen (scope `https://www.googleapis.com/auth/adwords`) and create a Web OAuth client. Add the redirect URL `https://<your-domain>/api/oauth/google/callback` (local: `http://localhost:3100/api/oauth/google/callback`).
4. Paste the client ID and client secret in Admin → API keys (or `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`). Leave the developer token empty.

**TikTok, LinkedIn, Microsoft, Snapchat, Pinterest**: register a developer app on each platform's marketing API portal, set its OAuth redirect to `https://<your-domain>/api/oauth/<platform>/callback` (`tiktok`, `linkedin`, `microsoft`, `snapchat`, `pinterest`), then add its keys in Admin → API keys (or the matching variables from `.env.example`). These connectors follow each platform's published API and need a final check against a real account once access is approved.

Once credentials are set, the **Connect** buttons on the Integrations page become active.

API versions in use: Meta Graph `v26.0`, Google Ads `v25`, LinkedIn `202609` (older LinkedIn versions are switched off by LinkedIn), TikTok `v1.3`, Microsoft `v13`. Pinterest now also asks for `pins:write` and `boards:write` (to create ad Pins), so existing Pinterest connections need to reconnect once.

## Other services

| Feature | Variables | Without them |
|---|---|---|
| Email (invites, resets, reports, alerts) | `RESEND_API_KEY`, `EMAIL_FROM` | Emails are logged to the API/worker console |
| File storage | `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `FILES_PUBLIC_URL` | Files go to `.data/uploads` and are served by the API |
| Billing | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_PLAN_*` | Plans page shows "Talk to sales"; set plans from `/admin` |
| AI assistant | `AI_PROVIDER` (GEMINI · OPENAI · ANTHROPIC · OPENAI_COMPATIBLE), `AI_API_KEY`, optional `AI_MODEL`, `AI_BASE_URL` (compatible only), `AI_FREE_TOKENS` | AI buttons are hidden; token balances are kept |
| Admin panel | `SUPER_ADMIN_EMAILS` | `/admin` is inaccessible |

AI token packs (prices in `packages/shared/src/ai.ts`) use Razorpay one-time orders with the same keys; add `order.paid` / `payment.captured` to the webhook events.

For Razorpay, create three monthly plans in the dashboard (prices are in `packages/shared/src/plans.ts`), put their ids in `RAZORPAY_PLAN_STARTER/GROWTH/AGENCY`, and add a webhook to `https://<your-domain>/api/billing/webhook/razorpay` for `subscription.*` events.

## Deploying

See [DEPLOY.md](DEPLOY.md): one-server Docker setup (`docker compose up -d --build`), managed hosting, and a go-live checklist.

## Before production

- Have legal counsel review `/privacy` and `/terms` (they are drafts).
- Set `RESEND_API_KEY` so invitation and password-reset emails are delivered (they are logged to the API console until then).
- Serve web and API behind HTTPS on one domain (or set `API_URL` for the Next.js rewrite), and run the worker as a separate process.
- Use a managed Postgres with backups and a managed Redis.

## Ideas for later

Instant-form and lead-form builders, LinkedIn Message/Conversation ads, Google Video campaigns (blocked by Google's API today), custom audience creation, multi-currency conversion, and a Redis store for rate limits when running several API instances.

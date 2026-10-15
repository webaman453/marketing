# Deploying Ashniva Ads

The product is four processes plus two data stores:

| Piece | What it is | Port |
| --- | --- | --- |
| web | Next.js app (pages + `/api/*` proxy) | 3100 |
| api | Express API | 4100 |
| worker | Background jobs (syncs, rules, scheduled reports) | — |
| migrate | Applies database migrations, then exits | — |
| PostgreSQL | Main database | 5432 |
| Redis | Job queue for the worker | 6379 |

Only the web app is public. It forwards `/api/*` to the API, so one domain serves everything, including OAuth callbacks (`https://<domain>/api/oauth/<platform>/callback`) and the Razorpay webhook (`https://<domain>/api/billing/webhook/razorpay`).

## Option A: one server with Docker (recommended)

Works on any Linux VPS with 2 vCPU / 4 GB RAM or more (DigitalOcean, AWS Lightsail, Hetzner, Hostinger VPS…).

1. **Point your domain** (e.g. `ads.yourcompany.com`) to the server's IP with an A record.
2. **Install Docker** on the server: <https://docs.docker.com/engine/install/>.
3. **Get the code:**
   ```bash
   git clone https://github.com/webaman453/marketing.git ashniva && cd ashniva
   cp .env.example .env
   ```
4. **Fill in `.env`** (at minimum):
   ```bash
   DOMAIN=ads.yourcompany.com
   WEB_URL=https://ads.yourcompany.com
   POSTGRES_PASSWORD=<long random string>
   JWT_ACCESS_SECRET=<openssl rand -hex 32>
   JWT_REFRESH_SECRET=<openssl rand -hex 32>
   OAUTH_STATE_SECRET=<openssl rand -hex 32>
   TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
   SUPER_ADMIN_EMAILS=you@yourcompany.com
   ```
   `DATABASE_URL`, `REDIS_URL` and `API_URL` are set by `docker-compose.yml`; leave them as they are. Keep `TOKEN_ENCRYPTION_KEY` safe and never change it: saved platform logins and admin-console keys are encrypted with it.
5. **Start everything.** Pick one:
   - **The server already runs nginx** (other sites on ports 80/443):
     ```bash
     docker compose up -d --build
     ```
     The web app listens on `127.0.0.1:3100` only (set `WEB_PORT` in `.env` if 3100 is taken). Add [deploy/nginx.conf](deploy/nginx.conf) as a site for your domain, reload nginx, then run `certbot --nginx -d <domain>` for HTTPS.
   - **Nothing else on ports 80/443:** let the bundled Caddy handle HTTPS:
     ```bash
     docker compose --profile caddy up -d --build
     ```
     Caddy gets a certificate for `DOMAIN` automatically.

   The first build takes a few minutes.
6. **Create your admin account:** open `https://<domain>/signup` and sign up with the email you put in `SUPER_ADMIN_EMAILS`. You then have **Admin** in the sidebar.
7. **Add keys and prices in the app:** Admin → *API keys & integrations* (Meta, Google, …, AI, Razorpay, Resend) and Admin → *Plans & pricing*. Each card shows the redirect URL to register with that platform.

Updating to a new version:
```bash
git pull
docker compose up -d --build        # add --profile caddy if you use Caddy
```
Migrations run automatically before the API starts.

Useful commands:
```bash
docker compose ps                 # what's running
docker compose logs -f api worker # follow logs
docker compose exec postgres pg_dump -U ashniva ashniva_ads > backup.sql   # database backup
```

Data lives in Docker volumes: `pgdata` (database), `uploads` (creatives and logos), `redisdata`, `caddydata` (certificates). Back up `pgdata` and `uploads`.

## Option B: managed services (no server to maintain)

- **Database:** any managed PostgreSQL 15+ (Neon, Supabase, Railway, AWS RDS).
- **Redis:** Upstash, Railway or Redis Cloud.
- **API and worker:** Railway or Render, from this repo:
  - build: `pnpm install --frozen-lockfile && pnpm --filter @ashniva/db run generate && pnpm turbo run build --filter=@ashniva/api --filter=@ashniva/worker`
  - API start: `pnpm --filter @ashniva/db run deploy && node apps/api/dist/index.js`
  - worker start: `node apps/worker/dist/index.js`
- **Web:** Vercel (root directory `apps/web`) or the same Railway/Render project with `pnpm --filter @ashniva/web start`. Set `API_URL` to the API's internal or public URL **before building**; the `/api/*` proxy is fixed at build time.
- Set the same `.env` values on every service. `WEB_URL` is the public web address.
- File uploads: set the `S3_*` variables (AWS S3 or Cloudflare R2), because these hosts don't keep local files between deploys.

## Option C: a plain VPS without Docker

Install Node 22, pnpm 9, PostgreSQL and Redis, then:
```bash
pnpm install --frozen-lockfile
pnpm db:generate && pnpm db:deploy
pnpm build
```
Run `apps/api` (`node dist/index.js`), `apps/worker` (`node dist/index.js`) and `apps/web` (`pnpm start`) with a process manager such as PM2, and put Nginx or Caddy in front of port 3100 with HTTPS.

## Checklist before real customers

- [ ] `NODE_ENV=production` and the site on HTTPS (login cookies are secure-only in production).
- [ ] Strong random values for every secret in `.env`; `.env` is never committed.
- [ ] Your account is in `SUPER_ADMIN_EMAILS`; the demo account from the seed script is **not** used in production (don't run `pnpm db:seed` there).
- [ ] Platform apps registered with the production redirect URLs, and their App Review / API access approved.
- [ ] Razorpay live keys and the webhook added in Admin → API keys; a test payment done.
- [ ] Email set up in Admin → API keys → Email (SMTP server or Resend) and a test email received. Without it, password reset links and invitations are only written to the API logs (`docker compose logs api | grep -i email`).
- [ ] Database backups scheduled.

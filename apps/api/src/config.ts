import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().default(4100),
  WEB_URL: z.url().default("http://localhost:3100"),
  /** Public URL that OAuth providers redirect back to (proxied by the web app in dev). */
  OAUTH_REDIRECT_BASE: z.url().optional(),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  OAUTH_STATE_SECRET: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().length(64),
  TRUST_PROXY: z.coerce.number().default(1),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export const isProd = () => config().NODE_ENV === "production";
export const oauthRedirectUri = (platform: string) =>
  `${config().OAUTH_REDIRECT_BASE ?? config().WEB_URL}/api/oauth/${platform.toLowerCase()}/callback`;

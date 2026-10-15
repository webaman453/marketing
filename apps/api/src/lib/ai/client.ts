/**
 * One structured-output call against the platform's AI provider (set in the
 * environment). Every call returns the parsed JSON plus the tokens it used, so
 * callers can meter usage per organization.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AiProvider } from "@ashniva/shared";
import { z } from "zod";
import { HttpError } from "../errors";
import { logger } from "../logger";

const DEFAULT_MODELS: Record<AiProvider, string> = {
  GEMINI: "gemini-3.8-flash",
  OPENAI: "gpt-6.1-sol",
  ANTHROPIC: "claude-sonnet-5-5",
  OPENAI_COMPATIBLE: "",
};

interface ProviderConfig {
  provider: AiProvider;
  apiKey: string;
  model: string;
  baseUrl: string | null;
}

function providerConfig(): ProviderConfig | null {
  // ANTHROPIC_API_KEY is still honoured for deployments set up before AI_API_KEY existed.
  const legacy = !process.env.AI_API_KEY && process.env.ANTHROPIC_API_KEY;
  const apiKey = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) return null;
  const provider = (legacy ? "ANTHROPIC" : (process.env.AI_PROVIDER || "GEMINI").toUpperCase()) as AiProvider;
  if (!(provider in DEFAULT_MODELS)) return null;
  const model = process.env.AI_MODEL || DEFAULT_MODELS[provider];
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/+$/, "") || null;
  if (!model || (provider === "OPENAI_COMPATIBLE" && !baseUrl)) return null;
  return { provider, apiKey, model, baseUrl };
}

export const aiAvailable = () => providerConfig() !== null;
export const aiModelName = () => providerConfig()?.model ?? null;

export interface AiImage {
  mimeType: string;
  /** base64, no data: prefix */
  data: string;
}

export interface AiCallResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface RawResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const notConfigured = () =>
  new HttpError(503, "AI_NOT_CONFIGURED", "AI isn't available on this deployment yet. Ask the platform administrator to add an AI key.");

// ───────── JSON Schema per provider ─────────

type Json = Record<string, unknown>;

/**
 * zod → JSON Schema, minus keywords the providers reject. Length limits move
 * into the description so the model still sees them; zod re-checks afterwards.
 */
function wireSchema(schema: z.ZodType, provider: AiProvider): Json {
  const root = z.toJSONSchema(schema) as Json;
  delete root.$schema;
  const strip = new Set(["minLength", "maxLength", "pattern", "const", "allOf", "not", "default"]);
  if (provider === "ANTHROPIC") ["minimum", "maximum", "multipleOf", "maxItems", "exclusiveMinimum", "exclusiveMaximum"].forEach((k) => strip.add(k));

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Json = {};
    const n = node as Json;
    const hints: string[] = [];
    if (typeof n.maxLength === "number") hints.push(`at most ${n.maxLength} characters`);
    if (typeof n.minLength === "number" && n.minLength > 0) hints.push(`at least ${n.minLength} characters`);
    for (const [k, v] of Object.entries(n)) {
      if (strip.has(k)) continue;
      out[k] = k === "properties" ? Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, walk(pv)])) : walk(v);
    }
    if (hints.length) out.description = [n.description, `(${hints.join(", ")})`].filter(Boolean).join(" ");
    if (out.type === "object" && out.properties) {
      out.additionalProperties = false;
      // OpenAI strict mode needs every property listed as required.
      if (provider === "OPENAI" || provider === "OPENAI_COMPATIBLE") out.required = Object.keys(out.properties as Json);
    }
    if (provider === "ANTHROPIC" && typeof out.minItems === "number" && out.minItems > 1) out.minItems = 1;
    return out;
  };
  return walk(root) as Json;
}

const stripFences = (text: string) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

async function readError(res: Response) {
  const body = (await res.json().catch(() => null)) as Json | null;
  const err = body?.error as Json | string | undefined;
  return (typeof err === "string" ? err : (err?.message as string | undefined)) ?? (body?.detail as string | undefined) ?? (body?.message as string | undefined) ?? `HTTP ${res.status}`;
}

function providerError(status: number, message: string): HttpError {
  logger.warn({ status, message }, "AI provider error");
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return new HttpError(503, "AI_NOT_CONFIGURED", "The platform's AI key was rejected by the provider. Please contact support.");
  }
  if (status === 429) return new HttpError(429, "AI_RATE_LIMITED", "The AI service is busy. Try again in a moment.");
  return new HttpError(502, "AI_ERROR", "The AI service couldn't complete the request. Please try again.");
}

// ───────── Providers ─────────

async function callGemini(cfg: ProviderConfig, system: string, prompt: string, schema: Json, images: AiImage[], maxTokens: number): Promise<RawResult> {
  const thinkingConfig = /gemini-2\.5/.test(cfg.model) ? { thinkingBudget: 512 } : { thinkingLevel: "LOW" };
  const base = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [...images.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.data } })), { text: prompt }] }],
  };
  const send = (generationConfig: Json) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": cfg.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ ...base, generationConfig: { maxOutputTokens: maxTokens, thinkingConfig, ...generationConfig } }),
      signal: AbortSignal.timeout(120_000),
    });

  let res = await send({ responseFormat: { text: { mimeType: "application/json", schema } } });
  // Older API surface: responseMimeType + responseJsonSchema.
  if (res.status === 400) res = await send({ responseMimeType: "application/json", responseJsonSchema: schema });
  if (!res.ok) throw providerError(res.status, await readError(res));

  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const u = body.usageMetadata ?? {};
  const usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
  const candidate = body.candidates?.[0];
  if (body.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS")) {
    throw new HttpError(422, "AI_DECLINED", "The AI couldn't help with this request. Try rephrasing the brief.");
  }
  if (candidate?.finishReason === "MAX_TOKENS") throw new HttpError(502, "AI_INCOMPLETE", "The AI response was cut short. Please try again.");
  const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  return { text, ...usage };
}

async function callOpenAiStyle(cfg: ProviderConfig, system: string, prompt: string, schema: Json, images: AiImage[], maxTokens: number): Promise<RawResult> {
  const url = `${cfg.provider === "OPENAI" ? "https://api.openai.com/v1" : cfg.baseUrl}/chat/completions`;
  const userContent = images.length
    ? [{ type: "text", text: prompt }, ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))]
    : prompt;
  const send = (mode: "schema" | "object") =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content:
              mode === "schema" ? system : `${system}\n\nRespond ONLY with a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}`,
          },
          { role: "user", content: userContent },
        ],
        response_format: mode === "schema" ? { type: "json_schema", json_schema: { name: "result", strict: true, schema } } : { type: "json_object" },
        max_completion_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120_000),
    });

  let res = await send("schema");
  // Some compatible providers only support JSON mode.
  if (cfg.provider === "OPENAI_COMPATIBLE" && (res.status === 400 || res.status === 422)) res = await send("object");
  if (!res.ok) throw providerError(res.status, await readError(res));

  const body = (await res.json()) as {
    choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === "content_filter") {
    throw new HttpError(422, "AI_DECLINED", "The AI couldn't help with this request. Try rephrasing the brief.");
  }
  if (choice?.finish_reason === "length") throw new HttpError(502, "AI_INCOMPLETE", "The AI response was cut short. Please try again.");
  return { text: choice?.message?.content ?? "", inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
}

let anthropicClient: { key: string; client: Anthropic } | undefined;

async function callAnthropic<S extends z.ZodType>(cfg: ProviderConfig, system: string, prompt: string, schema: S, images: AiImage[], maxTokens: number) {
  if (anthropicClient?.key !== cfg.apiKey) anthropicClient = { key: cfg.apiKey, client: new Anthropic({ apiKey: cfg.apiKey }) };
  try {
    const response = await anthropicClient.client.beta.messages.parse({
      model: cfg.model,
      max_tokens: Math.max(maxTokens, 8000),
      system,
      messages: [
        {
          role: "user",
          content: [
            ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mimeType as "image/png", data: i.data } })),
            { type: "text" as const, text: prompt },
          ],
        },
      ],
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    });
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    if (response.stop_reason === "refusal") throw new HttpError(422, "AI_DECLINED", "The AI couldn't help with this request. Try rephrasing the brief.");
    if (response.stop_reason === "max_tokens" || !response.parsed_output) {
      throw new HttpError(502, "AI_INCOMPLETE", "The AI response was incomplete. Please try again.");
    }
    return { data: response.parsed_output as z.infer<S>, ...usage };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Anthropic.APIError) throw providerError(err.status ?? 502, err.message);
    throw err;
  }
}

/**
 * Structured call with one repair retry when the output doesn't validate.
 * Token usage from both attempts is reported.
 */
export async function generateJson<S extends z.ZodType>(opts: {
  schema: S;
  system: string;
  prompt: string;
  images?: AiImage[];
  maxTokens?: number;
}): Promise<AiCallResult<z.infer<S>>> {
  const cfg = providerConfig();
  if (!cfg) throw notConfigured();
  const images = opts.images ?? [];
  const maxTokens = opts.maxTokens ?? 4000;

  if (cfg.provider === "ANTHROPIC") {
    const r = await callAnthropic(cfg, opts.system, opts.prompt, opts.schema, images, maxTokens);
    return { ...r, model: cfg.model };
  }

  const schema = wireSchema(opts.schema, cfg.provider);
  const call = cfg.provider === "GEMINI" ? callGemini : callOpenAiStyle;
  let inputTokens = 0;
  let outputTokens = 0;
  let prompt = opts.prompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await call(cfg, opts.system, prompt, schema, images, maxTokens);
    inputTokens += raw.inputTokens;
    outputTokens += raw.outputTokens;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFences(raw.text));
    } catch {
      parsed = undefined;
    }
    const result = opts.schema.safeParse(parsed);
    if (result.success) return { data: result.data, model: cfg.model, inputTokens, outputTokens };
    const problems = parsed === undefined ? "The response was not valid JSON." : result.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    logger.warn({ provider: cfg.provider, problems }, "AI output failed validation");
    prompt = `${opts.prompt}\n\nYour previous answer was rejected: ${problems} Return corrected JSON only.`;
  }
  throw new HttpError(502, "AI_INCOMPLETE", "The AI returned an unexpected answer. Please try again.");
}

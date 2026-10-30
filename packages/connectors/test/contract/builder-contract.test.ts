/**
 * Contract tests between the campaign-builder form specs (packages/shared/src/builder/specs)
 * and each connector's createCampaign (packages/connectors/src/<platform>/builder.ts).
 *
 * For every setup the start screen allows, and every in-form choice that changes the form,
 * a draft is filled with valid sample values for every visible field and handed to
 * createCampaign behind a recording fetch mock. The draft values are Proxies, so the test
 * knows exactly which keys the connector read:
 *  - a key read that the spec never defines = the connector expects data the form never collects;
 *  - a required, visible key never read = the form collects something that is never sent
 *    (unless the platform lists it in `formOnly` with a reason).
 * Known mismatches live in platforms.ts as `findings` and run as it.fails("BUG: …").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDER_SPECS, type Values } from "@ashniva/shared";
import {
  ACTIVE_VALUES,
  ORGANIC_ENDPOINTS,
  PAUSED_VALUES,
  extraReads,
  runCreate,
  setupCombos,
  setupLabel,
  snapshotCalls,
  statusHits,
  unionKeys,
  unreadRequired,
  unreadVisible,
  crossSetupReads,
  variants,
  type RunResult,
  type Variant,
} from "./harness";
import { PLATFORMS, type Finding, type PlatformCase } from "./platforms";

const NOW = new Date("2026-11-02T10:00:00.000Z");

beforeEach(() => {
  // Only Date: real timers keep AbortSignal.timeout and polling loops working.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const keyOf = (f: Finding) => ("key" in f ? f.key : null);

for (const p of PLATFORMS) {
  const spec = BUILDER_SPECS[p.platform];
  const findings = p.findings ?? [];
  const knownExtra = new Set(findings.filter((f) => f.kind === "extraRead").map(keyOf));
  const knownUnread = new Set(findings.filter((f) => f.kind === "unread").map(keyOf));
  const knownInvalid = findings.filter((f): f is Extract<Finding, { kind: "invalid" }> => f.kind === "invalid");
  const knownError = findings.filter((f): f is Extract<Finding, { kind: "createError" }> => f.kind === "createError");

  const combos = setupCombos(spec);
  const union = unionKeys(spec, combos);
  const plan: { setup: Values; variants: Variant[] }[] = combos.map((setup) => ({ setup, variants: variants(spec, setup, p.samples ?? {}, p.tweak) }));

  // Each run happens once and is shared by the assertions about it.
  let connector: Promise<NonNullable<Awaited<ReturnType<PlatformCase["connector"]>>>> | null = null;
  const memo = new Map<string, Promise<RunResult>>();
  const run = (setup: Values, v: Variant, tag = "") => {
    const id = `${setupLabel(setup)}|${v.name}|${tag}`;
    if (!memo.has(id)) {
      connector ??= p.connector();
      memo.set(id, connector.then((c) => runCreate({ spec, connector: c, auth: p.auth, account: p.account, respond: p.respond }, v)));
    }
    return memo.get(id)!;
  };
  const allRuns = () => Promise.all(plan.flatMap(({ setup, variants: vs }) => vs.map((v) => run(setup, v))));

  const suite = p.skip ? describe.skip : describe;
  suite(`${p.platform}: builder form ↔ createCampaign contract${p.skip ? ` (skipped: ${p.skip})` : ""}`, () => {
    it("has at least one API-creatable setup and a createCampaign", async () => {
      expect(combos.length).toBeGreaterThan(0);
      expect(typeof (await p.connector()).createCampaign).toBe("function");
    });

    for (const { setup, variants: vs } of plan) {
      describe(`setup ${setupLabel(setup)}`, () => {
        for (const v of vs) {
          const where = (r: RunResult) => knownInvalid.some((f) => f.where(r));
          it(`${v.name}: a fully filled draft passes validateDraft`, async () => {
            const r = await run(setup, v);
            if (where(r)) return; // covered by its BUG test
            expect(r.issues).toEqual([]);
          });

          it(`${v.name}: createCampaign succeeds, reads only spec keys and sends every required field`, async () => {
            const r = await run(setup, v);
            if (!knownError.some((f) => f.where(r))) expect(r.error, String((r.error as Error)?.message ?? r.error)).toBeUndefined();
            expect(extraReads(r, union).filter((k) => !knownExtra.has(k)), "keys read that the form never collects").toEqual([]);
            const unread = unreadRequired(r).filter((k) => !knownUnread.has(k) && !(p.formOnly && k in p.formOnly));
            expect(unread, "required form fields the connector never reads").toEqual([]);
          });

          it(`${v.name}: creates paused and never posts organically`, async () => {
            const r = await run(setup, v);
            if (r.error) return; // reported above
            expect(r.structure?.campaigns[0]?.status).toBe("PAUSED");
            const hits = statusHits(r.calls).filter((h) => !(p.statusIgnore ?? []).some((re) => re.test(h.where)));
            if (!p.noRequestStatus) {
              expect(hits.filter((h) => ACTIVE_VALUES.has(h.value)), "active-looking status on a paused launch").toEqual([]);
              expect(hits.some((h) => PAUSED_VALUES.has(h.value)), "some request says paused").toBe(true);
            }
            const organic = r.calls.filter((c) => ORGANIC_ENDPOINTS.some((re) => re.test(c.url.pathname)));
            expect(organic.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([]);
            for (const c of r.calls) {
              if (c.url.host === "ads-api.x.com" && /\/(tweet|draft_tweets|scheduled_tweets)$/.test(c.url.pathname)) expect(c.url.searchParams.get("nullcast")).toBe("true");
            }
          });
        }

        it("outgoing requests (base draft)", async () => {
          const base = vs[0]!;
          const r = await run(setup, base);
          expect({ error: r.error ? String((r.error as Error).message ?? r.error) : undefined, requests: snapshotCalls(r.calls, r.draft, p.snapshotSkip) }).toMatchSnapshot();
        });
      });
    }

    it("launchStatus ACTIVE creates it live", async () => {
      const { setup, variants: vs } = plan[0]!;
      const live = structuredClone(vs[0]!.draft);
      live.campaign.launchStatus = "ACTIVE";
      const r = await run(setup, { ...vs[0]!, name: "active", draft: live }, "active");
      expect(r.error, String((r.error as Error)?.message ?? "")).toBeUndefined();
      expect(r.structure?.campaigns[0]?.status).toBe("ACTIVE");
      if (!p.noRequestStatus) expect(statusHits(r.calls).some((h) => ACTIVE_VALUES.has(h.value))).toBe(true);
    });

    it("review list: optional form fields never sent, and reads of other setups' keys", async () => {
      const runs = await allRuns();
      const count = (lists: string[][]) => {
        const m = new Map<string, number>();
        for (const l of lists) for (const k of l) m.set(k, (m.get(k) ?? 0) + 1);
        return Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => [k, `${n}/${runs.length} runs`]));
      };
      // Not failures: a visible optional field the connector ignores is collected for nothing,
      // and type-agnostic code reading another setup's key gets undefined. Reviewed via the snapshot.
      expect({
        unreadVisible: count(runs.map((r) => unreadVisible(spec, r).filter((k) => !r.required.has(k)))),
        crossSetupReads: count(runs.map((r) => crossSetupReads(r, union))),
      }).toMatchSnapshot();
    });

    for (const f of findings) {
      it.fails(f.title, async () => {
        const runs = await allRuns();
        switch (f.kind) {
          case "extraRead":
            expect(runs.filter((r) => r.reads.has(f.key)).map((r) => `${setupLabel(r.setup)} ${r.name}`)).toEqual([]);
            break;
          case "unread":
            expect(runs.filter((r) => r.required.has(f.key) && !r.reads.has(f.key)).map((r) => `${setupLabel(r.setup)} ${r.name}`)).toEqual([]);
            break;
          case "invalid":
            for (const r of runs.filter(f.where)) expect(r.issues).toEqual([]);
            break;
          case "createError":
            for (const r of runs.filter(f.where)) expect(r.error).toBeUndefined();
            break;
          case "custom":
            f.check(runs);
            break;
        }
      });
    }
  });
}


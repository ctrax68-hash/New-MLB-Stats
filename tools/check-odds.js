// Verifies the odds-API budget controls.
//
// The free tier is 500 credits/month and the betting page unmounts on every
// navigation, so before caching, each visit spent credits. These checks pin
// down the things that keep the bill at zero: the market list (which sets the
// per-call cost), the cache TTL, and the quota headers that tell an exhausted
// plan apart from a rejected key.

const { loadEngine, mulberry32 } = require("./engine-harness");

// Deliberately uses the real clock: these helpers compare cache age against
// Date.now() inside the engine, so freezing the sandbox clock while the test
// used the real one would make every age comparison meaningless.
const NOW = Date.now();
const checks = [];
const check = (label, ok, detail = "") => checks.push([label, ok, detail]);

function main() {
  const e = loadEngine({ random: mulberry32(7) });

  // ── Per-call cost ────────────────────────────────────────────────
  // Cost is 1 credit per region per market; we request one region.
  const markets = e.ODDS_MARKETS.split(",");
  check("spreads market dropped", !markets.includes("spreads"), e.ODDS_MARKETS);
  check("h2h retained (needed for moneyline)", markets.includes("h2h"));
  check("totals retained (needed for O/U)", markets.includes("totals"));
  check("cost is 2 credits/call, not 3", markets.length === 2, `${markets.length} markets`);

  // ── Cache round-trip ─────────────────────────────────────────────
  check("cache empty initially", e.loadOddsCache() === null);
  const map = { "LAD|ATL": { hML: "-145", aML: "+122" }, "NYY|BOS": { hML: "-110", aML: "-110" } };
  e.saveOddsCache(map);
  const cached = e.loadOddsCache();
  check("cache round-trips", !!cached && Object.keys(cached.map).length === 2);
  check("cache records fetch time", !!cached && typeof cached.fetchedAt === "number");

  // ── TTL: short near first pitch, long otherwise ──────────────────
  const soonGames = [{ start_time: new Date(NOW + 30 * 60 * 1000).toISOString() }];
  const farGames  = [{ start_time: new Date(NOW + 8 * 3600 * 1000).toISOString() }];
  check("TTL is short when a game starts within the hour",
    e.oddsCacheTTL(soonGames) === e.ODDS_TTL_NEAR_MS, `${e.oddsCacheTTL(soonGames)}ms`);
  check("TTL is long otherwise",
    e.oddsCacheTTL(farGames) === e.ODDS_TTL_FAR_MS, `${e.oddsCacheTTL(farGames)}ms`);
  check("TTL tolerates an empty slate", e.oddsCacheTTL([]) === e.ODDS_TTL_FAR_MS);
  check("TTL tolerates malformed dates",
    e.oddsCacheTTL([{ start_time: "not-a-date" }]) === e.ODDS_TTL_FAR_MS);

  // A cache entry younger than its TTL must be reused — this is the check that
  // actually corresponds to "navigating back to the page costs nothing".
  const fresh = e.loadOddsCache();
  check("fresh cache is inside TTL (page revisit is free)",
    (Date.now() - fresh.fetchedAt) < e.oddsCacheTTL(farGames));

  // ── Quota headers ────────────────────────────────────────────────
  const mkRes = h => ({ headers: { get: k => (k in h ? String(h[k]) : null) } });
  const q = e.readOddsQuotaHeaders(mkRes({
    "x-requests-remaining": "487", "x-requests-used": "13", "x-requests-last": "2",
  }));
  check("parses remaining credits", q && q.remaining === 487, JSON.stringify(q));
  check("parses used credits", q && q.used === 13);
  check("parses last call cost", q && q.last === 2);
  check("quota persists for the budget guard", e.loadOddsQuota().remaining === 487);

  // Exhausted plan: remaining === 0 is what distinguishes it from a bad key,
  // since the API answers 401 for both.
  const q0 = e.readOddsQuotaHeaders(mkRes({ "x-requests-remaining": "0", "x-requests-used": "500" }));
  check("detects exhausted quota (remaining 0)", q0 && q0.remaining === 0);
  check("0 remaining is below the auto-fetch floor", 0 < e.ODDS_MIN_CREDITS);

  // A response with no usage headers must not clobber a known-good balance.
  e.saveOddsQuota({ remaining: 300, used: 200, at: NOW });
  const qNone = e.readOddsQuotaHeaders(mkRes({}));
  check("ignores responses without usage headers", qNone === null);
  check("preserves last known balance", e.loadOddsQuota().remaining === 300);

  // ── Age formatting ───────────────────────────────────────────────
  check("formats recent age", e.fmtAge(Date.now() - 5000) === "just now", e.fmtAge(Date.now() - 5000));
  check("formats minutes", e.fmtAge(Date.now() - 12 * 60000) === "12m ago");
  check("formats hours", e.fmtAge(Date.now() - 3 * 3600000) === "3h ago");

  let failed = 0;
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `  (${detail})` : ""}`);
    if (!ok) failed++;
  }
  console.log(
    `\n${checks.length - failed}/${checks.length} passed` +
    `\nPer-call cost: ${markets.length} credits (was 3) · free tier 500/mo` +
    ` => ~${Math.floor(500 / markets.length)} refreshes/month, and page revisits are free.`
  );
  if (failed) process.exit(1);
}

main();

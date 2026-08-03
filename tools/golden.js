// Golden characterization corpus for the simulation + learning engine.
//
//   node tools/golden.js record    # capture current behavior to fixtures/
//   node tools/golden.js verify    # assert behavior is unchanged
//
// This is a characterization test, not a correctness test: it asserts only that
// a refactor did not change what the engine computes. That is exactly the
// guarantee needed before extracting the engine into modules, since this
// codebase has no other tests and has shipped eleven scope bugs.
//
// Everything here is deterministic — a seeded RNG and a fixed clock — so any
// diff is a real behavior change rather than Monte Carlo noise.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEngine, mulberry32 } = require("./engine-harness");

const FIXTURE = path.join(__dirname, "..", "fixtures", "golden-sim.json");
const FIXED_NOW = Date.parse("2026-06-15T18:00:00Z");
const SEED = 20260615;

// Subset chosen to span the rating spectrum: elite, mid, weak, and the two
// extreme park environments (Coors, Petco).
const TEAM_IDS = ["LAD", "NYY", "ATL", "SEA", "CHC", "STL", "MIA", "COL", "CWS", "SDP"];

const WEATHER_CASES = [
  { label: "none", ctx: null },
  { label: "hot-windy", ctx: { weather: { temp: 92, wind: 14, rain: 0 }, sp: {} } },
  { label: "cold-calm", ctx: { weather: { temp: 44, wind: 3, rain: 0 }, sp: {} } },
  { label: "wet", ctx: { weather: { temp: 68, wind: 8, rain: 80 }, sp: {} } },
];

function round(v, dp = 6) {
  return typeof v === "number" && isFinite(v) ? +v.toFixed(dp) : v;
}

function buildCorpus(engine) {
  const teams = TEAM_IDS.map(id => engine.BASELINE.find(t => t.id === id));
  const entries = [];

  // ── Simulation grid ──────────────────────────────────────────────
  // Every ordered team pair × SP slot combinations × weather contexts.
  for (const home of teams) {
    for (const away of teams) {
      if (home.id === away.id) continue;
      for (const [hs, as] of [[0, 0], [0, 4], [4, 0], [2, 2], [1, 3]]) {
        for (const wc of WEATHER_CASES) {
          const r = engine.runSimulation(home, away, true, hs, as, wc.ctx);
          entries.push({
            k: `sim/${home.id}-${away.id}/sp${hs}${as}/${wc.label}`,
            v: {
              hWinProb: round(r.hWinProb), rlCoverPct: round(r.rlCoverPct),
              avgTotal: round(r.avgTotal), hAvgRuns: round(r.hAvgRuns),
              aAvgRuns: round(r.aAvgRuns), hLambda: round(r.hLambda),
              aLambda: round(r.aLambda), nbWeight: round(r.nbWeight),
              nbRouted: r.nbRouted, parkFactor: round(r.parkFactor),
              hSpAdj: round(r.hSpAdj), aSpAdj: round(r.aSpAdj),
            },
          });
        }
      }
    }
  }

  // ── Home-field advantage toggle ──────────────────────────────────
  for (const home of teams.slice(0, 5)) {
    const away = teams[(teams.indexOf(home) + 3) % teams.length];
    const r = engine.runSimulation(home, away, false, 2, 2, null);
    entries.push({ k: `sim-nohfa/${home.id}-${away.id}`, v: { hWinProb: round(r.hWinProb), avgTotal: round(r.avgTotal) } });
  }

  // ── Pure helpers ─────────────────────────────────────────────────
  for (const t of teams) {
    entries.push({ k: `park/${t.id}`, v: engine.getPark(t.id) });
    for (let slot = 0; slot < 5; slot++) {
      entries.push({ k: `spAdj/${t.id}/${slot}`, v: round(engine.getSpAdj(t.id, slot)) });
    }
    entries.push({ k: `bbhr/${t.id}`, v: round(engine.bbHrVarianceMultiplier(t.bbPer9, t.hrAllowed)) });
    entries.push({ k: `elovol/${t.id}`, v: round(engine.eloVolVarianceMultiplier(t.eloVol ?? 0)) });
  }
  for (const p of [0.05, 0.25, 0.4, 0.5, 0.5001, 0.62, 0.75, 0.95]) {
    entries.push({ k: `toML/${p}`, v: engine.toML(p) });
    entries.push({ k: `calib/${p}`, v: round(engine.applyCalibration(p, null, false)) });
    entries.push({ k: `calib-nb/${p}`, v: round(engine.applyCalibration(p, null, true)) });
  }
  for (const wc of WEATHER_CASES) {
    if (!wc.ctx) continue;
    entries.push({ k: `weatherRun/${wc.label}`, v: round(engine.weatherRunFactor(wc.ctx.weather)) });
    entries.push({ k: `weatherVol/${wc.label}`, v: round(engine.weatherVolatilityIndex(wc.ctx.weather)) });
  }

  // ── Betting math ─────────────────────────────────────────────────
  for (const ml of ["-250", "-145", "-110", "+100", "+125", "+310"]) {
    entries.push({ k: `mlToDecimal/${ml}`, v: round(engine.mlToDecimal(ml)) });
    entries.push({ k: `mlToProb/${ml}`, v: round(engine.mlToProb(ml)) });
  }
  for (const [p, o] of [[0.55, 1.9], [0.6, 2.2], [0.52, 1.8], [0.48, 2.0]]) {
    entries.push({ k: `kelly/${p}-${o}`, v: round(engine.kellyStake(p, o)) });
  }
  for (const pct of [50, 52.5, 55, 58, 62, 70]) {
    entries.push({ k: `confStake/${pct}`, v: round(engine.confidenceStake(pct)) });
  }

  const fakeGames = [
    { modelFavTeam: "LAD", mlHit: true,  vegasML: "-145", modelFavPct: 58.2 },
    { modelFavTeam: "NYY", mlHit: false, vegasML: "-120", modelFavPct: 55.1 },
    { modelFavTeam: "COL", mlHit: true,  vegasML: "+130", modelFavPct: 61.0 },
    { modelFavTeam: "SEA", mlHit: false, vegasML: "-105", modelFavPct: 53.4 },
    { modelFavTeam: "CHC", mlHit: true,  vegasML: "-165", modelFavPct: 64.8 },
  ];
  const roi = engine.computeROI(fakeGames, "modelFavTeam", "mlHit", "vegasML");
  entries.push({ k: "computeROI", v: { roi: round(roi.roi), net: round(roi.net), wins: roi.wins, losses: roi.losses, total: roi.total } });
  const kroi = engine.computeKellyROI(fakeGames, "mlHit", "vegasML", "modelFavPct");
  entries.push({ k: "computeKellyROI", v: { roi: round(kroi.roi), net: round(kroi.net) } });
  const croi = engine.computeConfROI(fakeGames, "mlHit", "vegasML", "modelFavPct");
  entries.push({ k: "computeConfROI", v: { roi: round(croi.roi), net: round(croi.net) } });

  // ── Team model built from synthetic completed games ───────────────
  const syntheticGames = [];
  let gid = 900000;
  for (let round_ = 0; round_ < 6; round_++) {
    for (let i = 0; i < TEAM_IDS.length; i += 2) {
      const h = TEAM_IDS[i], a = TEAM_IDS[i + 1];
      syntheticGames.push({
        id: gid++, home: h, away: a, status: "closed", gameType: "R",
        start_time: new Date(Date.parse("2026-04-05T18:00:00Z") + round_ * 86400000).toISOString(),
        hScore: 3 + ((round_ + i) % 5), aScore: 2 + ((round_ * 2 + i) % 4), _source: "live",
      });
    }
  }
  const standings = engine.buildStandingsFromGames(syntheticGames);
  const live = engine.buildLiveTeams(standings, {}, syntheticGames);
  for (const t of live.filter(t => TEAM_IDS.includes(t.id))) {
    entries.push({
      k: `liveTeam/${t.id}`,
      v: {
        winPct: round(t.winPct), runsFor: round(t.runsFor), runsAgainst: round(t.runsAgainst),
        eloRating: t.eloRating, eloVol: round(t.eloVol), pythagWinPct: round(t.pythagWinPct),
        powRating: round(t.powRating), offRating: round(t.offRating),
        defRating: round(t.defRating), spRating: round(t.spRating),
        wins: t.wins, losses: t.losses, dataSource: t.dataSource,
      },
    });
  }

  entries.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : 0));
  return entries;
}

function hashCorpus(entries) {
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function makeEngine() {
  return loadEngine({ random: mulberry32(SEED), now: FIXED_NOW });
}

function main() {
  const mode = process.argv[2];
  if (mode !== "record" && mode !== "verify") {
    console.error("usage: node tools/golden.js <record|verify>");
    process.exit(2);
  }

  const entries = buildCorpus(makeEngine());
  const hash = hashCorpus(entries);

  if (mode === "record") {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify({ seed: SEED, now: FIXED_NOW, hash, entries }, null, 1));
    console.log(`recorded ${entries.length} entries`);
    console.log(`hash ${hash}`);
    console.log(`-> ${path.relative(process.cwd(), FIXTURE)}`);
    return;
  }

  if (!fs.existsSync(FIXTURE)) {
    console.error("no fixture found — run: node tools/golden.js record");
    process.exit(2);
  }
  const golden = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

  if (golden.hash === hash) {
    console.log(`Engine unchanged — ${entries.length} entries match (hash ${hash.slice(0, 12)}…)`);
    return;
  }

  // Report what actually moved, not just that the hash differs.
  const goldMap = new Map(golden.entries.map(e => [e.k, JSON.stringify(e.v)]));
  const nowMap = new Map(entries.map(e => [e.k, JSON.stringify(e.v)]));
  const diffs = [];
  for (const [k, v] of nowMap) {
    const g = goldMap.get(k);
    if (g === undefined) diffs.push(`  + ${k} (new)`);
    else if (g !== v) diffs.push(`  ~ ${k}\n      was: ${g}\n      now: ${v}`);
  }
  for (const k of goldMap.keys()) if (!nowMap.has(k)) diffs.push(`  - ${k} (missing)`);

  console.error(`ENGINE BEHAVIOR CHANGED — ${diffs.length} differing entr${diffs.length === 1 ? "y" : "ies"}:\n`);
  console.error(diffs.slice(0, 40).join("\n"));
  if (diffs.length > 40) console.error(`  … and ${diffs.length - 40} more`);
  console.error("\nIf this change was intentional, re-record: node tools/golden.js record");
  process.exit(1);
}

main();

// Verifies that recordVsVegas actually records a settled game.
//
// Before the scope fixes this was impossible: the function threw a TDZ
// ReferenceError on every new game, and its only call site swallowed the
// rejection, so the ledger silently stayed empty forever.

const { loadEngine, mulberry32 } = require("./engine-harness");

const GAME_DATE = "2026-04-15";
const START = `${GAME_DATE}T23:10:00Z`;

// A stored closing line for this matchup, so CLV has something to resolve against.
const closingLines = {
  [`LAD|ATL|${GAME_DATE}`]: {
    hML: "-145", aML: "+122", hMLraw: -145, aMLraw: 122,
    ou: "8.5", isClosing: true, savedAt: Date.parse(START) - 3.6e6,
  },
};
const openLines = {
  [`LAD|ATL|${GAME_DATE}`]: {
    hML: "-130", aML: "+110", hMLraw: -130, aMLraw: 110,
    ou: "8.5", savedAt: Date.parse(START) - 4.3e7,
  },
};

async function main() {
  const engine = loadEngine({
    random: mulberry32(12345),
    now: Date.parse(START) + 3 * 3600e3,
    storeSeed: {
      mlb_closing_lines: JSON.stringify(closingLines),
      mlb_open_lines: JSON.stringify(openLines),
    },
  });

  const home = engine.BASELINE.find(t => t.id === "LAD");
  const away = engine.BASELINE.find(t => t.id === "ATL");
  const teams = [
    { ...home, wins: 30, losses: 22 },
    { ...away, wins: 27, losses: 25 },
  ];

  const game = {
    id: 777001, home: "LAD", away: "ATL", start_time: START,
    status: "final", hScore: 6, aScore: 3, gameType: "R",
  };

  const sim = engine.runSimulation(teams[0], teams[1], true, 1, 2, null);
  const odds = {
    hWinPct: sim.hWinPct, aWinPct: sim.aWinPct,
    hRuns: sim.hAvgRuns, aRuns: sim.aAvgRuns,
    ou: sim.avgTotal, overPct: "50",
    hML: engine.toML(sim.hWinProb), aML: engine.toML(1 - sim.hWinProb),
    hRL: "-105", aRL: "-115",
    hMLraw: -145, aMLraw: 122,
    sim,
  };

  await engine.recordVsVegas(game, odds, null, teams);

  // Read back through loadVsVegas, not the raw store: the schemaVersion round-trip
  // is what silently wiped every record before.
  const ledger = await engine.loadVsVegas();
  const rec = ledger.games.find(g => g.id === game.id);

  // And again, to prove a record survives repeated reads.
  const ledger2 = await engine.loadVsVegas();
  const survives = !!ledger2.games.find(g => g.id === game.id);

  if (!rec) {
    console.error("FAIL: recordVsVegas wrote no record");
    process.exit(1);
  }

  // Each of these was broken by one of the four scope bugs.
  const checks = [
    ["record written",            rec != null],
    ["survives reload (schema)",  survives],
    ["vegasML from closing line", rec.vegasML === "-145"],
    ["mlHit settled",             typeof rec.mlHit === "boolean"],
    ["minGP from teams (getT)",   rec.minGP === 52],
    ["clvVsClose (CLOSING_KEY)",  rec.clvVsClose != null],
    ["clvVsOpen (OPEN_KEY)",      rec.clvVsOpen != null],
    ["lineMove (both keys)",      rec.lineMove != null],
    ["openML stored",             rec.openML === "-130"],
    ["closeML stored",            rec.closeML === "-145"],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed++;
  }

  console.log("\nrecord:", JSON.stringify({
    id: rec.id, modelFavTeam: rec.modelFavTeam, modelFavPct: rec.modelFavPct,
    vegasML: rec.vegasML, mlHit: rec.mlHit, minGP: rec.minGP,
    openML: rec.openML, closeML: rec.closeML,
    clvVsOpen: rec.clvVsOpen, clvVsClose: rec.clvVsClose, lineMove: rec.lineMove,
    pickIsDog: rec.pickIsDog, parkRegime: rec.parkRegime, spRegime: rec.spRegime,
  }, null, 2));

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nAll ledger checks passed.");
}

main().catch(e => { console.error("THREW:", e); process.exit(1); });

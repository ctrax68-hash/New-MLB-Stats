// Loads the engine out of index.html so it can be exercised from Node.
//
// index.html is a single-file app: all logic lives in one <script type="text/babel">
// block. This module extracts that block, transpiles the JSX away, and evaluates it
// in a vm context with stubbed browser globals, then hands back the engine functions.
//
// This exists so the simulation/ledger code can be characterized by tests before it
// gets split into real modules. It is deliberately a temporary bridge, not a seam to
// build on — see the migration plan.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const babel = require("@babel/core");

const INDEX_HTML = path.join(__dirname, "..", "index.html");

// Names lifted out of the evaluated bundle. Anything a test or the corpus builder
// needs must be listed here, since the script body has no export statements.
const EXPORTED = [
  // simulation core
  "runSimulation", "predictMatchup", "simulateGame", "poissonDraw",
  "negativeBinomialDraw", "blendedDraw", "simOverProb",
  // team/statistical model
  "BASELINE", "buildLiveTeams", "buildStandingsFromGames", "parseMlbGame",
  "getPark", "getSpAdj", "toML", "pythagFlag", "PARK_FACTORS", "SP_TIERS",
  // variance helpers
  "bbHrVarianceMultiplier", "bullpenVarianceMultiplier", "bullpenStressMultiplier",
  "pitchCountVarianceMultiplier", "eloVolVarianceMultiplier",
  "weatherRunFactor", "weatherVolatilityIndex",
  // learning + calibration
  "applyCalibration", "computeCalibration", "updateLambdaAdj", "loadLambdaAdj",
  "refreshLambdaAdj", "getLambdaAdj", "applyAdaptiveFeedback",
  "loadAdaptiveParams", "saveAdaptiveParams",
  // ledger + betting math
  "recordVsVegas", "loadVsVegas", "saveVsVegas", "computeROI", "computeKellyROI",
  "computeConfROI", "kellyStake", "confidenceStake", "mlToProb", "mlToDecimal",
  // misc
  "localDateKey", "CLOSING_LINES_KEY", "OPEN_LINES_KEY", "REGULAR_SEASON_START",
  // odds budget management
  "loadOddsCache", "saveOddsCache", "loadOddsQuota", "saveOddsQuota",
  "readOddsQuotaHeaders", "oddsCacheTTL", "fmtAge",
  "ODDS_MARKETS", "ODDS_MIN_CREDITS", "ODDS_CACHE_KEY", "ODDS_QUOTA_KEY",
  "ODDS_TTL_NEAR_MS", "ODDS_TTL_FAR_MS",
];

function extractScript(html) {
  const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
  if (!m) throw new Error("could not find the <script type=\"text/babel\"> block in index.html");
  return m[1];
}

/** Minimal in-memory localStorage stand-in. */
function makeStore(seed = {}) {
  const data = { ...seed };
  return {
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    key: i => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length; },
    _dump: () => ({ ...data }),
  };
}

/**
 * Evaluate the engine in an isolated context.
 *
 * @param {object}   opts
 * @param {object}   opts.storeSeed  initial localStorage contents
 * @param {function} opts.random     RNG to use in place of Math.random
 * @param {number}   opts.now        fixed epoch ms for Date.now
 * @returns {object} the exported engine functions, plus `_store` and `_context`
 */
function loadEngine(opts = {}) {
  const { storeSeed = {}, random = Math.random, now = null } = opts;

  const src = extractScript(fs.readFileSync(INDEX_HTML, "utf8"));
  const { code } = babel.transformSync(src, {
    presets: [["@babel/preset-react", { runtime: "classic" }]],
    filename: "index.html.jsx",
    configFile: false,
    babelrc: false,
  });

  const store = makeStore(storeSeed);

  // React is stubbed rather than imported: the engine ranges contain no JSX, but the
  // same script body also defines the UI components, which reference these at parse
  // and module-eval time. They are never rendered here.
  const noop = () => {};
  const React = {
    useState: init => [typeof init === "function" ? init() : init, noop],
    useMemo: fn => fn(),
    useEffect: noop,
    useCallback: fn => fn,
    useRef: v => ({ current: v }),
    useContext: () => ({}),
    createContext: () => ({}),
    createElement: () => null,
    Fragment: "Fragment",
  };

  const asyncStore = {
    get: async k => { const v = store.getItem(k); return v == null ? null : { key: k, value: v }; },
    set: async (k, v) => { store.setItem(k, String(v)); return { key: k, value: v }; },
    delete: async k => { store.removeItem(k); return { key: k, deleted: true }; },
    list: async prefix => ({ keys: Object.keys(store._dump()).filter(k => !prefix || k.startsWith(prefix)) }),
  };

  const RealDate = Date;
  const DateStub = now == null ? RealDate : new Proxy(RealDate, {
    construct: (T, args) => (args.length ? new T(...args) : new T(now)),
    get: (T, prop) => (prop === "now" ? () => now : Reflect.get(T, prop)),
  });

  const sandbox = {
    console,
    React,
    ReactDOM: { createRoot: () => ({ render: noop }) },
    localStorage: store,
    document: { getElementById: () => ({}) },
    fetch: () => Promise.reject(new Error("network disabled in harness")),
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Date: DateStub,
    Math: Object.create(Math, { random: { value: random, writable: true } }),
    JSON, Object, Array, Promise, Error, Set, Map, RegExp, String, Number, Boolean,
    isNaN, isFinite, parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    URLSearchParams, AbortController,
    __exports: {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.storage = asyncStore;

  vm.createContext(sandbox);

  const probe = "\n;" + EXPORTED
    .map(n => `try { __exports[${JSON.stringify(n)}] = ${n}; } catch (e) {}`)
    .join("\n");

  vm.runInContext(code + probe, sandbox, { filename: "engine.js" });

  const missing = EXPORTED.filter(n => sandbox.__exports[n] === undefined);
  if (missing.length) throw new Error("engine symbols not found: " + missing.join(", "));

  // window.storage is reassigned by the bundle's own shim; restore ours so the
  // async ledger writes land in the store we can inspect.
  sandbox.window.storage = asyncStore;

  return { ...sandbox.__exports, _store: store, _context: sandbox };
}

/** Deterministic RNG (mulberry32) so runs are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { loadEngine, mulberry32, makeStore, extractScript, EXPORTED };

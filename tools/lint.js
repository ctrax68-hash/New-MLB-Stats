// Lints the app source that lives inside index.html's <script type="text/babel">
// block, and reports problems at their real index.html line numbers.
//
// Run: node tools/lint.js
// Exits non-zero if any error is found, so it can gate a commit or CI step.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { ESLint } = require("eslint");

const ROOT = path.join(__dirname, "..");
const INDEX_HTML = path.join(ROOT, "index.html");
const OPEN_TAG = '<script type="text/babel">';

async function main() {
  const html = fs.readFileSync(INDEX_HTML, "utf8");

  const openIdx = html.indexOf(OPEN_TAG);
  if (openIdx === -1) throw new Error(`could not find ${OPEN_TAG} in index.html`);
  const bodyStart = openIdx + OPEN_TAG.length;
  const closeIdx = html.indexOf("</script>", bodyStart);
  if (closeIdx === -1) throw new Error("unterminated <script type=\"text/babel\"> block");

  const body = html.slice(bodyStart, closeIdx);
  // Line in index.html where the block's first line sits. The tag line itself
  // ends with a newline, so the body's line 1 is the tag line + 1.
  const lineOffset = html.slice(0, bodyStart).split("\n").length - 1;

  // Must live under the project root or ESLint refuses it as outside the base path.
  const tmpDir = fs.mkdtempSync(path.join(ROOT, ".lint-tmp-"));
  const tmpFile = path.join(tmpDir, "app.jsx");
  fs.writeFileSync(tmpFile, body);

  try {
    const eslint = new ESLint({
      overrideConfigFile: path.join(ROOT, "eslint.config.mjs"),
      cwd: ROOT,
    });
    const results = await eslint.lintFiles([tmpFile]);

    let errors = 0, warnings = 0;
    for (const res of results) {
      for (const m of res.messages) {
        const realLine = m.line + lineOffset;
        const sev = m.severity === 2 ? "error" : "warning";
        if (m.severity === 2) errors++; else warnings++;
        console.log(`index.html:${realLine}:${m.column}  ${sev}  ${m.message}  (${m.ruleId || "syntax"})`);
      }
    }

    if (errors === 0 && warnings === 0) {
      console.log("Clean — no undefined or use-before-declaration problems.");
    } else {
      console.log(`\n${errors} error(s), ${warnings} warning(s)`);
    }
    process.exit(errors > 0 ? 1 : 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e); process.exit(1); });

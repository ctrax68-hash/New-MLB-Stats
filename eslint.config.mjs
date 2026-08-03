// Lint config for the extracted app source (see tools/lint.js).
//
// The rules here are deliberately narrow. This codebase has shipped six
// use-before-declaration bugs — several of which silently disabled whole
// features because the throw was swallowed by a catch or an unawaited
// promise — so `no-undef` and `no-use-before-define` are the rules that
// actually matter. Style rules are intentionally left off for now.

export default [
  {
    files: ["**/*.jsx", "**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        // browser
        window: "readonly", document: "readonly", console: "readonly",
        localStorage: "readonly", sessionStorage: "readonly",
        fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly",
        setInterval: "readonly", clearInterval: "readonly",
        AbortController: "readonly", URLSearchParams: "readonly",
        requestAnimationFrame: "readonly", navigator: "readonly",
        location: "readonly", alert: "readonly", confirm: "readonly",
        Event: "readonly", CustomEvent: "readonly",
        // libraries loaded via <script> tags in index.html
        React: "readonly", ReactDOM: "readonly", Babel: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      // functions:false — the codebase relies on function-declaration hoisting
      // throughout, which is safe. const/let used before their declaration is
      // the actual bug class: it throws at runtime (TDZ).
      "no-use-before-define": ["error", {
        variables: true,
        functions: false,
        classes: true,
        allowNamedExports: false,
      }],
    },
  },
];

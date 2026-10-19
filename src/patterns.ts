// Built-in knowledge: what can be rebuilt, what is a secret, what is quietly critical.

/** Directory or file names that a build/install step recreates, with how. */
const REGEN_DIRS: [string[], string][] = [
  [["node_modules", "bower_components", ".pnpm-store", ".yarn/cache"], "npm / pnpm / yarn install"],
  [[".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".angular", ".expo", ".docusaurus", "storybook-static", ".vercel/output"], "the next dev or build run"],
  [["dist", "build", "_build"], "your build script"],
  [["target"], "cargo build / mvn package"],
  [["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".ipynb_checkpoints"], "the next run"],
  [[".venv", "venv"], "uv sync / pip install"],
  [["vendor"], "go mod vendor / composer / bundle install"],
  [["coverage", ".nyc_output", "htmlcov"], "rerun the tests"],
  [[".gradle", ".dart_tool", "Pods", "DerivedData", ".build", ".terraform", ".cache", ".serverless"], "the toolchain"],
];

const REGEN_FILES: [RegExp, string][] = [
  [/\.(pyc|pyo|o|obj|class|tsbuildinfo)$/i, "the compiler"],
  [/^(\.eslintcache|\.DS_Store|Thumbs\.db|\.stylelintcache)$/, "automatic"],
];

const SECRET_FILE = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|age)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^(credentials|service[-_]?account|client[-_]?secret)[\w.-]*\.json$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/i,
  /^secrets?\.(ya?ml|json|toml|env)$/i,
];
const SECRET_DIR = /^(secrets?|\.secrets|credentials|keys|\.ssh|\.gnupg|\.aws)$/i;
const NOT_SECRET = /^\.env\.(example|sample|template|dist|defaults)$/i;

/** Quietly critical files that are rarely regenerable. Shown as the reason. */
const CRITICAL: [RegExp, string][] = [
  [/\.tfstate(\.backup)?$/i, "Terraform state: losing it orphans real infrastructure"],
  [/\.(sqlite3?|db|duckdb|mdb)$/i, "local database"],
  [/\.(ipynb)$/i, "notebook with outputs"],
  [/\.(psd|blend|kra|aep|prproj|drp|fcpbundle|logicx|als)$/i, "project file: hours of work"],
];

const base = (p: string) => {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
};

/** If `path` (relative, POSIX, dirs end with "/") is regenerable, return how it is rebuilt. */
export function regenerable(path: string): string | undefined {
  const isDir = path.endsWith("/");
  const trimmed = path.replace(/\/+$/, "");
  const segs = trimmed.split("/");
  const name = segs[segs.length - 1];
  const parents = segs.slice(0, -1);
  for (const [names, how] of REGEN_DIRS) {
    for (const n of names) {
      if (n.includes("/")) {
        if (trimmed === n || trimmed.endsWith("/" + n) || trimmed.includes(n + "/")) return how;
      } else if ((isDir && name === n) || parents.includes(n)) return how;
    }
  }
  if (!isDir) for (const [re, how] of REGEN_FILES) if (re.test(name)) return how;
  return undefined;
}

export function isSecret(path: string): boolean {
  const name = base(path);
  if (NOT_SECRET.test(name)) return false;
  if (path.endsWith("/")) return SECRET_DIR.test(name);
  return SECRET_FILE.some((re) => re.test(name));
}

export function critical(path: string): string | undefined {
  const name = base(path);
  for (const [re, why] of CRITICAL) if (re.test(name)) return why;
  return undefined;
}

/** Tiny glob for config entries. "dir/" = that directory (and below); "a/*.x" = relative glob; "*.x" = any basename. */
export function globMatcher(pattern: string): (path: string) => boolean {
  const p = pattern.trim().replace(/^\.\//, "");
  if (!p) return () => false;
  if (p.endsWith("/")) {
    const anchored = p.slice(0, -1).includes("/");
    return (path) => path === p || path.startsWith(p) || (!anchored && ("/" + path).includes("/" + p));
  }
  const re = new RegExp(
    "^" +
      p
        .split("**")
        .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
        .join(".*") +
      "$",
  );
  const rel = p.includes("/");
  return (path) => re.test(rel ? path.replace(/\/+$/, "") : base(path));
}

export function globMatch(pattern: string, path: string): boolean {
  return globMatcher(pattern)(path);
}

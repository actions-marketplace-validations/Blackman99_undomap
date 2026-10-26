// Credential reach (--reach): presence and paths only. Every fixture secret below holds a sentinel value
// that must never show up in any output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "../src/mcp.ts";
import { envCredentials, probeReach } from "../src/reach.ts";
import { mapPath } from "../src/run.ts";
import { formatJson, formatMarkdown, formatText } from "../src/format.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SENTINEL = "SENTINEL-c0ffee-do-not-print";
const ETH = { eth0: [{ address: "10.0.0.7", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:01", internal: false, cidr: "10.0.0.7/8" }] } as any;
const LO = { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] } as any;

function put(base: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), body);
  }
}

/** base/home (fake $HOME with credentials) and base/home/dev/app (the tree). */
function world() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "undomap-reach-")));
  const home = join(base, "home");
  const tree = join(home, "dev", "app");
  put(home, {
    ".aws/credentials": `[default]\naws_secret_access_key = ${SENTINEL}\n`,
    ".ssh/id_ed25519": `-----BEGIN OPENSSH PRIVATE KEY-----\n${SENTINEL}\n`,
    ".ssh/id_ed25519.pub": "ssh-ed25519 AAAA public",
    ".ssh/known_hosts": "github.com ssh-ed25519 AAAA",
    ".kube/config": `token: ${SENTINEL}\n`,
    ".bashrc": "# not a credential\n",
  });
  put(tree, {
    ".env": `API_KEY=${SENTINEL}\n`,
    ".env.example": "API_KEY=\n",
    "config/service-account.json": `{"private_key":"${SENTINEL}"}`,
    "deploy/keys/prod.pem": SENTINEL,
    "deploy/id_rsa.pub": "ssh-rsa AAAA public",
    "node_modules/pkg/.env": SENTINEL,
    "src/index.ts": "export {};\n",
  });
  const env = { PATH: "/usr/bin", HOME: home, GITHUB_TOKEN: SENTINEL, OPENAI_API_KEY: SENTINEL, EMPTY_TOKEN: "", NPM_CONFIG_USERCONFIG: "/x", GH_TOKEN_FILE: "/x", TERM: "xterm" };
  return { base, home, tree, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("finds credentials by name and path only: tree, home and env var names", () => {
  const w = world();
  try {
    const r = probeReach(w.tree, [], { home: w.home, env: w.env, platform: "linux", interfaces: ETH });
    const got = r.credentials.map((c) => `${c.where}:${c.where === "home" ? c.path.slice(w.home.length + 1).split("\\").join("/") : c.path}:${c.type}`);
    assert.deepEqual(got, [
      "tree:.env:dotenv",
      "tree:config/service-account.json:cloud credentials",
      "tree:deploy/keys/:credential folder",
      "home:.aws/credentials:AWS credentials",
      "home:.kube/config:Kubernetes config",
      "home:.ssh/id_ed25519:ssh key",
      "env:GITHUB_TOKEN:token-like name",
      "env:OPENAI_API_KEY:token-like name",
    ]);
    assert.equal(r.credentialsCapped, false);
  } finally {
    w.cleanup();
  }
});

test("env: names only, set values only, pointers to files are not secrets", () => {
  const got = envCredentials({ AWS_SECRET_ACCESS_KEY: "x", DATABASE_URL: "x", SSH_AUTH_SOCK: "/tmp/a", MY_SERVICE_PASSWORD: "x", EMPTY_SECRET: "", GOOGLE_APPLICATION_CREDENTIALS: "/k.json", GH_TOKEN_PATH: "/x", KEYBOARD: "us", TOKENIZERS_PARALLELISM: "1" });
  assert.deepEqual(got.map((c) => `${c.path}:${c.type}`), [
    "AWS_SECRET_ACCESS_KEY:AWS secret key",
    "DATABASE_URL:database URL, may embed a password",
    "GOOGLE_APPLICATION_CREDENTIALS:path to Google credentials",
    "MY_SERVICE_PASSWORD:token-like name",
    "SSH_AUTH_SOCK:ssh-agent socket",
  ]);
  assert.ok(got.every((c) => !JSON.stringify(c).includes('"x"')));
});

test("all three legs: trifecta, the home folder and the parent are writable outside the tree", () => {
  const w = world();
  try {
    const r = probeReach(w.tree, [], { home: w.home, env: w.env, platform: "linux", interfaces: ETH });
    assert.equal(r.network.status, "open");
    assert.match(r.network.detail, /eth0 has an address \(no connection attempted\)/);
    assert.deepEqual(r.writable.map((x) => x.why), ["your home folder", "the folder above the tree"]);
    assert.equal(r.legs, 3);
    assert.equal(r.trifecta, true);
    assert.match(r.fix.say, /^break one leg: sandbox the agent's commands/);
    assert.equal(r.fix.run, 'env -u GITHUB_TOKEN -u OPENAI_API_KEY "$SHELL"');
  } finally {
    w.cleanup();
  }
});

test("network: loopback only is closed, loopback + proxy is unknown, the Codex sandbox flag is closed", () => {
  const w = world();
  try {
    const o = { home: w.home, platform: "linux" };
    assert.equal(probeReach(w.tree, [], { ...o, env: w.env, interfaces: LO }).network.status, "closed");
    const proxied = probeReach(w.tree, [], { ...o, env: { ...w.env, HTTPS_PROXY: "http://127.0.0.1:3128" }, interfaces: LO });
    assert.equal(proxied.network.status, "unknown");
    const codex = probeReach(w.tree, [], { ...o, env: { ...w.env, CODEX_SANDBOX_NETWORK_DISABLED: "1" }, interfaces: ETH });
    assert.deepEqual([codex.network.status, codex.legs, codex.trifecta], ["closed", 2, false]);
    assert.match(codex.fix.say, /^not all three at once \(no network\)/);
    assert.equal(codex.fix.run, undefined);
  } finally {
    w.cleanup();
  }
});

test("no credentials anywhere: one leg missing, and a tree that is home itself has no 'home' outside it", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "undomap-reach-")));
  try {
    put(base, { "h/notes.md": "hi" });
    const r = probeReach(join(base, "h"), [], { home: join(base, "h"), env: { PATH: "/usr/bin" }, platform: "linux", interfaces: ETH });
    assert.equal(r.credentials.length, 0);
    assert.deepEqual(r.writable.map((x) => x.why), ["the folder above the tree"]);
    assert.equal(r.legs, 2);
    assert.match(r.fix.say, /no credentials/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlink escape is a write outside the tree, and the walk skips .git and regenerable folders", { skip: process.platform === "win32" && "symlinks need privileges on Windows" }, () => {
  const w = world();
  try {
    put(w.base, { "outside/data/a.txt": "x" });
    symlinkSync(join(w.base, "outside", "data"), join(w.tree, "shared"));
    put(w.tree, { ".git/config": SENTINEL, ".git/secrets.json": SENTINEL });
    const r = probeReach(w.tree, [{ kind: "symlink-escape", path: "shared", target: join(w.base, "outside", "data") } as any], { home: w.home, env: {}, platform: "linux", interfaces: ETH });
    assert.ok(r.writable.some((x) => x.why === "shared links there"));
    assert.ok(!r.credentials.some((c) => c.path.startsWith(".git/") || c.path.startsWith("node_modules/")));
  } finally {
    w.cleanup();
  }
});

test("the tree walk stops at its entry cap and says so", () => {
  const w = world();
  try {
    const r = probeReach(w.tree, [], { home: w.home, env: {}, platform: "linux", interfaces: ETH, maxEntries: 3 });
    assert.equal(r.credentialsCapped, true);
  } finally {
    w.cleanup();
  }
});

test("text, markdown, JSON and MCP never contain a credential value", () => {
  const w = world();
  try {
    const opts = { home: w.home, env: w.env, platform: "linux", interfaces: ETH };
    const r = mapPath(w.tree, { reach: opts, noProbe: true });
    assert.ok(r.reach?.trifecta);
    const text = formatText(r, { color: false, home: w.home, width: 100 });
    for (const out of [text, formatMarkdown(r), formatJson(r)]) assert.ok(!out.includes(SENTINEL), out);
    assert.match(text, /◆ REACH · LETHAL TRIFECTA {3}3 of 3: a bad command here can leak your keys as well as erase/);
    assert.match(text, /credentials {2}yes {2}\.env · config\/service-account\.json · deploy\/keys\/ · ~[\\/]\.aws[\\/]credentials \+4 more/);
    assert.match(text, /write out {4}yes {2}~ \(your home folder\) · ~[\\/]dev \(the folder above the tree\)/);
    assert.match(text, /\$ env -u GITHUB_TOKEN -u OPENAI_API_KEY "\$SHELL"/);
    assert.match(formatMarkdown(r), /### Credential reach — 3 of 3: lethal trifecta/);
    assert.equal(r.exitCode, 1); // Zone VE decides the exit code, reach never does
  } finally {
    w.cleanup();
  }
});

test("CLI: --reach is opt-in, value-blind, and leaves the exit code alone", () => {
  const w = world();
  try {
    const run = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ...w.env, PATH: process.env.PATH, USERPROFILE: w.home, NO_COLOR: "1", UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "off" },
      });
    const plain = run([w.tree, "--json"]);
    assert.equal("reach" in JSON.parse(plain.stdout), false);
    assert.doesNotMatch(run([w.tree]).stdout, /REACH/);
    const withReach = run([w.tree, "--reach", "--json"]);
    assert.equal(withReach.status, plain.status);
    const j = JSON.parse(withReach.stdout);
    assert.ok(j.reach.credentials.some((c: any) => c.path === "GITHUB_TOKEN" && c.where === "env"));
    for (const args of [[w.tree, "--reach"], [w.tree, "--reach", "--markdown"], [w.tree, "--reach", "--json"]]) {
      const r = run(args);
      assert.ok(!(r.stdout + r.stderr).includes(SENTINEL));
    }
  } finally {
    w.cleanup();
  }
});

test("MCP map_report: reach only when asked for, without values", () => {
  const w = world();
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GITHUB_TOKEN: SENTINEL, UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "off" });
    const off = callTool("map_report", { path: w.tree }).text;
    assert.doesNotMatch(off, /Credential reach/);
    const on = callTool("map_report", { path: w.tree, reach: true }).text;
    assert.match(on, /### Credential reach — \d of 3/);
    assert.match(on, /"where": "env"/);
    assert.ok(!on.includes(SENTINEL));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    w.cleanup();
  }
});

test("reach.ts never opens, reads, writes or connects: it only stats, lists and access()es", () => {
  const src = readFileSync(join(ROOT, "src", "reach.ts"), "utf8");
  const imports = [...src.matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";/gm)].map((m) => [m[2], m[1].split(",").map((x) => x.trim()).filter(Boolean).sort().join(",")]);
  assert.deepEqual(Object.fromEntries(imports), {
    "node:fs": "accessSync,constants,readdirSync,realpathSync,statSync",
    "node:os": "homedir,networkInterfaces",
    "node:path": "dirname,isAbsolute,join,relative,resolve,sep",
    "./patterns.js": "isSecret,regenerable",
    "./types.js": "Finding,Fix,Reach,ReachCredential",
  });
  assert.equal([...src.matchAll(/^import /gm)].length, imports.length);
});

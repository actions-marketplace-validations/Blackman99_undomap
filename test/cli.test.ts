import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "off", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("headline, exit 1 and the cheapest fix when something is in Zone VE", () => {
  const fx = materialize("textures-app");
  try {
    const r = run([fx.dir]);
    assert.equal(r.code, 1, r.err);
    assert.match(r.out, /ZONE VE · PERMANENT\n  \S+ \S+ across 5 places your agent can erase forever/);
    assert.match(r.out, /textures_sorted\/\s+gitignored · 2 files/);
    assert.match(r.out, /fix first  textures_sorted\/ — ignored on purpose/);
    assert.ok(r.out.indexOf("ZONE VE") < r.out.indexOf("ZONE AE"));
    assert.ok(r.out.indexOf("ZONE AE") < r.out.indexOf("ZONE X"));
  } finally {
    fx.cleanup();
  }
});

test("--fix prints a fix under every permanent place", () => {
  const fx = materialize("textures-app");
  try {
    const r = run([fx.dir, "--fix"]);
    const fixes = r.out.match(/^\s+fix /gm) ?? [];
    assert.equal(fixes.length, 5);
    assert.match(r.out, /\$ git add -- notes && git commit/);
    assert.match(r.out, /\$ git bundle create ~\/textures-app.bundle --all/);
  } finally {
    fx.cleanup();
  }
});

test("--json is a complete machine-readable report", () => {
  const fx = materialize("textures-app");
  try {
    const r = run([fx.dir, "--json"]);
    const j = JSON.parse(r.out);
    assert.equal(j.tool, "undomap");
    assert.equal(j.exitCode, 1);
    assert.equal(j.findings[0].zone, "VE");
    assert.ok(j.totals.AE.bytes > 0);
  } finally {
    fx.cleanup();
  }
});

test("--max-permanent lets small permanent bytes through", () => {
  const fx = materialize("textures-app");
  try {
    assert.equal(run([fx.dir, "--max-permanent", "10MB"]).code, 0);
    assert.equal(run([fx.dir, "--max-permanent=1KB"]).code, 1);
  } finally {
    fx.cleanup();
  }
});

test("empty state: a pushed, clean repo exits 0 and says so", () => {
  const fx = materialize("workspace");
  try {
    const r = run([join(fx.dir, "project")]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /0 B — nothing here your agent can erase for good\./);
  } finally {
    fx.cleanup();
  }
});

test("errors exit 2 with a hint", () => {
  let r = run(["/definitely/not/here"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no such directory: .*definitely[\\/]not[\\/]here/);
  r = run(["--frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown option --frobnicate/);
  r = run(["--max-permanent", "lots", "."]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not a size/);
  r = run([join(ROOT, "package.json")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /maps directories/);
});

test("version and help", () => {
  assert.match(run(["--version"]).out, /^undomap \d+\.\d+\.\d+\n$/);
  assert.match(run(["version"]).out, /^undomap /);
  const h = run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /Exit codes: 0 nothing permanent · 1 something in Zone VE · 2/);
});

test("typos get a did-you-mean hint and exit 2", () => {
  const a = run(["--jsno"]);
  assert.equal(a.code, 2);
  assert.match(a.err, /did you mean --json\?/);
  const b = run(["mpa"]);
  assert.equal(b.code, 2);
  assert.match(b.err, /did you mean `undomap map`\?/);
});

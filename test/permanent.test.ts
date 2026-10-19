// `permanent` in .undomap.json: one fixture, one test per precedence rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapPath } from "../src/run.ts";
import { classify } from "../src/grade.ts";
import { materialize } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const byPath = (r: ReturnType<typeof mapPath>) => Object.fromEntries(r.findings.map((f) => [f.path, f]));
const CONFIG = {
  permanent: ["dist/", "models/", "tool-cache/", "bin/tool", "vendor/patched/", "src/"],
  regenerable: ["vendor/"],
};

function withFixture(config: object | null, fn: (dir: string) => void) {
  const fx = materialize("curated-app");
  try {
    if (config) writeFileSync(join(fx.dir, ".undomap.json"), JSON.stringify(config));
    fn(fx.dir);
  } finally {
    fx.cleanup();
  }
}

test("control: without config every curated folder looks regenerable (Zone AE)", () => {
  withFixture(null, (dir) => {
    const f = byPath(mapPath(dir, { noProbe: true }));
    assert.equal(f["dist/"].zone, "AE");
    assert.equal(f[".cache/"].zone, "AE");
    assert.equal(f[".cache/"].bytes, 12000);
    assert.equal(f["tool-cache/"].kind, "regenerable");
    assert.match(f["tool-cache/"].why, /CACHEDIR\.TAG/);
    assert.match(f["bin/tool"].why, /regenerable \(compiled ELF binary: rebuild\)/);
    assert.equal(f[".cache/models/"], undefined);
  });
});

test("permanent beats a built-in regenerable name (dist/)", () => {
  withFixture(CONFIG, (dir) => {
    const d = byPath(mapPath(dir, { noProbe: true }))["dist/"];
    assert.equal(d.zone, "VE");
    assert.equal(d.kind, "ignored");
    assert.equal(d.forcedBy, "dist/");
    assert.equal(d.bytes, 8000);
    assert.match(d.why, /^gitignored · looks regenerable \(your build script\) but \.undomap\.json marks it permanent$/);
    assert.ok(d.fix?.run, "a forced place still gets a copy-paste fix");
  });
});

test("permanent carves a subfolder out of a regenerable folder (.cache/models/)", () => {
  withFixture(CONFIG, (dir) => {
    const f = byPath(mapPath(dir, { noProbe: true }));
    assert.equal(f[".cache/models/"].zone, "VE");
    assert.equal(f[".cache/models/"].bytes, 9000);
    assert.equal(f[".cache/models/"].forcedBy, "models/");
    assert.equal(f[".cache/"].zone, "AE");
    assert.equal(f[".cache/"].bytes, 3000, "the carved bytes are not counted twice");
  });
});

test("permanent beats content markers: CACHEDIR.TAG folders and compiled binaries", () => {
  withFixture(CONFIG, (dir) => {
    const f = byPath(mapPath(dir, { noProbe: true }));
    assert.equal(f["tool-cache/"].zone, "VE");
    assert.match(f["tool-cache/"].why, /looks regenerable \(cache, CACHEDIR\.TAG\) but \.undomap\.json marks it permanent/);
    assert.equal(f["bin/tool"].zone, "VE");
    assert.equal(f["bin/tool"].bytes, 256);
    assert.match(f["bin/tool"].why, /compiled ELF binary/);
  });
});

test("permanent beats your own regenerable list (vendor/patched/ inside vendor/)", () => {
  withFixture(CONFIG, (dir) => {
    const f = byPath(mapPath(dir, { noProbe: true }));
    assert.equal(f["vendor/patched/"].zone, "VE");
    assert.equal(f["vendor/patched/"].bytes, 700);
    assert.equal(f["vendor/"].zone, "AE");
    assert.equal(f["vendor/"].bytes, 500);
  });
  // the same path in both lists: permanent wins
  const e = { path: "weights.ckpt", bytes: 9, files: 1, git: "ignored" as const };
  assert.equal(classify(e, { regenerable: ["*.ckpt"], permanent: ["*.ckpt"] }).zone, "VE");
  assert.equal(classify(e, { regenerable: ["*.ckpt"] }).zone, "AE");
});

test("backedUp still demotes a permanent place to Zone AE: a backup really covers it", () => {
  withFixture({ ...CONFIG, backedUp: ["dist/"] }, (dir) => {
    const d = byPath(mapPath(dir, { noProbe: true }))["dist/"];
    assert.equal(d.zone, "AE");
    assert.equal(d.kind, "backed-up");
    assert.equal(d.forcedBy, "dist/");
    assert.equal(d.why, "gitignored, marked permanent, but backed up per .undomap.json");
  });
});

test("a snapshot that covers a permanent place still demotes it to Zone AE", () => {
  withFixture(CONFIG, (dir) => {
    const prev = process.env.UNDOMAP_SNAPSHOTS;
    process.env.UNDOMAP_SNAPSHOTS = `fake:test snapshot:${join(dir, "dist")}`;
    try {
      const f = byPath(mapPath(dir));
      assert.equal(f["dist/"].zone, "AE");
      assert.equal(f["dist/"].kind, "snapshot");
      assert.match(f["dist/"].why, /marked permanent; restorable from test snapshot/);
      assert.equal(f[".cache/models/"].zone, "VE", "the snapshot only covers dist/");
    } finally {
      if (prev === undefined) delete process.env.UNDOMAP_SNAPSHOTS;
      else process.env.UNDOMAP_SNAPSHOTS = prev;
    }
  });
});

test("git still wins: permanent can't make tracked files permanent", () => {
  withFixture(CONFIG, (dir) => {
    const f = byPath(mapPath(dir, { noProbe: true }));
    assert.equal(f["src/app.js"].kind, "dirty");
    assert.equal(f["src/app.js"].zone, "AE");
    assert.equal(f["src/app.js"].forcedBy, undefined);
    assert.equal(f["./"].zone, "X");
    assert.equal(f["./"].files, 4);
  });
  assert.equal(classify({ path: "./", bytes: 1, files: 1, git: "clean", aggregate: true }, { permanent: ["*"] }).zone, "X");
  assert.equal(classify({ path: ".git/", bytes: 0, files: 0, git: "clean", repoIssue: "unpushed", unpushed: 1 }, { permanent: [".git/"] }).zone, "AE");
});

test("config: permanent must be a list of patterns", () => {
  withFixture({ permanent: "dist/" }, (dir) => {
    assert.throws(() => mapPath(dir, { noProbe: true }), /"permanent" must be an array of path patterns/);
  });
  withFixture({ permanant: [] }, (dir) => {
    assert.throws(() => mapPath(dir, { noProbe: true }), /unknown key "permanant" \(known: permanent, regenerable, backedUp\)/);
  });
});

test("--json and MCP list_permanent say the config forced it", () => {
  withFixture(CONFIG, (dir) => {
    const env = { ...process.env, NO_COLOR: "1", UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "off" };
    const cli = (args: string[], input?: string) =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), ...args], { cwd: ROOT, encoding: "utf8", env, input });
    const j = JSON.parse(cli([dir, "--json"]).stdout);
    const d = j.findings.find((x: any) => x.path === "dist/");
    assert.equal(d.forcedBy, "dist/");
    assert.equal(d.zone, "VE");
    const msg = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_permanent", arguments: { path: dir, limit: 50 } } };
    const out = JSON.parse(cli(["mcp"], JSON.stringify(msg) + "\n").stdout.trim());
    const perm = JSON.parse(out.result.content[0].text).permanent;
    const m = perm.find((x: any) => x.path === "dist/");
    assert.equal(m.forcedBy, "dist/");
    assert.match(m.why, /marks it permanent/);
    assert.deepEqual(perm.map((x: any) => x.path).sort(), j.findings.filter((x: any) => x.zone === "VE").map((x: any) => x.path).sort());
  });
});

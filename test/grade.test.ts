import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, grade, type Inventory } from "../src/grade.ts";
import { fmtBytes, parseBytes } from "../src/bytes.ts";
import { globMatch, isSecret, regenerable } from "../src/patterns.ts";
import type { RawEntry } from "../src/types.ts";
import { fixFor } from "../src/fix.ts";

const inv = (entries: RawEntry[], probes: Inventory["probes"] = []): Inventory => ({
  root: "/w",
  rootName: "w",
  platform: "linux",
  scannedAt: "2026-10-15T02:00:00.000Z",
  durationMs: 5,
  repos: [],
  probes,
  entries,
  skipped: [],
});

test("zones: ignored data is VE, node_modules AE, clean tracked X", () => {
  assert.equal(classify({ path: "textures/", bytes: 10, files: 1, git: "ignored" }).zone, "VE");
  assert.equal(classify({ path: "node_modules/", bytes: 10, files: 1, git: "ignored" }).zone, "AE");
  assert.equal(classify({ path: "a/b/__pycache__/", bytes: 10, files: 1, git: "ignored" }).zone, "AE");
  assert.equal(classify({ path: "x.pyc", bytes: 10, files: 1, git: "ignored" }).zone, "AE");
  assert.equal(classify({ path: "./", bytes: 10, files: 3, git: "clean", aggregate: true }).zone, "X");
  assert.equal(classify({ path: "src/a.ts", bytes: 10, files: 1, git: "dirty" }).kind, "dirty");
  assert.equal(classify({ path: "notes/", bytes: 10, files: 1, git: "untracked" }).kind, "untracked");
  assert.equal(classify({ path: "scratch/", bytes: 10, files: 1, git: "none" }).kind, "no-git");
});

test("repo-level: no remote is VE, unpushed is AE; snapshots and config soften VE", () => {
  assert.equal(classify({ path: ".git/", bytes: 9, files: 2, git: "clean", repoIssue: "no-remote", unpushed: 3 }).zone, "VE");
  assert.equal(classify({ path: ".git/", bytes: 0, files: 0, git: "clean", repoIssue: "unpushed", unpushed: 2 }).why, "2 commits not on any remote");
  assert.equal(classify({ path: "media/", bytes: 9, files: 2, git: "ignored", snapshot: "Time Machine" }).kind, "snapshot");
  assert.equal(classify({ path: "media/", bytes: 9, files: 2, git: "ignored" }, { backedUp: ["media/"] }).kind, "backed-up");
  assert.equal(classify({ path: "gen/out.bin", bytes: 9, files: 1, git: "ignored" }, { regenerable: ["gen/"] }).zone, "AE");
  assert.equal(classify({ path: "link", bytes: 9, files: 1, git: "none", target: "/home/me/infra" }).kind, "symlink-escape");
});

test("secrets and critical files are called out", () => {
  const env = classify({ path: ".env", bytes: 40, files: 1, git: "ignored" });
  assert.equal(env.secret, true);
  assert.match(env.why, /looks like secrets/);
  assert.equal(isSecret(".env.example"), false);
  assert.equal(isSecret("deploy/id_ed25519"), true);
  assert.equal(isSecret("secrets/"), true);
  assert.match(classify({ path: "infra/terraform.tfstate", bytes: 40, files: 1, git: "ignored" }).why, /Terraform state/);
});

test("grade: ranks VE by bytes, counts places, exit code honours the threshold", () => {
  const entries: RawEntry[] = [
    { path: ".env", bytes: 40, files: 1, git: "ignored" },
    { path: "data/", bytes: 5_000_000, files: 12, git: "ignored" },
    { path: "node_modules/", bytes: 90_000_000, files: 900, git: "ignored" },
    { path: "./", bytes: 1000, files: 10, git: "clean", aggregate: true },
    { path: "empty/", bytes: 0, files: 0, git: "untracked" },
  ];
  const r = grade(inv(entries));
  assert.deepEqual(r.findings.map((f) => f.path), ["data/", ".env", "node_modules/", "./"]);
  assert.equal(r.totals.VE.places, 2);
  assert.equal(r.totals.VE.bytes, 5_000_040);
  assert.equal(r.exitCode, 1);
  assert.equal(grade(inv(entries), { thresholdBytes: parseBytes("10MB") }).exitCode, 0);
  assert.equal(r.findings[0].fix?.cost, "seconds");
  assert.match(r.findings[1].fix!.say, /password manager/);
});

test("grade: empty and all-clean maps exit 0", () => {
  assert.equal(grade(inv([])).exitCode, 0);
  assert.equal(grade(inv([{ path: "./", bytes: 1, files: 1, git: "clean", aggregate: true }])).exitCode, 0);
});

test("fixes: big data gets a copy-out, untracked small gets a commit, no-remote gets a bundle", () => {
  const r = grade(
    inv([
      { path: "footage/", bytes: 3e9, files: 40, git: "none" },
      { path: "notes/", bytes: 3000, files: 2, git: "untracked" },
      { path: ".git/", bytes: 3000, files: 2, git: "clean", repoIssue: "no-remote", unpushed: 4 },
    ]),
  );
  const by = Object.fromEntries(r.findings.map((f) => [f.path, f.fix!]));
  assert.match(by["footage/"].run!, /rsync -a footage\/ ~\/\.undomap-safe\/w-footage\//);
  assert.match(by["notes/"].run!, /^git add -- notes && git commit/);
  assert.match(by[".git/"].run!, /bundle create/);
});

test("patterns + bytes helpers", () => {
  assert.ok(regenerable("web/.next/"));
  assert.ok(regenerable("node_modules/left-pad/index.js"));
  assert.equal(regenerable("src/build.ts"), undefined);
  assert.equal(regenerable("buildings/"), undefined);
  assert.ok(globMatch("*.parquet", "data/x.parquet"));
  assert.ok(globMatch("media/", "projects/media/clip.mov"));
  assert.ok(!globMatch("a/media/", "b/media/clip.mov"));
  assert.ok(globMatch("data/**/*.csv", "data/2026/10/x.csv"));
  assert.equal(fmtBytes(0), "0 B");
  assert.equal(fmtBytes(1536), "1.5 KB");
  assert.equal(fmtBytes(5 * 1024 ** 3), "5.0 GB");
  assert.equal(parseBytes("1.5GB"), Math.round(1.5 * 1024 ** 3));
  assert.equal(parseBytes("512k"), 512 * 1024);
  assert.throws(() => parseBytes("lots"), /not a size/);
});

test("fixes: a small untracked video is copied out, not committed", () => {
  const f = { zone: "VE", kind: "untracked", path: "renders/", bytes: 3_000_000, files: 1, capped: false, why: "", secret: false } as any;
  const fx = fixFor(f, { platform: "linux", rootName: "p", snapshots: false })!;
  assert.match(fx.say, /^binary, keep it out of git/);
  assert.doesNotMatch(fx.run!, /git add/);
  const small = fixFor({ ...f, path: "notes/", bytes: 3_000, files: 3 }, { platform: "linux", rootName: "p", snapshots: false })!;
  assert.match(small.run!, /^git add -- notes/);
});

test("fixes: every copy into ~/.undomap-safe creates it private (mkdir -m 700); odd names are quoted", () => {
  const ctx = { platform: "linux", rootName: "my app", snapshots: false };
  const f = (path: string, kind: string, bytes = 300) => fixFor({ zone: "VE", kind, path, bytes, files: 1, capped: false, why: "", secret: false } as any, ctx)!;
  for (const fx of [f("build.log", "ignored"), f("notes.txt", "no-git"), f("big data/", "ignored", 3e9), f(".env", "ignored")]) {
    assert.match(fx.run!, /^mkdir -p -m 700 ~\/\.undomap-safe && /, fx.run);
  }
  assert.equal(f("build.log", "ignored").run, "mkdir -p -m 700 ~/.undomap-safe && tar -czf ~/.undomap-safe/my-app-build.log.tgz build.log");
  assert.match(f("big data/", "ignored", 3e9).run!, /rsync -a 'big data'\/ ~\/\.undomap-safe\/my-app-big-data\/$/);
});

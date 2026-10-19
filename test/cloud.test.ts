// Cloud-sync versioning: every provider and every rule runs from fixtures (injected home, env, fs and process list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { probeCloud, type CloudFs, type CloudOptions } from "../src/cloud.ts";
import { classify, grade, type Inventory } from "../src/grade.ts";
import { mapPath } from "../src/run.ts";
import { materialize } from "./helpers.ts";

/** A fake filesystem: directories, and files with contents. */
function fakeFs(platform: "darwin" | "linux" | "win32", dirs: string[], files: Record<string, string> = {}): CloudFs {
  const P = platform === "win32" ? win32 : posix;
  const k = (p: string) => (platform === "linux" ? p : p.toLowerCase());
  const d = new Set<string>();
  for (const x of [...dirs, ...Object.keys(files).map((f) => P.dirname(f))]) for (let y = x; ; y = P.dirname(y)) { d.add(k(y)); if (P.dirname(y) === y) break; }
  const f = new Map(Object.entries(files).map(([p, c]) => [k(p), c]));
  const all = [...dirs, ...Object.keys(files)];
  return {
    isDir: (p) => d.has(k(p)),
    isFile: (p) => f.has(k(p)),
    read: (p) => f.get(k(p)),
    list: (p) => [...new Set(all.filter((x) => k(P.dirname(x)) === k(p)).map((x) => P.basename(x)))].concat(dirs.filter((x) => k(x).startsWith(k(p) + P.sep) && !all.includes(P.dirname(x))).map((x) => x.slice(p.length + 1).split(P.sep)[0])),
    real: (p) => p,
  };
}
const ps = (...names: string[]) => (cmd: string) =>
  cmd === "ps" ? { ok: true, out: names.map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`).join("\n") + "\n" } : cmd === "tasklist" ? { ok: true, out: names.map((n) => `"${n}","1234","Console","1","90,000 K"`).join("\r\n") } : { ok: false, out: "" };
const noAttr = () => false;
const dir = { bytes: 5000, maxFile: 4000, dir: true };
const file = (bytes: number) => ({ bytes, dir: false });

test("iCloud Drive: deletes come back for 30 days, overwrites don't, so it never leaves Zone VE", () => {
  const icloud = "/Users/ana/Library/Mobile Documents/com~apple~CloudDocs";
  const c = probeCloud(`${icloud}/proj`, { platform: "darwin", home: "/Users/ana", env: {}, fs: fakeFs("darwin", [`${icloud}/proj`]), run: ps() });
  assert.equal(c.probes[0].name, "cloud sync");
  assert.match(c.probes[0].detail, /^iCloud Drive ~\/Library\/Mobile Documents · deletes recoverable 30 days, overwrites not versioned/);
  assert.equal(c.probes[0].counts, false);
  assert.equal(c.check(`${icloud}/proj/renders/`, dir)?.status, "partial");
  assert.equal(c.check(`${icloud}/proj/cache.nosync`, dir)?.status, "gap");
  assert.equal(c.check(`${icloud}/proj/build.nosync/out.bin`, file(10))?.note, ".nosync item");
  assert.equal(c.check(`${icloud}/proj/upload.TMP`, file(10))?.status, "gap");
  assert.equal(c.check(`${icloud}/proj/huge.mov`, file(60 * 1024 ** 3))?.note, "a file over the 50 GB limit");
  assert.equal(c.check(`/Users/ana/code/x`, dir), undefined);
});

test("Dropbox: info.json + running client = covered; ignore attributes, temp names and ignore rules are gaps", () => {
  const root = "/Users/ana/Library/CloudStorage/Dropbox";
  const fs = fakeFs("darwin", [`${root}/proj/data/raw`], {
    "/Users/ana/.dropbox/info.json": JSON.stringify({ personal: { path: root, host: 1, is_team: false } }),
    [`${root}/rules.dropboxignore`]: "# ignore rules\nscratch/\n!keep.txt\n",
  });
  const ignored = new Set([`${root}/proj/data/raw`]);
  const opts: CloudOptions = { platform: "darwin", home: "/Users/ana", env: {}, fs, run: ps("Dropbox"), dropboxIgnored: (p) => ignored.has(p) };
  const c = probeCloud(`${root}/proj`, opts);
  assert.equal(c.probes[0].status, "ok");
  assert.match(c.probes[0].detail, /^Dropbox ~\/Library\/CloudStorage\/Dropbox · client running · version history and deleted files/);
  assert.equal(c.check(`${root}/proj/data/clean/`, dir)?.status, "covered");
  assert.deepEqual(c.check(`${root}/proj/data/raw/2026/`, dir), { provider: "Dropbox", status: "gap", note: "ignore attribute set", root });
  assert.equal(c.check(`${root}/proj/~$budget.xlsx`, file(10))?.note, "temporary file");
  assert.equal(c.check(`${root}/proj/~lock.tmp`, file(10))?.status, "gap");
  assert.equal(c.check(`${root}/proj/scratch/notes.md`, file(10))?.note, "matches rules.dropboxignore");
  // A huge folder is fine for Dropbox: no per-file limit to check.
  assert.equal(c.check(`${root}/proj/footage/`, { bytes: 900 * 1024 ** 3, maxFile: 300 * 1024 ** 3, dir: true, capped: true })?.status, "covered");
});

test("Dropbox: client not running, marker only, or unreadable attributes stay unverified", () => {
  const root = "/home/ana/Dropbox";
  const info = { "/home/ana/.dropbox/info.json": JSON.stringify({ business: { path: root } }) };
  const base: CloudOptions = { platform: "linux", home: "/home/ana", env: {}, fs: fakeFs("linux", [`${root}/proj`], info) };
  let c = probeCloud(`${root}/proj`, { ...base, run: ps(), dropboxIgnored: noAttr });
  assert.equal(c.probes[0].status, "unknown");
  assert.match(c.probes[0].detail, /possible cloud versioning, unverified \(Dropbox app not running\)/);
  assert.equal(c.check(`${root}/proj/a/`, dir)?.status, "unverified");
  // ps itself failed
  c = probeCloud(`${root}/proj`, { ...base, run: () => ({ ok: false, out: "" }) });
  assert.equal(c.check(`${root}/proj/a/`, dir)?.note, "couldn't list running apps");
  // running, but getfattr is missing: can't rule out an ignored folder
  c = probeCloud(`${root}/proj`, { ...base, run: (cmd) => (cmd === "ps" ? { ok: true, out: "dropbox\n" } : { ok: false, out: "" }) });
  assert.equal(c.probes[0].status, "ok");
  assert.deepEqual(c.check(`${root}/proj/a/`, dir)?.status, "unverified");
  assert.match(c.check(`${root}/proj/a/`, dir)!.note, /install attr/);
  // getfattr says "no such attribute": covered
  c = probeCloud(`${root}/proj`, { ...base, run: (cmd) => (cmd === "ps" ? { ok: true, out: "dropbox\n" } : { ok: false, out: "a: user.com.dropbox.ignored: No such attribute" }) });
  assert.equal(c.check(`${root}/proj/a/`, dir)?.status, "covered");
  // no info.json, just a .dropbox marker above the map: could be a stale copy
  const m = probeCloud("/srv/old-dropbox/proj", { platform: "linux", home: "/home/ana", env: {}, fs: fakeFs("linux", ["/srv/old-dropbox/proj"], { "/srv/old-dropbox/.dropbox": "" }), run: ps("dropbox") });
  assert.match(m.probes[0].detail, /^Dropbox \/srv\/old-dropbox · possible cloud versioning, unverified \(\.dropbox marker but no client config, may be a stale copy\)/);
  assert.equal(m.check("/srv/old-dropbox/proj/x", file(3))?.status, "unverified");
});

test("OneDrive on Windows: %OneDriveCommercial% + OneDrive.exe = covered; refused names and the 250 GB limit are gaps", () => {
  const root = "C:\\Users\\ana\\OneDrive - Contoso";
  const fs = fakeFs("win32", [`${root}\\proj`, "C:\\Users\\ana\\OneDrive - Old"]);
  const opts: CloudOptions = { platform: "win32", home: "C:\\Users\\ana", env: { OneDriveCommercial: root }, fs, run: ps("OneDrive.exe") };
  const c = probeCloud(`${root}\\proj`, opts);
  assert.match(c.probes[0].detail, /^OneDrive ~\\OneDrive - Contoso · client running · version history and recycle bin/);
  assert.equal(c.check(`${root}\\PROJ\\data\\`, dir)?.status, "covered", "Windows paths compare case-insensitively");
  assert.equal(c.check(`${root}\\proj\\~$report.docx`, file(10))?.status, "gap");
  assert.equal(c.check(`${root}\\proj\\CON.txt`, file(10))?.note, "refused name");
  assert.equal(c.check(`${root}\\proj\\render.tmp`, file(10))?.status, "gap");
  assert.equal(c.check(`${root}\\proj\\vm.vhdx`, file(300 * 1024 ** 3))?.note, "a file over the 250 GB limit");
  assert.equal(c.check(`${root}\\proj\\vms\\`, { bytes: 400 * 1024 ** 3, maxFile: 260 * 1024 ** 3, dir: true })?.status, "gap");
  assert.equal(c.check(`${root}\\proj\\big\\`, { bytes: 9e9, maxFile: 1e9, dir: true, capped: true })?.status, "unverified");
  // a leftover ~\OneDrive - Old folder with no env var pointing at it: unverified
  const old = probeCloud("C:\\Users\\ana\\OneDrive - Old\\x", { ...opts, fs: fakeFs("win32", ["C:\\Users\\ana\\OneDrive - Old\\x"]) });
  assert.equal(old.check("C:\\Users\\ana\\OneDrive - Old\\x\\a\\", dir)?.status, "unverified");
});

test("OneDrive on macOS and Linux: ~/Library/CloudStorage is strong, a bare ~/OneDrive is not", () => {
  const cs = "/Users/ana/Library/CloudStorage/OneDrive-Personal";
  const mac = probeCloud(`${cs}/p`, { platform: "darwin", home: "/Users/ana", env: {}, fs: fakeFs("darwin", [`${cs}/p`]), run: ps("OneDrive") });
  assert.equal(mac.check(`${cs}/p/notes.md`, file(10))?.status, "covered");
  assert.equal(mac.check(`${cs}/p/sp<ec>ial.md`, file(10))?.note, "refused characters");
  const lin = probeCloud("/home/ana/OneDrive/p", { platform: "linux", home: "/home/ana", env: {}, fs: fakeFs("linux", ["/home/ana/OneDrive/p"]), run: ps("onedrive") });
  assert.equal(lin.check("/home/ana/OneDrive/p/notes.md", file(10))?.status, "unverified");
});

test("Google Drive: CloudStorage and G:\\My Drive with the client running are covered; legacy ~/Google Drive is not", () => {
  const cs = "/Users/ana/Library/CloudStorage/GoogleDrive-ana@example.com";
  const mac = probeCloud(`${cs}/My Drive/p`, { platform: "darwin", home: "/Users/ana", env: {}, fs: fakeFs("darwin", [`${cs}/My Drive/p`]), run: ps("Google Drive") });
  assert.equal(mac.check(`${cs}/My Drive/p/thesis/`, dir)?.status, "covered");
  assert.match(mac.check(`${cs}/My Drive/p/thesis/`, dir)!.note, /30 days or 100 versions/);
  assert.equal(mac.check(`${cs}/My Drive/p/.DS_Store`, file(10))?.status, "gap");
  const legacy = probeCloud("/Users/ana/Google Drive/p", { platform: "darwin", home: "/Users/ana", env: {}, fs: fakeFs("darwin", ["/Users/ana/Google Drive/p"]), run: ps("Google Drive") });
  assert.match(legacy.probes[0].detail, /legacy Backup and Sync/);
  assert.equal(legacy.check("/Users/ana/Google Drive/p/x", file(1))?.status, "unverified");
  const win = { platform: "win32", home: "C:\\Users\\ana", env: {}, fs: fakeFs("win32", ["G:\\My Drive\\p", "G:\\.shortcut-targets-by-id"]) } as const;
  assert.equal(probeCloud("G:\\My Drive\\p", { ...win, run: ps("GoogleDriveFS.exe") }).check("G:\\My Drive\\p\\a\\", dir)?.status, "covered");
  assert.equal(probeCloud("G:\\My Drive\\p", { ...win, run: ps() }).check("G:\\My Drive\\p\\a\\", dir)?.status, "unverified");
});

test("no sync folder: one hidden 'absent' probe and nothing changes; mode off skips it", () => {
  const c = probeCloud("/home/ana/code/app", { platform: "linux", home: "/home/ana", env: {}, fs: fakeFs("linux", ["/home/ana/code/app"]), run: ps("dropbox") });
  assert.deepEqual(c.probes, [{ name: "cloud sync", status: "absent", detail: "not in an iCloud Drive, Dropbox, OneDrive or Google Drive folder", counts: false }]);
  assert.equal(c.check("/home/ana/code/app/x", file(1)), undefined);
  assert.deepEqual(probeCloud("/x", { mode: "off" }).probes, []);
  assert.deepEqual(probeCloud("/x", { env: { UNDOMAP_CLOUD: "off" } }).probes, []);
  // a map that *contains* a sync folder (mapping ~) still checks paths inside it
  const home = probeCloud("/home/ana", { platform: "linux", home: "/home/ana", env: {}, fs: fakeFs("linux", ["/home/ana/Dropbox/p"]), run: ps() });
  assert.equal(home.check("/home/ana/Dropbox/p/x", file(1))?.status, "unverified");
  assert.equal(home.check("/home/ana/code/x", file(1)), undefined);
});

// --- grading ---------------------------------------------------------------------------------------------------
const cov = (status: "covered" | "unverified" | "partial" | "gap", note = "x", provider: any = "Dropbox") => ({ provider, status, note, root: "/d" });
const inv = (entries: Inventory["entries"], probes: Inventory["probes"] = []): Inventory => ({ root: "/d/p", rootName: "p", platform: "linux", scannedAt: "", durationMs: 1, repos: [], probes, entries, skipped: [] });

test("grading: only verified coverage demotes to Zone AE; the rest stays Zone VE and says why", () => {
  const e = { path: "renders/", bytes: 9, files: 2, git: "untracked" as const };
  const a = classify({ ...e, cloud: cov("covered", "version history and deleted files, 30+ days by plan") });
  assert.equal(a.zone, "AE");
  assert.equal(a.kind, "cloud");
  assert.equal(a.why, "untracked; in Dropbox (version history and deleted files, 30+ days by plan)");
  assert.deepEqual(a.cloud, { provider: "Dropbox", status: "covered", note: "version history and deleted files, 30+ days by plan" });
  const u = classify({ ...e, cloud: cov("unverified", "Dropbox app not running") });
  assert.equal(u.zone, "VE");
  assert.equal(u.why, "untracked · possible Dropbox versioning, unverified");
  assert.equal(classify({ ...e, cloud: cov("partial", "", "iCloud Drive") }).why, "untracked · iCloud Drive keeps deletes 30 days, not overwrites");
  assert.equal(classify({ ...e, cloud: cov("gap", "matches rules.dropboxignore") }).why, "untracked · Dropbox skips it (matches rules.dropboxignore)");
  // no-remote repos and symlink targets follow the same rule
  assert.equal(classify({ path: ".git/", bytes: 9, files: 2, git: "clean", repoIssue: "no-remote", unpushed: 3, cloud: cov("covered") }).kind, "cloud");
  assert.equal(classify({ path: ".git/", bytes: 9, files: 2, git: "clean", repoIssue: "no-remote", unpushed: 3, cloud: cov("unverified") }).zone, "VE");
  assert.equal(classify({ path: "link", bytes: 9, files: 1, git: "none", target: "/d/x", cloud: cov("covered") }).zone, "AE");
  // precedence: a snapshot label wins over cloud; cloud coverage is real coverage, so it beats `permanent` like backedUp does
  assert.equal(classify({ ...e, snapshot: "Time Machine", cloud: cov("covered") }).kind, "snapshot");
  const forced = classify({ path: "dist/", bytes: 9, files: 1, git: "ignored", cloud: cov("covered") }, { permanent: ["dist/"] });
  assert.equal(forced.zone, "AE");
  assert.match(forced.why, /^gitignored, marked permanent; in Dropbox/);
  // regenerable stays regenerable: cloud doesn't touch it
  assert.equal(classify({ path: "node_modules/", bytes: 9, files: 1, git: "ignored", cloud: cov("unverified") }).kind, "regenerable");
});

test("fixes inside a sync folder say what the provider does, and keep the copy-paste-safe command", () => {
  const r = grade(
    inv(
      [
        { path: "Final Cut/", bytes: 3e9, files: 40, git: "none", cloud: cov("unverified", "Dropbox app not running") },
        { path: "notes/", bytes: 3000, files: 2, git: "untracked", cloud: cov("unverified", ".dropbox marker but no client config, may be a stale copy") },
        { path: ".env", bytes: 40, files: 1, git: "ignored", cloud: cov("partial", "", "iCloud Drive") },
        { path: "~$draft.docx", bytes: 40, files: 1, git: "none", cloud: cov("gap", "temporary file") },
      ],
      [{ name: "cloud sync", status: "ok", detail: "Dropbox", counts: true }],
    ),
  );
  const by = Object.fromEntries(r.findings.map((f) => [f.path, f.fix!]));
  assert.equal(by["Final Cut/"].say, "too big for git: copy it where the agent can't write, then snapshot that copy · possible Dropbox versioning, unverified");
  assert.equal(by["Final Cut/"].run, "mkdir -p -m 700 ~/.undomap-safe && rsync -a 'Final Cut'/ ~/.undomap-safe/p-Final-Cut/");
  assert.equal(by["notes/"].say, "commit it, then git checkout brings it back · possible Dropbox versioning, unverified");
  assert.match(by[".env"].say, /^keep a copy outside the tree .* · iCloud Drive only brings back deletes, not overwrites$/);
  assert.match(by[".env"].run!, /^mkdir -p -m 700 ~\/\.undomap-safe && cp -Rp \.env /);
  assert.match(by["~$draft.docx"].say, / · Dropbox skips it: temporary file$/);
  assert.equal(by["~$draft.docx"].run, "mkdir -p -m 700 ~/.undomap-safe && cp -p '~$draft.docx' ~/.undomap-safe/", "a leading ~ is quoted so the shell doesn't expand it");
  // a cloud probe isn't a machine snapshot: the big-file fix still says to snapshot the copy
  assert.match(by["Final Cut/"].say, /then snapshot that copy/);
});

// --- end to end on real folders ---------------------------------------------------------------------------------
test("map: a project inside a verified Dropbox folder moves to Zone AE, an ignored folder in it stays Zone VE", () => {
  const fx = materialize("textures-app");
  try {
    const home = join(fx.base, "home");
    mkdirSync(join(home, ".dropbox"), { recursive: true });
    writeFileSync(join(home, ".dropbox", "info.json"), JSON.stringify({ personal: { path: fx.base } }));
    const run = ps("Dropbox", "dropbox", "Dropbox.exe");
    let r = mapPath(fx.dir, { noProbe: false, snapshots: { probes: [], covers: () => undefined }, cloud: { home, env: {}, run, dropboxIgnored: () => false } });
    let f = Object.fromEntries(r.findings.map((x) => [x.path, x]));
    assert.equal(f["textures_sorted/"].zone, "AE");
    assert.equal(f["textures_sorted/"].kind, "cloud");
    assert.equal(f[".env"].zone, "AE");
    assert.equal(f["./.git/"].kind, "cloud");
    assert.equal(f["node_modules/"].kind, "regenerable");
    assert.ok(r.probes.some((p) => p.name === "cloud sync" && p.status === "ok"));
    assert.equal(r.exitCode, 0);
    // compare by name: on Windows the temp dir can come back as an 8.3 short path, the mapped root as the long one
    r = mapPath(fx.dir, { snapshots: { probes: [], covers: () => undefined }, cloud: { home, env: {}, run, dropboxIgnored: (p) => /[\\/]textures_sorted$/.test(p) } });
    f = Object.fromEntries(r.findings.map((x) => [x.path, x]));
    assert.equal(f["textures_sorted/"].zone, "VE");
    assert.match(f["textures_sorted/"].why, /Dropbox skips it \(ignore attribute set\)/);
    assert.equal(f["textures_sorted/"].cloud?.status, "gap");
    assert.equal(f[".env"].zone, "AE");
  } finally {
    fx.cleanup();
  }
});

test("map: a .dropbox marker with no running client keeps everything in Zone VE and says so (CLI)", async () => {
  const fx = materialize("textures-app");
  try {
    writeFileSync(join(fx.base, ".dropbox"), "");
    const { spawnSync } = await import("node:child_process");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
    const home = join(fx.base, "home");
    mkdirSync(home);
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), fx.dir, "--fix"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "", HOME: home, USERPROFILE: home, APPDATA: "", LOCALAPPDATA: "" },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /across 5 places your agent can erase forever/);
    assert.match(r.stdout, /textures_sorted\/\s+gitignored · possible Dropbox versioning, unverified · 2 files/);
    assert.match(r.stdout, /fix ignored on purpose, so don't commit it: keep a copy outside the tree · possible Dropbox versioning, unverified\n\s+\$ mkdir -p -m 700 ~\/\.undomap-safe && tar -czf /);
    assert.match(r.stdout, /cloud sync \? Dropbox .* possible cloud versioning, unverified \(\.dropbox marker but no client config, may be a stale copy\)/);
    assert.match(r.stdout, /cloud sync  Dropbox may keep versions of all 5 places above, but undomap can't confirm it \(\.dropbox marker but no client config, may be a stale copy\)\n\s+→ if Dropbox really syncs this folder, start its app and rerun undomap; if not, nothing versions it/);
  } finally {
    fx.cleanup();
  }
});

test("text report: one 'cloud sync' line per unverified folder with the cheapest check; verified folders need none", async () => {
  const { formatText } = await import("../src/format.ts");
  const probes = [{ name: "cloud sync", status: "unknown" as const, detail: "OneDrive ~/OneDrive · possible cloud versioning, unverified (OneDrive app not running)", counts: true }];
  const r = grade(
    inv(
      [
        { path: "thesis/", bytes: 9000, files: 3, git: "none", cloud: cov("unverified", "OneDrive app not running", "OneDrive") },
        { path: "notes.md", bytes: 900, files: 1, git: "none", cloud: cov("unverified", "OneDrive app not running", "OneDrive") },
        { path: "pics/", bytes: 90, files: 1, git: "none", cloud: cov("covered", "version history", "OneDrive") },
      ],
      probes,
    ),
  );
  const t = formatText(r, { color: false, platform: "win32" });
  assert.match(t, /thesis\/\s+outside any git repo · possible OneDrive versioning, unverified · 3 files/);
  assert.match(t, /cloud sync \? OneDrive ~\/OneDrive · possible cloud versioning, unverified \(OneDrive app not running\)/);
  assert.match(t, /\n  cloud sync  OneDrive may keep versions of both places above, but undomap can't confirm it \(OneDrive app not running\)\n    → start OneDrive, let it finish syncing, then rerun undomap/);
  assert.match(t, /ZONE AE · SLOW UNDO .*\n.*pics\/\s+outside any git repo; in OneDrive \(version history\)/);
  assert.equal((t.match(/cloud sync  /g) ?? []).length, 1);
  // the whole-map snapshot advice still shows: a sync folder is not a machine snapshot
  assert.match(t, /whole map  turn on File History/);
});

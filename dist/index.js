// src/run.ts
import { realpathSync as realpathSync4, statSync as statSync3 } from "node:fs";
import { resolve as resolve2 } from "node:path";

// src/collect.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { accessSync, closeSync, constants, existsSync as existsSync3, lstatSync, openSync, readSync, readdirSync as readdirSync3, realpathSync as realpathSync3, statSync as statSync2 } from "node:fs";
import { basename, dirname, join as join2, relative, resolve, sep as sep2 } from "node:path";

// src/patterns.ts
var REGEN_DIRS = [
  [["node_modules", "bower_components", ".pnpm-store", ".yarn/cache"], "npm / pnpm / yarn install"],
  [[".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".angular", ".expo", ".docusaurus", "storybook-static", ".vercel/output"], "the next dev or build run"],
  [["dist", "build", "_build"], "your build script"],
  [["target"], "cargo build / mvn package"],
  [["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".ipynb_checkpoints"], "the next run"],
  [[".venv", "venv"], "uv sync / pip install"],
  [["vendor"], "go mod vendor / composer / bundle install"],
  [["coverage", ".nyc_output", "htmlcov"], "rerun the tests"],
  [[".gradle", ".dart_tool", "Pods", "DerivedData", ".build", ".terraform", ".cache", ".serverless"], "the toolchain"]
];
var REGEN_FILES = [
  [/\.(pyc|pyo|o|obj|class|tsbuildinfo)$/i, "the compiler"],
  [/^(\.eslintcache|\.DS_Store|Thumbs\.db|\.stylelintcache)$/, "automatic"]
];
var SECRET_FILE = [
  /^\.env(\..+)?$/i,
  // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|age)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^(credentials|service[-_]?account|client[-_]?secret)[\w.-]*\.json$/i,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/i,
  /^secrets?\.(ya?ml|json|toml|env)$/i
];
var SECRET_DIR = /^(secrets?|\.secrets|credentials|keys|\.ssh|\.gnupg|\.aws)$/i;
var NOT_SECRET = /^\.env\.(example|sample|template|dist|defaults)$/i;
var CRITICAL = [
  [/\.tfstate(\.backup)?$/i, "Terraform state: losing it orphans real infrastructure"],
  [/\.(sqlite3?|db|duckdb|mdb)$/i, "local database"],
  [/\.(ipynb)$/i, "notebook with outputs"],
  [/\.(psd|blend|kra|aep|prproj|drp|fcpbundle|logicx|als)$/i, "project file: hours of work"]
];
var base = (p) => {
  const t = p.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
};
function regenerable(path) {
  const isDir = path.endsWith("/");
  const trimmed = path.replace(/\/+$/, "");
  const segs = trimmed.split("/");
  const name = segs[segs.length - 1];
  const parents = segs.slice(0, -1);
  for (const [names, how] of REGEN_DIRS) {
    for (const n of names) {
      if (n.includes("/")) {
        if (trimmed === n || trimmed.endsWith("/" + n) || trimmed.includes(n + "/")) return how;
      } else if (isDir && name === n || parents.includes(n)) return how;
    }
  }
  if (!isDir) {
    for (const [re, how] of REGEN_FILES) if (re.test(name)) return how;
  }
  return void 0;
}
function isSecret(path) {
  const name = base(path);
  if (NOT_SECRET.test(name)) return false;
  if (path.endsWith("/")) return SECRET_DIR.test(name);
  return SECRET_FILE.some((re) => re.test(name));
}
function critical(path) {
  const name = base(path);
  for (const [re, why] of CRITICAL) if (re.test(name)) return why;
  return void 0;
}
function globMatcher(pattern) {
  const p = pattern.trim().replace(/^\.\//, "");
  if (!p) return () => false;
  if (p.endsWith("/")) {
    const anchored = p.slice(0, -1).includes("/");
    return (path) => path === p || path.startsWith(p) || !anchored && ("/" + path).includes("/" + p);
  }
  const re = new RegExp(
    "^" + p.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$"
  );
  const rel = p.includes("/");
  return (path) => re.test(rel ? path.replace(/\/+$/, "") : base(path));
}
function globMatch(pattern, path) {
  return globMatcher(pattern)(path);
}

// src/snapshots.ts
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
var defaultRun = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8e3, windowsHide: true });
    return { ok: r.status === 0, out: (r.stdout || "") + (r.status === 0 ? "" : r.stderr || "") };
  } catch {
    return { ok: false, out: "" };
  }
};
var count = (dir) => {
  try {
    return readdirSync(dir).length;
  } catch {
    return -1;
  }
};
var under = (abs, prefix) => abs === prefix || abs.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
function probeSnapshots(rootAbs, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? (process.env.HOME || process.env.USERPROFILE || "");
  const run = opts.run ?? defaultRun;
  const mode = opts.mode ?? process.env.UNDOMAP_SNAPSHOTS ?? "";
  const probes = [];
  if (mode === "off") {
    probes.push({ name: "snapshots", status: "unknown", detail: "not probed (--no-probe)", counts: true });
    return { probes, covers: () => void 0 };
  }
  if (mode.startsWith("fake:")) {
    const rest = mode.slice(5);
    const i = rest.indexOf(":");
    const label2 = i < 0 ? rest : rest.slice(0, i);
    const raw = i < 0 ? "" : rest.slice(i + 1);
    const prefix = raw && existsSync(raw) ? realpathSync.native(raw) : raw;
    probes.push({ name: "snapshots", status: "ok", detail: `${label2} (test hook)`, counts: true });
    return { probes, covers: (abs) => prefix && under(abs, prefix) ? label2 : void 0 };
  }
  let covers = () => void 0;
  if (platform === "darwin") {
    const dest = run("tmutil", ["destinationinfo"]);
    const local = run("tmutil", ["listlocalsnapshots", "/"]);
    if (!dest.ok && !local.ok && !dest.out && !local.out) {
      probes.push({ name: "time machine", status: "unknown", detail: "tmutil not available", counts: true });
    } else {
      const hasDest = dest.ok && /Name\s*:/i.test(dest.out);
      const n = local.ok ? (local.out.match(/com\.apple\.TimeMachine\./g) ?? []).length : 0;
      if (hasDest || n > 0) {
        const label2 = n > 0 ? `Time Machine (${n} local snapshot${n === 1 ? "" : "s"})` : "Time Machine backups";
        probes.push({ name: "time machine", status: "ok", detail: label2, counts: true });
        const cache = /* @__PURE__ */ new Map();
        let calls = 0;
        covers = (abs) => {
          let excluded = cache.get(abs);
          if (excluded === void 0) {
            excluded = calls++ < 60 ? /\[Excluded\]/i.test(run("tmutil", ["isexcluded", abs]).out) : false;
            cache.set(abs, excluded);
          }
          return excluded ? void 0 : label2;
        };
      } else probes.push({ name: "time machine", status: "absent", detail: "no Time Machine destination, no local snapshots", counts: true });
    }
    probes.push(trashProbe(join(home, ".Trash"), "Trash"));
  } else if (platform === "linux") {
    const fm = run("findmnt", ["-n", "-o", "TARGET,FSTYPE", "-T", rootAbs]);
    const m = fm.ok ? /^(\S+)\s+(\S+)/.exec(fm.out.trim()) : null;
    if (!m) probes.push({ name: "snapshots", status: "unknown", detail: "findmnt not available", counts: true });
    else {
      const [, mount, fstype] = m;
      const snapper = fstype === "btrfs" ? count(join(mount, ".snapshots")) : -1;
      const zfs = fstype === "zfs" ? count(join(mount, ".zfs", "snapshot")) : -1;
      const ts = Math.max(count("/timeshift/snapshots"), count("/run/timeshift/backup/timeshift/snapshots"));
      if (snapper > 0 || zfs > 0) {
        const label2 = snapper > 0 ? `snapper (${snapper} btrfs snapshots of ${mount})` : `ZFS (${zfs} snapshots of ${mount})`;
        probes.push({ name: "snapshots", status: "ok", detail: label2, counts: true });
        covers = (abs) => under(abs, mount) ? label2 : void 0;
      } else if (ts > 0 && !under(rootAbs, "/home") && !under(rootAbs, "/root")) {
        const label2 = `Timeshift (${ts} snapshots)`;
        probes.push({ name: "snapshots", status: "ok", detail: label2, counts: true });
        covers = (abs) => under(abs, "/home") || under(abs, "/root") ? void 0 : label2;
      } else {
        const why = ts > 0 ? "Timeshift skips /home by default" : `no btrfs/ZFS/Timeshift snapshots on ${mount} (${fstype})`;
        probes.push({ name: "snapshots", status: "absent", detail: why, counts: true });
      }
    }
    probes.push(trashProbe(join(home, ".local", "share", "Trash"), "Trash"));
  } else if (platform === "win32") {
    probes.push({ name: "shadow copies", status: "unknown", detail: "VSS needs an admin shell to list (vssadmin list shadows)", counts: true });
    probes.push({ name: "recycle bin", status: "ok", detail: "present; rm, del and fs.rm skip it", counts: false });
  } else {
    probes.push({ name: "snapshots", status: "unknown", detail: `no probe for ${platform}`, counts: true });
  }
  return { probes, covers };
}
function trashProbe(dir, name) {
  return existsSync(dir) ? { name: name.toLowerCase(), status: "ok", detail: "present; rm, rimraf and fs.rm skip it", counts: false } : { name: name.toLowerCase(), status: "absent", detail: "no trash folder", counts: false };
}

// src/cloud.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync, realpathSync as realpathSync2, statSync } from "node:fs";
import { posix, win32 } from "node:path";
var defaultRun2 = (cmd, args) => {
  try {
    const r = spawnSync2(cmd, args, { encoding: "utf8", timeout: 5e3, windowsHide: true, maxBuffer: 8 << 20 });
    if (r.error) return { ok: false, out: "" };
    return { ok: r.status === 0, out: (r.stdout || "") + (r.status === 0 ? "" : r.stderr || "") };
  } catch {
    return { ok: false, out: "" };
  }
};
var realFs = {
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return void 0;
    }
  },
  list: (p) => {
    try {
      return readdirSync2(p);
    } catch {
      return [];
    }
  },
  real: (p) => {
    try {
      return existsSync2(p) ? realpathSync2.native(p) : p;
    } catch {
      return p;
    }
  }
};
var GB = 1024 ** 3;
var FILE_LIMIT = {
  "iCloud Drive": [50 * GB, "50 GB"],
  OneDrive: [250 * GB, "250 GB"],
  "Google Drive": [5 * 1024 * GB, "5 TB"]
};
var HISTORY = {
  Dropbox: "version history and deleted files, 30+ days by plan",
  OneDrive: "version history and recycle bin, 30 days (93 for work accounts)",
  "Google Drive": "file versions for 30 days or 100 versions, trash for 30 days",
  "iCloud Drive": "Recently Deleted keeps deleted files 30 days, but an overwrite keeps no older version"
};
var PROCESS = {
  darwin: { Dropbox: ["Dropbox"], OneDrive: ["OneDrive"], "Google Drive": ["Google Drive"] },
  win32: { Dropbox: ["Dropbox.exe"], OneDrive: ["OneDrive.exe"], "Google Drive": ["GoogleDriveFS.exe"] },
  linux: { Dropbox: ["dropbox"] }
};
function skippedName(provider, name) {
  const n = name.toLowerCase();
  if (provider === "iCloud Drive") {
    if (n.endsWith(".nosync")) return ".nosync item";
    if (n.endsWith(".tmp")) return ".tmp item";
    return void 0;
  }
  const system = ["desktop.ini", "thumbs.db", ".ds_store"];
  if (provider === "Dropbox") {
    if ([...system, "icon\r", ".dropbox", ".dropbox.attr"].includes(n)) return "system file";
    if (n.startsWith("~$") || n.startsWith(".~") || n.startsWith("~") && n.endsWith(".tmp")) return "temporary file";
    return void 0;
  }
  if (provider === "OneDrive") {
    if (system.includes(n) || n.endsWith(".tmp")) return "temp or system file";
    if (n.startsWith("~$") || n.includes("_vti_") || n === ".lock" || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/.test(n)) return "refused name";
    if (/["*:<>?|]/.test(name) || /^\s|\s$/.test(name)) return "refused characters";
    return void 0;
  }
  if (system.includes(n) || n.endsWith(".tmp") || n.startsWith("~$")) return "temp or system file";
  return void 0;
}
function probeCloud(rootAbs, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? env.UNDOMAP_CLOUD ?? "";
  if (mode === "off") return { probes: [], check: () => void 0 };
  const fs = opts.fs ?? realFs;
  const run = opts.run ?? defaultRun2;
  const P = platform === "win32" ? win32 : posix;
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const fold = platform === "win32" || platform === "darwin";
  const norm = (p) => fold ? p.toLowerCase() : p;
  const under2 = (abs, prefix) => {
    const a = norm(abs);
    const p = norm(prefix).replace(/[\\/]+$/, "");
    return a === p || a.startsWith(p + P.sep);
  };
  const tilde2 = (p) => home && under2(p, home) ? "~" + p.slice(home.length) : p;
  const found = [];
  const add = (provider, root, strong, source) => {
    if (!root || !fs.isDir(root)) return;
    const r = fs.real(root);
    const same = found.find((c) => norm(c.root) === norm(r));
    if (same) {
      if (strong && !same.strong) Object.assign(same, { strong, source, provider });
      return;
    }
    found.push({ provider, root: r, strong, source });
  };
  const infoFiles = [home && P.join(home, ".dropbox", "info.json"), env.APPDATA && P.join(env.APPDATA, "Dropbox", "info.json"), env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, "Dropbox", "info.json")];
  for (const f of infoFiles) {
    if (!f) continue;
    const raw = fs.read(f);
    if (!raw) continue;
    try {
      for (const acct of Object.values(JSON.parse(raw)))
        if (acct && typeof acct.path === "string") add("Dropbox", acct.path, true, "Dropbox info.json");
    } catch {
    }
  }
  if (platform === "win32")
    for (const k of ["OneDriveCommercial", "OneDriveConsumer", "OneDrive"]) add("OneDrive", env[k], true, `%${k}%`);
  if (home) {
    if (platform === "darwin") {
      add("iCloud Drive", P.join(home, "Library", "Mobile Documents"), true, "iCloud Drive");
      const cs = P.join(home, "Library", "CloudStorage");
      for (const n of fs.list(cs)) {
        if (/^OneDrive/i.test(n)) add("OneDrive", P.join(cs, n), true, "~/Library/CloudStorage");
        else if (/^GoogleDrive-/i.test(n)) add("Google Drive", P.join(cs, n), true, "~/Library/CloudStorage");
        else if (/^Dropbox/i.test(n)) add("Dropbox", P.join(cs, n), false, "~/Library/CloudStorage");
      }
    }
    if (platform === "win32") add("iCloud Drive", P.join(home, "iCloudDrive"), true, "iCloud for Windows");
    for (const n of fs.list(home)) {
      if (/^OneDrive\b/i.test(n)) add("OneDrive", P.join(home, n), false, "folder name");
      else if (/^Dropbox\b/i.test(n)) add("Dropbox", P.join(home, n), false, "folder name");
      else if (/^Google Drive$/i.test(n)) add("Google Drive", P.join(home, n), false, "folder name (legacy Backup and Sync)");
    }
  }
  const gd = /^([A-Za-z]:\\)My Drive(\\|$)/i.exec(platform === "win32" ? rootAbs : "");
  if (gd) add("Google Drive", gd[1] + "My Drive", fs.isDir(gd[1] + ".shortcut-targets-by-id"), "virtual drive");
  for (let d = rootAbs; ; d = P.dirname(d)) {
    if (fs.isFile(P.join(d, ".dropbox")) || fs.isDir(P.join(d, ".dropbox.cache"))) add("Dropbox", d, false, ".dropbox marker");
    if (P.dirname(d) === d) break;
  }
  const roots = found.filter((c) => under2(rootAbs, c.root) || under2(c.root, rootAbs)).sort((a, b) => b.root.length - a.root.length);
  const probes = [];
  if (!roots.length) {
    probes.push({ name: "cloud sync", status: "absent", detail: "not in an iCloud Drive, Dropbox, OneDrive or Google Drive folder", counts: false });
    return { probes, check: () => void 0 };
  }
  let procs;
  const running = (provider) => {
    const names = PROCESS[platform]?.[provider];
    if (!names) return false;
    if (procs === void 0) {
      const r = platform === "win32" ? run("tasklist", ["/FO", "CSV", "/NH"]) : run("ps", ["-A", "-o", "comm="]);
      procs = r.ok ? new Set(
        r.out.split(/\r?\n/).map((l) => platform === "win32" ? /^"([^"]+)"/.exec(l)?.[1] ?? "" : l.trim().replace(/^.*\//, "")).filter(Boolean).map((s) => s.toLowerCase())
      ) : null;
    }
    if (procs === null) return void 0;
    return names.some((n) => procs.has(n.toLowerCase()));
  };
  for (const c of roots) {
    const where = `${c.provider} ${tilde2(c.root)}`;
    if (c.provider === "iCloud Drive") {
      c.status = "partial";
      probes.push({ name: "cloud sync", status: "ok", detail: `${where} \xB7 deletes recoverable 30 days, overwrites not versioned: not counted`, counts: false });
      continue;
    }
    const up = c.strong ? running(c.provider) : false;
    if (c.strong && up) {
      c.status = "covered";
      probes.push({ name: "cloud sync", status: "ok", detail: `${where} \xB7 client running \xB7 ${HISTORY[c.provider]}`, counts: true });
    } else {
      c.status = "unverified";
      c.why = !c.strong ? `${c.source} but no client config, may be a stale copy` : up === void 0 ? "couldn't list running apps" : `${c.provider} app not running`;
      probes.push({ name: "cloud sync", status: "unknown", detail: `${where} \xB7 possible cloud versioning, unverified (${c.why})`, counts: true });
    }
  }
  let lookups = 0;
  const attrCache = /* @__PURE__ */ new Map();
  const ignoredAttr = opts.dropboxIgnored ?? ((abs) => {
    if (platform === "win32") {
      try {
        statSync(abs + ":com.dropbox.ignored");
        return true;
      } catch (e) {
        return e.code === "ENOENT" ? false : void 0;
      }
    }
    if (platform === "darwin") {
      const r2 = run("xattr", [abs]);
      return r2.ok ? /^(com\.dropbox\.ignored|com\.apple\.fileprovider\.ignore#P)$/m.test(r2.out) : void 0;
    }
    const r = run("getfattr", ["--absolute-names", "-n", "user.com.dropbox.ignored", abs]);
    return r.ok ? true : /no such attribute|no data available/i.test(r.out) ? false : void 0;
  });
  const ignored = (abs) => {
    if (attrCache.has(abs)) return attrCache.get(abs);
    const v = lookups++ < 200 ? ignoredAttr(abs) : void 0;
    attrCache.set(abs, v);
    return v;
  };
  const rules = /* @__PURE__ */ new Map();
  const ignoreRules = (root) => {
    if (!rules.has(root)) {
      const text = fs.read(P.join(root, "rules.dropboxignore")) ?? "";
      const pats = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
      rules.set(root, pats.map((p) => globMatcher(p.replace(/^\//, ""))));
    }
    return rules.get(root);
  };
  return {
    probes,
    check(absIn, facts) {
      const abs = absIn.length > 1 ? absIn.replace(/(?<=[^\\/:])[\\/]+$/, "") : absIn;
      const c = roots.find((r) => under2(abs, r.root));
      if (!c) return void 0;
      const out = (status, note) => ({ provider: c.provider, status, note, root: c.root });
      const rel = abs.slice(c.root.length).split(/[\\/]+/).filter(Boolean);
      for (const seg of rel) {
        const skip = skippedName(c.provider, seg);
        if (skip) return out("gap", skip);
      }
      const limit = FILE_LIMIT[c.provider];
      if (limit) {
        const biggest = facts.dir ? facts.maxFile : facts.bytes;
        if (biggest !== void 0 && biggest > limit[0]) return out("gap", `a file over the ${limit[1]} limit`);
      }
      if (c.status === "partial") return out("partial", HISTORY[c.provider]);
      if (c.status !== "covered") return out("unverified", c.why ?? "unverified");
      if (c.provider === "Dropbox") {
        const relPosix = rel.join("/");
        const prefixes = rel.map((_, i) => rel.slice(0, i + 1).join("/") + (i < rel.length - 1 || facts.dir ? "/" : ""));
        if (relPosix && ignoreRules(c.root).some((m) => prefixes.some((p) => m(p)))) return out("gap", "matches rules.dropboxignore");
        for (let d = abs; under2(d, c.root) && norm(d) !== norm(c.root); d = P.dirname(d)) {
          const v = ignored(d);
          if (v === true) return out("gap", "ignore attribute set");
          if (v === void 0) return out("unverified", platform === "linux" ? "can't read the Dropbox ignore attribute (install attr for getfattr)" : "can't read the Dropbox ignore attribute");
        }
      }
      if (facts.capped && limit) return out("unverified", "too big to check every file against the size limit");
      return out("covered", HISTORY[c.provider]);
    }
  };
}

// src/collect.ts
var UsageError = class extends Error {
};
function git(cwd, args) {
  const r = spawnSync3("git", ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
  });
  if (r.error) return { ok: false, out: "", err: r.error.message };
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}
function gitVersion() {
  const r = git(process.cwd(), ["--version"]);
  return r.ok ? /(\d+\.\d+(\.\d+)?)/.exec(r.out)?.[1] ?? r.out.trim() : null;
}
function dirMarker(abs) {
  if (existsSync3(join2(abs, "pyvenv.cfg"))) return "Python venv: uv sync / pip install";
  if (existsSync3(join2(abs, "CACHEDIR.TAG"))) return "cache, CACHEDIR.TAG";
  return void 0;
}
function binaryMarker(abs, size) {
  if (size < 64) return void 0;
  let fd = -1;
  try {
    fd = openSync(abs, "r");
    const b = Buffer.alloc(4);
    readSync(fd, b, 0, 4, 0);
    const hex = b.toString("hex");
    if (hex === "7f454c46") return "compiled ELF binary: rebuild";
    if (["cffaedfe", "feedfacf", "cefaedfe", "feedface", "cafebabe"].includes(hex)) return "compiled Mach-O binary: rebuild";
    if (hex.startsWith("4d5a") && /\.(exe|dll)$/i.test(abs)) return "compiled PE binary: rebuild";
  } catch {
  } finally {
    if (fd >= 0) closeSync(fd);
  }
  return void 0;
}
function writable(abs) {
  for (const p of [abs, dirname(abs)]) {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
    }
  }
  return false;
}
function collect(rootInput, opts = {}) {
  const t0 = Date.now();
  const cap2 = opts.cap ?? 25e4;
  let st;
  try {
    st = statSync2(rootInput);
  } catch {
    throw new UsageError(`no such directory: ${rootInput}`);
  }
  if (!st.isDirectory()) throw new UsageError(`undomap maps directories; ${rootInput} is a file. Try: undomap ${JSON.stringify(resolve(rootInput, ".."))}`);
  const root = realpathSync3.native(resolve(rootInput));
  const entries = [];
  const absOf = /* @__PURE__ */ new Map();
  const repos = [];
  const skipped = [];
  const seen = /* @__PURE__ */ new Set();
  let fileCount = 0;
  let lastTick = 0;
  const tick = (n = 1) => {
    fileCount += n;
    if (opts.onProgress && fileCount - lastTick >= 5e3) {
      lastTick = fileCount;
      opts.onProgress(fileCount);
    }
  };
  const permanent = (opts.config?.permanent ?? []).map((g) => [g, globMatcher(g)]);
  const userRegen = (opts.config?.regenerable ?? []).map((g) => globMatcher(g));
  const permanentOf = (path) => permanent.find(([, m]) => m(path))?.[0];
  const rel = (abs, dir = false) => {
    const r = relative(root, abs).split(sep2).join("/");
    return dir ? r ? r + "/" : "./" : r;
  };
  const inside = (abs) => abs === root || abs.startsWith(root.endsWith(sep2) ? root : root + sep2);
  const push = (e, abs) => {
    entries.push(e);
    absOf.set(e, abs);
  };
  const realTarget = (abs) => {
    try {
      return realpathSync3.native(abs);
    } catch {
      return null;
    }
  };
  const sizeTree = (start, followEscapes, carve) => {
    const out = { bytes: 0, files: 0, maxFile: 0, capped: false, nested: [], links: [], carved: [] };
    const stack = [start];
    let seenHere = 0;
    while (stack.length) {
      const dir = stack.pop();
      let ents;
      try {
        ents = readdirSync3(dir, { withFileTypes: true });
      } catch (e) {
        skipped.push({ path: rel(dir, true), reason: e.code ?? "unreadable" });
        continue;
      }
      if (dir !== start && ents.some((d) => d.name === ".git")) {
        out.nested.push(dir);
        continue;
      }
      for (const d of ents) {
        if (d.name === ".git" && dir === start) continue;
        const p = join2(dir, d.name);
        if (++seenHere > cap2) {
          out.capped = true;
          stack.length = 0;
          break;
        }
        if (carve && !d.isSymbolicLink()) {
          const path = carve(p, d.isDirectory());
          if (path) {
            out.carved.push({ abs: p, path, dir: d.isDirectory() });
            continue;
          }
        }
        if (d.isDirectory()) stack.push(p);
        else if (d.isSymbolicLink()) {
          out.files++;
          tick();
          if (followEscapes) {
            const t = realTarget(p);
            if (t && !inside(t) && writable(t)) out.links.push({ abs: p, target: t });
          }
        } else {
          try {
            const size = lstatSync(p).size;
            out.bytes += size;
            if (size > out.maxFile) out.maxFile = size;
            out.files++;
            tick();
          } catch {
          }
        }
      }
    }
    return out;
  };
  const escapeEntry = (linkAbs, target, repo) => {
    let s = { bytes: 0, files: 0, maxFile: 0, capped: false, nested: [], links: [], carved: [] };
    try {
      const size = statSync2(target).size;
      s = statSync2(target).isDirectory() ? sizeTree(target, false) : { ...s, bytes: size, maxFile: size, files: 1 };
    } catch {
    }
    push({ path: rel(linkAbs), bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "none", target, repo }, target);
  };
  const sizedEntry = (abs, path, state, repo) => {
    const named = regenerable(path);
    const marker = named ? void 0 : dirMarker(abs);
    const forced = permanentOf(path);
    const looksRegen = !!(named || marker || userRegen.some((m) => m(path)));
    const carve = looksRegen && !forced && permanent.length ? (a, dir) => {
      const r = rel(a, dir);
      return permanentOf(r) ? r : void 0;
    } : void 0;
    const s = sizeTree(abs, !!forced || !named && !marker, carve);
    push({ path, bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: state, repo, regen: marker, permanent: forced }, abs);
    for (const l of s.links) escapeEntry(l.abs, l.target, repo);
    for (const n of s.nested) scanDir(n);
    for (const c of s.carved) (c.dir ? sizedEntry : fileEntry)(c.abs, c.path, state, repo);
  };
  const fileEntry = (abs, path, state, repo) => {
    try {
      const ls = lstatSync(abs);
      if (ls.isSymbolicLink()) {
        const t = realTarget(abs);
        if (t && !inside(t) && writable(t)) return escapeEntry(abs, t, repo);
      }
      tick();
      push({ path, bytes: ls.size, files: 1, maxFile: ls.size, git: state, repo, regen: ls.isFile() ? binaryMarker(abs, ls.size) : void 0, permanent: permanentOf(path) }, abs);
    } catch {
    }
  };
  const gitOk = gitVersion() !== null;
  const scanRepo = (top, pathspec) => {
    if (seen.has(top)) return;
    seen.add(top);
    const repo = inside(top) ? rel(top) : "";
    const spec = ["--", pathspec ? pathspec.split(sep2).join("/") : "."];
    const status = git(top, ["status", "--porcelain=v2", "-z", "--ignored=traditional", "--untracked-files=normal", ...spec]);
    if (!status.ok) {
      const why = /dubious ownership/i.test(status.err) ? `git refused: dubious ownership (git config --global --add safe.directory ${top})` : status.err.split("\n")[0] || "git status failed";
      skipped.push({ path: rel(top, true), reason: why });
      return;
    }
    const tok = status.out.split("\0");
    const dirty = /* @__PURE__ */ new Set();
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (!t) continue;
      const kind = t[0];
      if (kind === "?" || kind === "!") {
        const p = t.slice(2);
        const abs = join2(top, p);
        const state = kind === "?" ? "untracked" : "ignored";
        if (p.endsWith("/")) {
          if (existsSync3(join2(abs, ".git"))) {
            scanDir(abs);
            continue;
          }
          sizedEntry(abs, rel(abs, true), state, repo);
        } else fileEntry(abs, rel(abs), state, repo);
      } else if (kind === "1" || kind === "2" || kind === "u") {
        const n = kind === "1" ? 8 : kind === "2" ? 9 : 10;
        const parts = t.split(" ");
        const xy = parts[1] ?? "..";
        const sub = parts[2] ?? "N...";
        const p = parts.slice(n).join(" ");
        if (kind === "2") i++;
        dirty.add(p);
        if (sub[0] === "S" || xy.includes("D")) continue;
        const abs = join2(top, p);
        try {
          const ls2 = lstatSync(abs);
          tick();
          push({ path: rel(abs), bytes: ls2.size, files: 1, git: "dirty", repo }, abs);
        } catch {
        }
      }
    }
    const ls = git(top, ["ls-files", "-s", "-z", ...spec]);
    let bytes = 0;
    let files = 0;
    for (const t of ls.out.split("\0")) {
      const tab = t.indexOf("	");
      if (tab < 0) continue;
      const mode = t.slice(0, 6);
      const p = t.slice(tab + 1);
      if (dirty.has(p)) continue;
      const abs = join2(top, p);
      if (mode === "160000") {
        if (existsSync3(join2(abs, ".git"))) scanDir(abs);
        continue;
      }
      try {
        const s = lstatSync(abs);
        if (mode === "120000" || s.isSymbolicLink()) {
          const target = realTarget(abs);
          if (target && !inside(target) && writable(target)) {
            escapeEntry(abs, target, repo);
            continue;
          }
        }
        bytes += s.size;
        files++;
        tick();
      } catch {
      }
    }
    const repoDir = repo ? repo + "/" : "./";
    push({ path: repoDir, bytes, files, git: "clean", aggregate: true, repo }, top);
    const remotes = git(top, ["remote"]).out.split(/\r?\n/).filter(Boolean);
    const hasHead = git(top, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
    const branch = git(top, ["branch", "--show-current"]).out.trim() || null;
    let unpushed = 0;
    if (hasHead && remotes.length) {
      unpushed = Number(git(top, ["rev-list", "--count", "--branches", "--not", "--remotes"]).out.trim()) || 0;
      if (unpushed > 0) push({ path: repoDir + ".git/", bytes: 0, files: 0, git: "clean", repoIssue: "unpushed", unpushed, repo }, top);
    }
    if (hasHead && !remotes.length) {
      const gdRaw = git(top, ["rev-parse", "--absolute-git-dir"]).out.trim();
      const gd = gdRaw ? realTarget(resolve(gdRaw)) ?? resolve(gdRaw) : "";
      const commits = Number(git(top, ["rev-list", "--count", "--all"]).out.trim()) || 0;
      const s = gd ? sizeTree(gd, false) : { bytes: 0, files: 0, maxFile: 0, capped: false };
      push({ path: repoDir + ".git/", bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "clean", repoIssue: "no-remote", unpushed: commits, repo }, gd || top);
    }
    repos.push({ path: repo || ".", remote: remotes[0] ?? null, unpushed, branch });
  };
  const walkPlain = (dir) => {
    let ents;
    try {
      ents = readdirSync3(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: rel(dir, true), reason: e.code ?? "unreadable" });
      return;
    }
    let looseBytes = 0;
    let looseFiles = 0;
    let looseMax = 0;
    for (const d of ents) {
      if (d.name === ".git") continue;
      const abs = join2(dir, d.name);
      if (d.isSymbolicLink()) {
        const t = realTarget(abs);
        if (t && !inside(t) && writable(t)) escapeEntry(abs, t);
        else looseFiles++;
      } else if (d.isDirectory()) {
        if (existsSync3(join2(abs, ".git"))) scanDir(abs);
        else sizedEntry(abs, rel(abs, true), "none", void 0);
      } else {
        try {
          const size = lstatSync(abs).size;
          looseBytes += size;
          if (size > looseMax) looseMax = size;
          looseFiles++;
          tick();
        } catch {
        }
      }
    }
    if (looseFiles) {
      const base2 = rel(dir, true);
      push({ path: (base2 === "./" ? "" : base2) + "*", bytes: looseBytes, files: looseFiles, maxFile: looseMax, git: "none" }, dir);
    }
  };
  const scanDir = (dir) => {
    if (gitOk && existsSync3(join2(dir, ".git"))) {
      const top = git(dir, ["rev-parse", "--show-toplevel"]);
      if (top.ok && top.out.trim()) {
        const t = realpathSync3.native(resolve(top.out.trim()));
        if (t === dir) return scanRepo(dir);
      }
    }
    walkPlain(dir);
  };
  if (gitOk) {
    const top = git(root, ["rev-parse", "--show-toplevel"]);
    const t = top.ok && top.out.trim() ? realpathSync3.native(resolve(top.out.trim())) : null;
    if (t && t !== root) {
      const sub = relative(t, root);
      const ignored = git(t, ["check-ignore", "-q", "--", sub.split(sep2).join("/") + "/"]).ok;
      if (ignored) {
        const s = sizeTree(root, true);
        push({ path: "./", bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "ignored" }, root);
        for (const l of s.links) escapeEntry(l.abs, l.target);
        for (const n of s.nested) scanDir(n);
      } else scanRepo(t, sub);
    } else if (t) scanRepo(t);
    else walkPlain(root);
  } else walkPlain(root);
  const platform = opts.platform ?? process.platform;
  const snap = opts.snapshots ?? probeSnapshots(root, { platform, mode: opts.noProbe ? "off" : void 0 });
  let cloud;
  try {
    cloud = probeCloud(root, { platform, ...opts.cloud, ...opts.noProbe ? { mode: "off" } : {} });
  } catch (e) {
    cloud = { probes: [{ name: "cloud sync", status: "unknown", detail: `probe failed: ${e.message}`, counts: true }], check: () => void 0 };
  }
  for (const e of entries) {
    const fragile = e.repoIssue === "no-remote" || e.target || !e.aggregate && !e.repoIssue && e.git !== "dirty" && e.git !== "clean" && (!!e.permanent || !e.regen && !regenerable(e.path));
    if (fragile) {
      const abs = absOf.get(e) ?? root;
      const label2 = snap.covers(abs);
      if (label2) e.snapshot = label2;
      else {
        const c = cloud.check(abs, { bytes: e.bytes, maxFile: e.maxFile, dir: e.path.endsWith("/") || e.path.endsWith("*"), capped: e.capped });
        if (c) e.cloud = c;
      }
    }
  }
  const gv = gitVersion();
  const probes = [
    gv ? { name: "git", status: "ok", detail: gv, counts: true } : { name: "git", status: "absent", detail: "git not found: every path is graded as outside git", counts: true },
    ...snap.probes,
    ...cloud.probes
  ];
  return {
    root,
    rootName: basename(root) || root,
    platform,
    scannedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    repos,
    probes,
    entries,
    skipped
  };
}

// src/config.ts
import { existsSync as existsSync4, readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function loadConfig(root, explicit) {
  const file = explicit ?? join3(root, ".undomap.json");
  if (!existsSync4(file)) {
    if (explicit) throw new UsageError(`config not found: ${explicit}`);
    return { config: {}, file: null };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync2(file, "utf8"));
  } catch (e) {
    throw new UsageError(`${file}: not valid JSON (${e.message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError(`${file}: expected an object like {"permanent": [], "regenerable": [], "backedUp": []}`);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "$schema") continue;
    if (k !== "regenerable" && k !== "backedUp" && k !== "permanent") throw new UsageError(`${file}: unknown key "${k}" (known: permanent, regenerable, backedUp)`);
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new UsageError(`${file}: "${k}" must be an array of path patterns`);
    out[k] = v;
  }
  return { config: out, file };
}

// src/fix.ts
var SMALL = 25 * 1024 * 1024;
var MEDIA_SMALL = 2 * 1024 * 1024;
var BINARY = /\.(mov|mp4|mkv|webm|avi|wav|flac|mp3|psd|blend|zip|tar|gz|tgz|7z|rar|iso|dmg|bin|onnx|safetensors|ckpt|pt|pth|gguf|sqlite|db|parquet)$/i;
var SAFE = "~/.undomap-safe";
var q = (p) => /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
var slug = (p) => p.replace(/\/+$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
var noSlash = (p) => p.replace(/\/+$/, "") || ".";
function fixFor(f, ctx) {
  const fix = baseFix(f, ctx);
  return fix && f.zone === "VE" && f.cloud ? { ...fix, say: cloudSay(f.cloud, fix.say) } : fix;
}
function cloudSay(c, say) {
  if (c.status === "unverified") return `${say} \xB7 possible ${c.provider} versioning, unverified`;
  if (c.status === "partial") return `${say} \xB7 ${c.provider} only brings back deletes, not overwrites`;
  return `${say} \xB7 ${c.provider} skips it: ${c.note}`;
}
function cloudCheck(c) {
  if (/not running/.test(c.note)) return `start ${c.provider}, let it finish syncing, then rerun undomap`;
  if (/stale copy/.test(c.note)) return `if ${c.provider} really syncs this folder, start its app and rerun undomap; if not, nothing versions it`;
  if (/install attr/.test(c.note)) return "install attr (getfattr), then rerun undomap";
  return `check the ${c.provider} app shows these synced, then rerun undomap`;
}
function baseFix(f, ctx) {
  const p = noSlash(f.path);
  const name = `${slug(ctx.rootName)}-${slug(f.path)}`;
  switch (f.kind) {
    case "ignored":
    case "untracked":
    case "no-git": {
      if (f.secret)
        return {
          say: "keep a copy outside the tree (password manager or ~/.config)",
          run: `mkdir -p -m 700 ${SAFE} && cp -Rp ${q(p)} ${SAFE}/${q(name)}`,
          cost: "seconds"
        };
      const binary = f.bytes > MEDIA_SMALL && (BINARY.test(p) || f.path.endsWith("/") && f.bytes / Math.max(1, f.files) > 1024 * 1024);
      if (f.bytes > SMALL || f.capped || binary)
        return {
          say: ctx.snapshots ? `${binary && f.bytes <= SMALL ? "binary, keep it out of git" : "too big for git"}: copy it where the agent can't write (here, or better a disk, NAS or versioned bucket)` : `${binary && f.bytes <= SMALL ? "binary, keep it out of git" : "too big for git"}: copy it where the agent can't write, then snapshot that copy`,
          run: `mkdir -p -m 700 ${SAFE} && rsync -a ${q(p)}${f.path.endsWith("/") ? "/" : ""} ${SAFE}/${q(name)}/`,
          cost: "minutes"
        };
      if (f.kind === "untracked")
        return { say: "commit it, then git checkout brings it back", run: `git add -- ${q(p)} && git commit -m ${q(`track ${p}`)}`, cost: "seconds" };
      if (f.kind === "no-git")
        return f.path.endsWith("/") ? { say: "give it local history in one command", run: `git -C ${q(p)} init -q && git -C ${q(p)} add -A && git -C ${q(p)} commit -qm "undomap: baseline"`, cost: "seconds" } : { say: "copy it outside the agent's workspace", run: `mkdir -p -m 700 ${SAFE} && cp -p ${q(p)} ${SAFE}/`, cost: "seconds" };
      return {
        say: "ignored on purpose, so don't commit it: keep a copy outside the tree",
        run: `mkdir -p -m 700 ${SAFE} && tar -czf ${SAFE}/${q(name + ".tgz")} ${q(p)}`,
        cost: "seconds"
      };
    }
    case "symlink-escape":
      return {
        say: "the agent writes through this link: map the target too, or replace it with a copy",
        run: f.target ? `undomap ${q(f.target)}` : void 0,
        cost: "seconds"
      };
    case "no-remote":
      return {
        say: ".git is the only copy of the history: bundle it off-tree (or add a remote and push)",
        run: `git ${f.repo ? `-C ${q(f.repo)} ` : ""}bundle create ~/${q(slug(f.repo || ctx.rootName))}.bundle --all`,
        cost: "seconds"
      };
    case "unpushed":
      return { say: `${f.unpushed ?? "some"} commit${f.unpushed === 1 ? "" : "s"} exist only in this .git: push them`, run: `git ${f.repo ? `-C ${q(f.repo)} ` : ""}push --all`, cost: "seconds" };
    case "dirty":
      return { say: "uncommitted edits: checkpoint before the agent runs", run: `git stash push -u -m "before agent" && git stash apply   # or: agentckpt snap`, cost: "seconds" };
    default:
      return void 0;
  }
}
function snapshotFix(platform) {
  if (platform === "darwin") return { say: "turn on Time Machine: hourly local snapshots turn most of Zone VE into slow undo", run: "sudo tmutil enable   # then pick a backup disk in System Settings", cost: "setup" };
  if (platform === "win32") return { say: "turn on File History or System Protection (VSS) for this drive", run: "control /name Microsoft.FileHistory", cost: "setup" };
  return { say: "snapshot the workspace: btrfs/ZFS with snapper, or restic/borg on a timer", run: "sudo snapper -c home create-config /home   # btrfs example", cost: "setup" };
}

// src/version.ts
var VERSION = "0.1.0";

// src/grade.ts
var machineSnapshots = (probes) => probes.some((p) => p.counts && p.status === "ok" && p.name !== "git" && p.name !== "cloud sync");
var ZONE_ORDER = { VE: 0, AE: 1, X: 2 };
function classify(e, config = {}) {
  const base2 = { path: e.path, bytes: e.bytes, files: e.files, capped: !!e.capped, repo: e.repo, secret: false, target: e.target, unpushed: e.unpushed };
  const userRegen = (config.regenerable ?? []).some((g) => globMatch(g, e.path));
  const userBacked = (config.backedUp ?? []).some((g) => globMatch(g, e.path)) || e.backedUp;
  const c = e.cloud;
  const cloud = c ? { cloud: { provider: c.provider, status: c.status, note: c.note } } : {};
  const synced = c?.status === "covered";
  const cloudNote = !c || synced ? "" : c.status === "unverified" ? ` \xB7 possible ${c.provider} versioning, unverified` : c.status === "partial" ? ` \xB7 ${c.provider} keeps deletes 30 days, not overwrites` : ` \xB7 ${c.provider} skips it (${c.note})`;
  if (e.repoIssue === "no-remote") {
    if (userBacked) return { ...base2, zone: "AE", kind: "backed-up", why: "no remote, but backed up per .undomap.json" };
    if (e.snapshot) return { ...base2, zone: "AE", kind: "snapshot", why: `no remote; in ${e.snapshot}` };
    if (synced) return { ...base2, ...cloud, zone: "AE", kind: "cloud", why: `no remote; .git syncs to ${c.provider} (${c.note})` };
    return { ...base2, ...cloud, zone: "VE", kind: "no-remote", why: `repo with no remote: .git is the only copy of its history${cloudNote}` };
  }
  if (e.repoIssue === "unpushed") return { ...base2, zone: "AE", kind: "unpushed", why: `${e.unpushed} commit${e.unpushed === 1 ? "" : "s"} not on any remote` };
  if (e.aggregate) return { ...base2, zone: "X", kind: "tracked", why: "clean tracked files: git checkout / git restore" };
  if (e.git === "dirty") return { ...base2, zone: "AE", kind: "dirty", why: "tracked, uncommitted edits: last commit comes back, the edits don't" };
  if (e.target) {
    if (e.snapshot) return { ...base2, zone: "AE", kind: "snapshot", why: `link to ${e.target}; target in ${e.snapshot}` };
    if (synced) return { ...base2, ...cloud, zone: "AE", kind: "cloud", why: `link to ${e.target}; target syncs to ${c.provider} (${c.note})` };
    return { ...base2, ...cloud, zone: "VE", kind: "symlink-escape", why: `symlink out of the map \xB7 the agent writes through it${cloudNote}` };
  }
  const forcedBy = e.permanent ?? (config.permanent ?? []).find((g) => globMatch(g, e.path));
  const looked = userRegen ? "per your .undomap.json" : e.regen ?? regenerable(e.path);
  const gitWhat = e.git === "ignored" ? "gitignored \xB7 " : e.git === "untracked" ? "untracked \xB7 " : "";
  if (looked && !forcedBy) return { ...base2, zone: "AE", kind: "regenerable", why: `${gitWhat}regenerable (${looked})` };
  const secret = isSecret(e.path);
  const crit = critical(e.path);
  const what = e.git === "ignored" ? "gitignored" : e.git === "untracked" ? "untracked" : "outside any git repo";
  const kind = e.git === "ignored" ? "ignored" : e.git === "untracked" ? "untracked" : "no-git";
  const forced = forcedBy ? { forcedBy } : {};
  const marked = forcedBy ? ", marked permanent" : "";
  if (userBacked) return { ...base2, ...forced, secret, zone: "AE", kind: "backed-up", why: `${what}${marked}, but backed up per .undomap.json` };
  if (e.snapshot) return { ...base2, ...forced, secret, zone: "AE", kind: "snapshot", why: `${what}${marked}; restorable from ${e.snapshot}` };
  if (synced) return { ...base2, ...forced, ...cloud, secret, zone: "AE", kind: "cloud", why: `${what}${marked}; in ${c.provider} (${c.note})` };
  const extra = secret ? " \xB7 looks like secrets" : crit ? ` \xB7 ${crit}` : "";
  const note = !forcedBy ? "" : userRegen ? " \xB7 on both lists in .undomap.json: permanent wins over regenerable" : looked ? ` \xB7 looks regenerable (${looked}) but .undomap.json marks it permanent` : " \xB7 permanent per .undomap.json";
  return { ...base2, ...forced, ...cloud, secret, zone: "VE", kind, why: `${what}${extra}${note}${cloudNote}` };
}
function grade(inv, opts = {}) {
  const config = opts.config ?? {};
  const threshold = Math.max(0, opts.thresholdBytes ?? 0);
  const ctx = { platform: inv.platform, rootName: inv.rootName, snapshots: machineSnapshots(inv.probes) };
  const findings = [];
  for (const e of inv.entries) {
    if (e.bytes === 0 && e.files === 0 && !e.repoIssue) continue;
    const f = classify(e, config);
    const fix = fixFor(f, ctx);
    if (fix) f.fix = fix;
    findings.push(f);
  }
  findings.sort((a, b) => ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] || b.bytes - a.bytes || a.path.localeCompare(b.path));
  const totals = { VE: { bytes: 0, places: 0, files: 0 }, AE: { bytes: 0, places: 0, files: 0 }, X: { bytes: 0, places: 0, files: 0 } };
  for (const f of findings) {
    const t = totals[f.zone];
    t.bytes += f.bytes;
    t.files += f.files;
    t.places += f.zone === "X" ? 0 : 1;
  }
  totals.X.places = findings.filter((f) => f.zone === "X").length;
  return {
    tool: "undomap",
    version: VERSION,
    root: inv.root,
    scannedAt: inv.scannedAt,
    durationMs: inv.durationMs,
    repos: inv.repos,
    probes: inv.probes,
    totals,
    findings,
    skipped: inv.skipped,
    exitCode: totals.VE.places > 0 && totals.VE.bytes > threshold ? 1 : 0,
    thresholdBytes: threshold
  };
}

// src/run.ts
function mapPath(path, opts = {}) {
  let config = opts.config;
  if (!config) {
    let root;
    try {
      root = statSync3(path).isDirectory() ? realpathSync4.native(resolve2(path)) : void 0;
    } catch {
    }
    if (root) config = loadConfig(root, opts.configFile).config;
  }
  const inv = collect(path, { ...opts, config });
  config ??= loadConfig(inv.root, opts.configFile).config;
  return grade(inv, { thresholdBytes: opts.thresholdBytes, config });
}

// src/bytes.ts
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
function parseBytes(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgtp]?)(i?b)?\s*$/i.exec(s);
  if (!m) throw new Error(`not a size: "${s}" (try 0, 512KB, 10MB, 2GB)`);
  const pow = " kmgtp".indexOf((m[2] || " ").toLowerCase());
  return Math.round(Number(m[1]) * 1024 ** pow);
}
var plural = (n, one, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// src/format.ts
var ZONE_NAME = { VE: "PERMANENT", AE: "SLOW UNDO", X: "UNDOABLE" };
function palette(o) {
  const tc = o.truecolor;
  const c = (code) => (s) => o.color ? `\x1B[${code}m${s}\x1B[0m` : s;
  return {
    VE: c(tc ? "38;2;224;112;26" : "38;5;166"),
    AE: c(tc ? "38;2;201;164;58" : "38;5;178"),
    X: c(tc ? "38;2;42;157;149" : "38;5;36"),
    copper: c(tc ? "38;2;176;122;80" : "38;5;137"),
    bold: c("1"),
    dim: c("2"),
    under: c("4")
  };
}
var BLOCKS = ["", "\u258F", "\u258E", "\u258D", "\u258C", "\u258B", "\u258A", "\u2589"];
function bar(frac, width) {
  const eighths = Math.max(1, Math.round(Math.min(1, Math.max(0, frac)) * width * 8));
  const full = Math.floor(eighths / 8);
  return ("\u2588".repeat(full) + BLOCKS[eighths % 8]).padEnd(width, " ");
}
var tilde = (p, home) => home && (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\")) ? "~" + p.slice(home.length) : p;
var tildeRun = (run, home) => home && home !== "/" ? run.split(" " + home + "/").join(" ~/") : run;
var cut = (s, n) => s.length <= n ? s : "\u2026" + s.slice(s.length - n + 1);
function label(f, home) {
  if (f.kind === "symlink-escape") return `${f.path} \u2192 ${tilde(f.target ?? "?", home)}`;
  if (f.path === "*") return "./* (loose files)";
  if (f.path.startsWith("./")) return f.path.slice(2) || "./";
  return f.path;
}
function detail(f) {
  const bits = [f.why];
  if (f.kind === "no-remote") bits.push(plural(f.unpushed ?? 0, "commit"));
  else if (f.kind === "unpushed") return f.why;
  else if (f.files > 1 || f.path.endsWith("/") || f.path.endsWith("*")) bits.push(plural(f.files, "file") + (f.capped ? "+" : ""));
  return bits.join(" \xB7 ");
}
var cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
var amount = (f) => f.kind === "unpushed" ? "\u2014" : fmtBytes(f.bytes) + (f.capped ? "+" : "");
var fmtDuration = (ms) => ms < 1e3 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1e3).toFixed(1)} s`;
function formatText(r, o) {
  const k = palette(o);
  const width = Math.max(60, Math.min(o.width ?? 100, 140));
  const out = [];
  const ve = r.findings.filter((f) => f.zone === "VE");
  const ae = r.findings.filter((f) => f.zone === "AE");
  const x = r.findings.filter((f) => f.zone === "X");
  const files = r.findings.filter((f) => !f.path.endsWith(".git/")).reduce((n, f) => n + f.files, 0);
  out.push(
    `${k.bold("undomap")} ${k.dim(r.version)}  ${k.dim("\xB7")}  ${tilde(r.root, o.home)}  ${k.dim("\xB7")}  ${k.dim(
      `${plural(r.repos.length, "repo")} \xB7 ${plural(files, "file")} \xB7 ${fmtDuration(r.durationMs)}`
    )}`
  );
  out.push("");
  out.push(`${k.VE("\u25B2")} ${k.bold(k.VE("ZONE VE"))} ${k.dim("\xB7")} ${k.VE(ZONE_NAME.VE)}`);
  if (!ve.length) {
    out.push(`  ${k.bold("0 B")} \u2014 nothing here your agent can erase for good.`);
  } else {
    out.push(`  ${k.bold(k.VE(fmtBytes(r.totals.VE.bytes)))} ${k.bold(`across ${plural(r.totals.VE.places, "place")} your agent can erase forever`)}`);
    out.push("");
    const limit = o.limit ?? 12;
    const shown = ve.filter((f, i) => i < limit || f.secret);
    const max = ve[0].bytes || 1;
    const amtW = Math.max(...shown.map((f) => amount(f).length));
    const pathW = Math.min(Math.max(...shown.map((f) => label(f, o.home).length)), Math.floor(width * 0.42));
    for (const f of shown) {
      const lab = cut(label(f, o.home), pathW).padEnd(pathW);
      out.push(`  ${k.VE(amount(f).padStart(amtW))} ${k.VE(bar(f.bytes / max, 10))}  ${f.secret ? k.bold(lab) : lab}  ${k.dim(detail(f))}`);
      if (o.fix && f.fix) {
        const pad = " ".repeat(amtW + 15);
        out.push(`${pad}${k.copper("fix")} ${f.fix.say}`);
        if (f.fix.run) out.push(`${pad}${k.dim("  $")} ${tildeRun(f.fix.run, o.home)}`);
      }
    }
    if (shown.length < ve.length) out.push(k.dim(`  \u2026 and ${ve.length - shown.length} more (undomap --json for all)`));
  }
  out.push("");
  out.push(
    `${k.AE("\u25B2")} ${k.bold(k.AE("ZONE AE"))} ${k.dim("\xB7")} ${k.AE(ZONE_NAME.AE)}   ${ae.length ? `${fmtBytes(r.totals.AE.bytes)} across ${plural(r.totals.AE.places, "place")} ${k.dim("\u2014 rebuild, restore or re-download")}` : k.dim("nothing")}`
  );
  const aeShow = ae.slice(0, 6);
  if (aeShow.length) {
    const amtW = Math.max(...aeShow.map((f) => amount(f).length));
    const pathW = Math.min(Math.max(...aeShow.map((f) => label(f, o.home).length)), Math.floor(width * 0.42));
    for (const f of aeShow) out.push(`  ${k.AE(amount(f).padStart(amtW))}  ${cut(label(f, o.home), pathW).padEnd(pathW)}  ${k.dim(detail(f))}`);
    if (ae.length > aeShow.length) out.push(k.dim(`  \u2026 and ${ae.length - aeShow.length} more`));
  }
  out.push("");
  out.push(
    `${k.X("\u25B2")} ${k.bold(k.X("ZONE X"))} ${k.dim("\xB7")} ${k.X(ZONE_NAME.X)}   ${x.length ? `${fmtBytes(r.totals.X.bytes)} \xB7 ${plural(r.totals.X.files, "tracked file")} ${k.dim("\u2014 git checkout / git restore")}` : k.dim("no clean tracked files")}`
  );
  if (x.length > 1) for (const f of x.slice(0, 5)) out.push(`  ${k.X(fmtBytes(f.bytes).padStart(8))}  ${f.path}  ${k.dim(plural(f.files, "file"))}`);
  out.push("");
  const probeBits = r.probes.filter((p) => p.counts || p.status === "ok").map((p) => {
    const mark = p.status === "ok" ? p.counts ? k.X("\u2713") : k.AE("~") : p.status === "absent" ? k.VE("\u2717") : k.dim("?");
    return `${p.name} ${mark} ${k.dim(p.detail)}`;
  });
  out.push(`  ${k.dim("probes")}  ${probeBits.join(k.dim("  \xB7  "))}`);
  if (r.skipped.length) out.push(`  ${k.dim("skipped")} ${r.skipped.length} unreadable: ${r.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join(", ")}${r.skipped.length > 3 ? ", \u2026" : ""}`);
  const snapOk = machineSnapshots(r.probes);
  if (ve.length && !o.fix) {
    const top = ve[0];
    out.push("");
    out.push(`  ${k.copper("fix first")}  ${k.bold(label(top, o.home))} \u2014 ${top.fix?.say ?? ""}`);
    if (top.fix?.run) out.push(`    ${k.dim("$")} ${tildeRun(top.fix.run, o.home)}`);
  }
  if (ve.length && !snapOk) {
    const s = snapshotFix(o.platform ?? process.platform);
    out.push("");
    out.push(`  ${k.copper("whole map")}  ${s.say}`);
    if (o.fix && s.run) out.push(`    ${k.dim("$")} ${s.run}`);
  }
  const unverified = /* @__PURE__ */ new Map();
  for (const f of ve)
    if (f.cloud?.status === "unverified") {
      const key = f.cloud.provider + "\0" + f.cloud.note;
      unverified.set(key, { c: f.cloud, n: (unverified.get(key)?.n ?? 0) + 1 });
    }
  for (const { c, n } of unverified.values()) {
    out.push("");
    out.push(`  ${k.copper("cloud sync")}  ${c.provider} may keep versions of ${n === ve.length ? n === 1 ? "the place" : n === 2 ? "both places" : `all ${n} places` : plural(n, "place")} above, but undomap can't confirm it (${c.note})`);
    out.push(`    ${k.dim("\u2192")} ${cloudCheck(c)}`);
  }
  if (ve.length && !o.fix) {
    out.push("");
    out.push(k.dim(`  undomap --fix for every place \xB7 --json for scripts \xB7 exit 1 = something in Zone VE`));
  }
  return out.join("\n");
}
function formatMarkdown(r) {
  const ve = r.findings.filter((f) => f.zone === "VE");
  const ae = r.findings.filter((f) => f.zone === "AE");
  const esc = (s) => s.replace(/\|/g, "\\|");
  const lines = [
    `### undomap \u2014 ${ve.length ? `${fmtBytes(r.totals.VE.bytes)} across ${plural(r.totals.VE.places, "place")} your agent can erase forever` : "nothing your agent can erase for good"}`,
    "",
    `\`${r.root}\` \xB7 ${plural(r.repos.length, "repo")} \xB7 undomap ${r.version}`,
    "",
    "| Zone | Bytes | Places |",
    "|---|---:|---:|",
    `| \u{1F7E7} **VE** permanent | ${fmtBytes(r.totals.VE.bytes)} | ${r.totals.VE.places} |`,
    `| \u{1F7E8} **AE** slow undo | ${fmtBytes(r.totals.AE.bytes)} | ${r.totals.AE.places} |`,
    `| \u{1F7E9} **X** undoable | ${fmtBytes(r.totals.X.bytes)} | ${plural(r.totals.X.files, "file")} |`
  ];
  if (ve.length) {
    lines.push("", "#### Zone VE \u2014 no way back", "", "| Bytes | Path | Why | Cheapest fix |", "|---:|---|---|---|");
    for (const f of ve.slice(0, 30))
      lines.push(`| ${amount(f)} | \`${esc(label(f))}\` | ${esc(detail(f))} | ${f.fix ? esc(cap(f.fix.say)) + (f.fix.run ? `<br>\`${esc(f.fix.run)}\`` : "") : ""} |`);
    if (ve.length > 30) lines.push(`| | \u2026 ${ve.length - 30} more | | |`);
  }
  if (ae.length) {
    lines.push("", "<details><summary>Zone AE \u2014 slow undo (" + ae.length + ")</summary>", "", "| Bytes | Path | Why |", "|---:|---|---|");
    for (const f of ae.slice(0, 30)) lines.push(`| ${amount(f)} | \`${esc(label(f))}\` | ${esc(detail(f))} |`);
    lines.push("", "</details>");
  }
  lines.push("", "Probes: " + r.probes.map((p) => `${p.name}: ${p.detail}`).join(" \xB7 "));
  return lines.join("\n");
}
function formatJson(r) {
  return JSON.stringify(r, null, 2);
}
export {
  UsageError,
  VERSION,
  classify,
  collect,
  fmtBytes,
  formatJson,
  formatMarkdown,
  formatText,
  globMatch,
  grade,
  isSecret,
  mapPath,
  parseBytes,
  probeSnapshots,
  regenerable
};

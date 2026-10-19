// Cloud-sync folders: iCloud Drive, Dropbox, OneDrive, Google Drive. A sync client copies a delete within seconds,
// so the real undo is the provider's version history and deleted-files bin. This module works out, read-only,
// whether that history really covers a path. It is conservative on purpose: only "covered" moves a path to Zone AE.
//   covered     a client config points at the folder, the client is running, and no known exclusion applies
//   unverified  looks like a sync folder, but undomap can't confirm it syncs (no client running, marker only, stale copy)
//   partial     the provider keeps deleted files but not older versions of overwritten ones (iCloud Drive)
//   gap         the provider skips this path (ignore attribute, temp/system names, size limits, ignore rules)
// Nothing here writes, and nothing here can fail the map: every probe degrades to "unverified".
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { globMatcher } from "./patterns.js";
import type { CloudCoverage, CloudProvider, Probe } from "./types.js";

type Run = (cmd: string, args: string[]) => { ok: boolean; out: string };
const defaultRun: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 << 20 });
    if (r.error) return { ok: false, out: "" };
    return { ok: r.status === 0, out: (r.stdout || "") + (r.status === 0 ? "" : r.stderr || "") };
  } catch {
    return { ok: false, out: "" };
  }
};

/** The read-only filesystem calls the probe makes; injectable so every case runs from fixtures. */
export interface CloudFs {
  isDir(p: string): boolean;
  isFile(p: string): boolean;
  read(p: string): string | undefined;
  list(p: string): string[];
  real(p: string): string;
}

const realFs: CloudFs = {
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
      return undefined;
    }
  },
  list: (p) => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  },
  real: (p) => {
    try {
      return existsSync(p) ? realpathSync.native(p) : p;
    } catch {
      return p;
    }
  },
};

export interface CloudOptions {
  platform?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  /** Runs `ps` / `tasklist` (which sync clients are running) and `xattr` / `getfattr` (Dropbox ignore markers). */
  run?: Run;
  fs?: CloudFs;
  /** Is this path marked "ignored" for Dropbox? true / false, or undefined when it can't be read. */
  dropboxIgnored?: (abs: string) => boolean | undefined;
  /** "off" skips the probe (also UNDOMAP_CLOUD=off and --no-probe). */
  mode?: string;
}

export interface EntryFacts {
  bytes: number;
  /** Largest single file inside (for per-file size limits). */
  maxFile?: number;
  dir: boolean;
  capped?: boolean;
}

export interface CloudInfo {
  probes: Probe[];
  check(abs: string, facts: EntryFacts): CloudCoverage | undefined;
}

interface SyncRoot {
  provider: CloudProvider;
  root: string;
  /** Strong evidence: the client's own config or a path only the client creates. */
  strong: boolean;
  source: string;
  status?: "covered" | "unverified" | "partial";
  why?: string;
}

const GB = 1024 ** 3;
/** Per-file limits the provider documents. Dropbox's desktop app has none that matter here. */
const FILE_LIMIT: Partial<Record<CloudProvider, [number, string]>> = {
  "iCloud Drive": [50 * GB, "50 GB"],
  OneDrive: [250 * GB, "250 GB"],
  "Google Drive": [5 * 1024 * GB, "5 TB"],
};

/** What the provider's own history keeps, for the reason text. */
export const HISTORY: Record<CloudProvider, string> = {
  Dropbox: "version history and deleted files, 30+ days by plan",
  OneDrive: "version history and recycle bin, 30 days (93 for work accounts)",
  "Google Drive": "file versions for 30 days or 100 versions, trash for 30 days",
  "iCloud Drive": "Recently Deleted keeps deleted files 30 days, but an overwrite keeps no older version",
};

const PROCESS: Record<string, Partial<Record<CloudProvider, string[]>>> = {
  darwin: { Dropbox: ["Dropbox"], OneDrive: ["OneDrive"], "Google Drive": ["Google Drive"] },
  win32: { Dropbox: ["Dropbox.exe"], OneDrive: ["OneDrive.exe"], "Google Drive": ["GoogleDriveFS.exe"] },
  linux: { Dropbox: ["dropbox"] },
};

/** Names a provider documents it won't sync. Checked on the path and every folder above it inside the sync root. */
function skippedName(provider: CloudProvider, name: string): string | undefined {
  const n = name.toLowerCase();
  if (provider === "iCloud Drive") {
    if (n.endsWith(".nosync")) return ".nosync item";
    if (n.endsWith(".tmp")) return ".tmp item";
    return undefined;
  }
  const system = ["desktop.ini", "thumbs.db", ".ds_store"];
  if (provider === "Dropbox") {
    if ([...system, "icon\r", ".dropbox", ".dropbox.attr"].includes(n)) return "system file";
    if (n.startsWith("~$") || n.startsWith(".~") || (n.startsWith("~") && n.endsWith(".tmp"))) return "temporary file";
    return undefined;
  }
  if (provider === "OneDrive") {
    if (system.includes(n) || n.endsWith(".tmp")) return "temp or system file";
    if (n.startsWith("~$") || n.includes("_vti_") || n === ".lock" || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/.test(n)) return "refused name";
    if (/["*:<>?|]/.test(name) || /^\s|\s$/.test(name)) return "refused characters";
    return undefined;
  }
  if (system.includes(n) || n.endsWith(".tmp") || n.startsWith("~$")) return "temp or system file";
  return undefined;
}

export function probeCloud(rootAbs: string, opts: CloudOptions = {}): CloudInfo {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? env.UNDOMAP_CLOUD ?? "";
  if (mode === "off") return { probes: [], check: () => undefined };
  const fs = opts.fs ?? realFs;
  const run = opts.run ?? defaultRun;
  const P = platform === "win32" ? win32 : posix;
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? "";
  const fold = platform === "win32" || platform === "darwin";
  const norm = (p: string) => (fold ? p.toLowerCase() : p);
  const under = (abs: string, prefix: string) => {
    const a = norm(abs);
    const p = norm(prefix).replace(/[\\/]+$/, "");
    return a === p || a.startsWith(p + P.sep);
  };
  const tilde = (p: string) => (home && under(p, home) ? "~" + p.slice(home.length) : p);

  // 1. Candidate sync roots. Strong = the client's own config, or a folder only the client creates.
  const found: SyncRoot[] = [];
  const add = (provider: CloudProvider, root: string | undefined, strong: boolean, source: string) => {
    if (!root || !fs.isDir(root)) return;
    const r = fs.real(root);
    const same = found.find((c) => norm(c.root) === norm(r));
    if (same) {
      if (strong && !same.strong) Object.assign(same, { strong, source, provider });
      return;
    }
    found.push({ provider, root: r, strong, source });
  };

  // Dropbox writes info.json with the path of every linked account.
  const infoFiles = [home && P.join(home, ".dropbox", "info.json"), env.APPDATA && P.join(env.APPDATA, "Dropbox", "info.json"), env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, "Dropbox", "info.json")];
  for (const f of infoFiles) {
    if (!f) continue;
    const raw = fs.read(f);
    if (!raw) continue;
    try {
      for (const acct of Object.values(JSON.parse(raw) as Record<string, { path?: unknown }>))
        if (acct && typeof acct.path === "string") add("Dropbox", acct.path, true, "Dropbox info.json");
    } catch {
      /* unreadable config: fall back to markers */
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
  // Drive for desktop's virtual drive: G:\My Drive (any letter).
  const gd = /^([A-Za-z]:\\)My Drive(\\|$)/i.exec(platform === "win32" ? rootAbs : "");
  if (gd) add("Google Drive", gd[1] + "My Drive", fs.isDir(gd[1] + ".shortcut-targets-by-id"), "virtual drive");
  // A .dropbox marker in the map's root or any folder above it.
  for (let d = rootAbs; ; d = P.dirname(d)) {
    if (fs.isFile(P.join(d, ".dropbox")) || fs.isDir(P.join(d, ".dropbox.cache"))) add("Dropbox", d, false, ".dropbox marker");
    if (P.dirname(d) === d) break;
  }

  // Only roots that touch the map matter.
  const roots = found.filter((c) => under(rootAbs, c.root) || under(c.root, rootAbs)).sort((a, b) => b.root.length - a.root.length);
  const probes: Probe[] = [];
  if (!roots.length) {
    probes.push({ name: "cloud sync", status: "absent", detail: "not in an iCloud Drive, Dropbox, OneDrive or Google Drive folder", counts: false });
    return { probes, check: () => undefined };
  }

  // 2. Is the client running? One process listing, only when a strong root needs it.
  let procs: Set<string> | null | undefined;
  const running = (provider: CloudProvider): boolean | undefined => {
    const names = PROCESS[platform]?.[provider];
    if (!names) return false;
    if (procs === undefined) {
      const r = platform === "win32" ? run("tasklist", ["/FO", "CSV", "/NH"]) : run("ps", ["-A", "-o", "comm="]);
      procs = r.ok
        ? new Set(
            r.out
              .split(/\r?\n/)
              .map((l) => (platform === "win32" ? (/^"([^"]+)"/.exec(l)?.[1] ?? "") : l.trim().replace(/^.*\//, "")))
              .filter(Boolean)
              .map((s) => s.toLowerCase()),
          )
        : null;
    }
    if (procs === null) return undefined;
    return names.some((n) => procs!.has(n.toLowerCase()));
  };

  for (const c of roots) {
    const where = `${c.provider} ${tilde(c.root)}`;
    if (c.provider === "iCloud Drive") {
      c.status = "partial";
      probes.push({ name: "cloud sync", status: "ok", detail: `${where} · deletes recoverable 30 days, overwrites not versioned: not counted`, counts: false });
      continue;
    }
    const up = c.strong ? running(c.provider) : false;
    if (c.strong && up) {
      c.status = "covered";
      probes.push({ name: "cloud sync", status: "ok", detail: `${where} · client running · ${HISTORY[c.provider]}`, counts: true });
    } else {
      c.status = "unverified";
      c.why = !c.strong ? `${c.source} but no client config, may be a stale copy` : up === undefined ? "couldn't list running apps" : `${c.provider} app not running`;
      probes.push({ name: "cloud sync", status: "unknown", detail: `${where} · possible cloud versioning, unverified (${c.why})`, counts: true });
    }
  }

  // 3. Dropbox ignore markers: xattr on macOS/Linux, an alternate data stream on Windows. Capped like tmutil.
  let lookups = 0;
  const attrCache = new Map<string, boolean | undefined>();
  const ignoredAttr =
    opts.dropboxIgnored ??
    ((abs: string): boolean | undefined => {
      if (platform === "win32") {
        try {
          statSync(abs + ":com.dropbox.ignored");
          return true;
        } catch (e) {
          return (e as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
        }
      }
      if (platform === "darwin") {
        const r = run("xattr", [abs]);
        return r.ok ? /^(com\.dropbox\.ignored|com\.apple\.fileprovider\.ignore#P)$/m.test(r.out) : undefined;
      }
      const r = run("getfattr", ["--absolute-names", "-n", "user.com.dropbox.ignored", abs]);
      return r.ok ? true : /no such attribute|no data available/i.test(r.out) ? false : undefined;
    });
  const ignored = (abs: string) => {
    if (attrCache.has(abs)) return attrCache.get(abs);
    const v = lookups++ < 200 ? ignoredAttr(abs) : undefined;
    attrCache.set(abs, v);
    return v;
  };
  const rules = new Map<string, ((rel: string) => boolean)[]>();
  const ignoreRules = (root: string) => {
    if (!rules.has(root)) {
      const text = fs.read(P.join(root, "rules.dropboxignore")) ?? "";
      // gitignore-style; negations are dropped, which can only over-report a gap.
      const pats = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
      rules.set(root, pats.map((p) => globMatcher(p.replace(/^\//, ""))));
    }
    return rules.get(root)!;
  };

  return {
    probes,
    check(absIn, facts) {
      const abs = absIn.length > 1 ? absIn.replace(/(?<=[^\\/:])[\\/]+$/, "") : absIn;
      const c = roots.find((r) => under(abs, r.root));
      if (!c) return undefined;
      const out = (status: CloudCoverage["status"], note: string): CloudCoverage => ({ provider: c.provider, status, note, root: c.root });
      const rel = abs.slice(c.root.length).split(/[\\/]+/).filter(Boolean);
      for (const seg of rel) {
        const skip = skippedName(c.provider, seg);
        if (skip) return out("gap", skip);
      }
      const limit = FILE_LIMIT[c.provider];
      if (limit) {
        const biggest = facts.dir ? facts.maxFile : facts.bytes;
        if (biggest !== undefined && biggest > limit[0]) return out("gap", `a file over the ${limit[1]} limit`);
      }
      if (c.status === "partial") return out("partial", HISTORY[c.provider]);
      if (c.status !== "covered") return out("unverified", c.why ?? "unverified");
      if (c.provider === "Dropbox") {
        const relPosix = rel.join("/");
        const prefixes = rel.map((_, i) => rel.slice(0, i + 1).join("/") + (i < rel.length - 1 || facts.dir ? "/" : ""));
        if (relPosix && ignoreRules(c.root).some((m) => prefixes.some((p) => m(p)))) return out("gap", "matches rules.dropboxignore");
        for (let d = abs; under(d, c.root) && norm(d) !== norm(c.root); d = P.dirname(d)) {
          const v = ignored(d);
          if (v === true) return out("gap", "ignore attribute set");
          if (v === undefined) return out("unverified", platform === "linux" ? "can't read the Dropbox ignore attribute (install attr for getfattr)" : "can't read the Dropbox ignore attribute");
        }
      }
      if (facts.capped && limit) return out("unverified", "too big to check every file against the size limit");
      return out("covered", HISTORY[c.provider]);
    },
  };
}

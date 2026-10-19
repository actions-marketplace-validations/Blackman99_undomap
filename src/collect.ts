// Filesystem + git -> Inventory. Read-only: git runs with GIT_OPTIONAL_LOCKS=0 so even the index stays untouched.
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { globMatcher, regenerable } from "./patterns.js";
import { probeSnapshots, type SnapshotInfo } from "./snapshots.js";
import { probeCloud, type CloudOptions } from "./cloud.js";
import type { Config, Inventory } from "./grade.js";
import type { GitState, Probe, RawEntry, Report } from "./types.js";

export class UsageError extends Error {}

export interface CollectOptions {
  /** Max filesystem entries sized per place before reporting a lower bound (default 250k). */
  cap?: number;
  onProgress?: (files: number) => void;
  /** Override snapshot probing (tests). */
  snapshots?: SnapshotInfo;
  noProbe?: boolean;
  platform?: string;
  /** `.undomap.json`: `permanent` patterns are carved out of regenerable folders while sizing. */
  config?: Config;
  /** Cloud-sync probe inputs (home, env, process runner, fs): tests inject fixtures here. */
  cloud?: CloudOptions;
}

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  if (r.error) return { ok: false, out: "", err: r.error.message };
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

export function gitVersion(): string | null {
  const r = git(process.cwd(), ["--version"]);
  return r.ok ? (/(\d+\.\d+(\.\d+)?)/.exec(r.out)?.[1] ?? r.out.trim()) : null;
}

/** Content markers that say "a tool made this and can make it again". */
export function dirMarker(abs: string): string | undefined {
  if (existsSync(join(abs, "pyvenv.cfg"))) return "Python venv: uv sync / pip install";
  if (existsSync(join(abs, "CACHEDIR.TAG"))) return "cache, CACHEDIR.TAG";
  return undefined;
}

/** Compiled executables are build output: ELF, Mach-O, PE. */
export function binaryMarker(abs: string, size: number): string | undefined {
  if (size < 64) return undefined;
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
    /* unreadable */
  } finally {
    if (fd >= 0) closeSync(fd);
  }
  return undefined;
}

/** Can the user running undomap (and so their agent) delete or overwrite this? */
function writable(abs: string): boolean {
  for (const p of [abs, dirname(abs)]) {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      /* try parent */
    }
  }
  return false;
}

interface Sized {
  bytes: number;
  files: number;
  maxFile: number;
  capped: boolean;
  nested: string[];
  links: { abs: string; target: string }[];
  /** Descendants matching a `permanent` pattern: reported as their own places, not counted here. */
  carved: { abs: string; path: string; dir: boolean }[];
}

/** Returns the relative path when a descendant should be carved out of the place being sized. */
type Carve = (abs: string, dir: boolean) => string | undefined;

export function collect(rootInput: string, opts: CollectOptions = {}): Inventory {
  const t0 = Date.now();
  const cap = opts.cap ?? 250_000;
  let st;
  try {
    st = statSync(rootInput);
  } catch {
    throw new UsageError(`no such directory: ${rootInput}`);
  }
  if (!st.isDirectory()) throw new UsageError(`undomap maps directories; ${rootInput} is a file. Try: undomap ${JSON.stringify(resolve(rootInput, ".."))}`);
  const root = realpathSync.native(resolve(rootInput));
  const entries: RawEntry[] = [];
  const absOf = new Map<RawEntry, string>();
  const repos: Report["repos"] = [];
  const skipped: Report["skipped"] = [];
  const seen = new Set<string>();
  let fileCount = 0;
  let lastTick = 0;
  const tick = (n = 1) => {
    fileCount += n;
    if (opts.onProgress && fileCount - lastTick >= 5000) {
      lastTick = fileCount;
      opts.onProgress(fileCount);
    }
  };

  const permanent = (opts.config?.permanent ?? []).map((g) => [g, globMatcher(g)] as const);
  const userRegen = (opts.config?.regenerable ?? []).map((g) => globMatcher(g));
  const permanentOf = (path: string) => permanent.find(([, m]) => m(path))?.[0];

  const rel = (abs: string, dir = false) => {
    const r = relative(root, abs).split(sep).join("/");
    return dir ? (r ? r + "/" : "./") : r;
  };
  const inside = (abs: string) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep);
  const push = (e: RawEntry, abs: string) => {
    entries.push(e);
    absOf.set(e, abs);
  };
  const realTarget = (abs: string): string | null => {
    try {
      return realpathSync.native(abs);
    } catch {
      return null; // dangling link: nothing behind it to lose
    }
  };

  const sizeTree = (start: string, followEscapes: boolean, carve?: Carve): Sized => {
    const out: Sized = { bytes: 0, files: 0, maxFile: 0, capped: false, nested: [], links: [], carved: [] };
    const stack = [start];
    let seenHere = 0;
    while (stack.length) {
      const dir = stack.pop()!;
      let ents: Dirent[];
      try {
        ents = readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        skipped.push({ path: rel(dir, true), reason: (e as NodeJS.ErrnoException).code ?? "unreadable" });
        continue;
      }
      if (dir !== start && ents.some((d) => d.name === ".git")) {
        out.nested.push(dir);
        continue;
      }
      for (const d of ents) {
        if (d.name === ".git" && dir === start) continue;
        const p = join(dir, d.name);
        if (++seenHere > cap) {
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
            /* vanished mid-walk */
          }
        }
      }
    }
    return out;
  };

  const escapeEntry = (linkAbs: string, target: string, repo?: string) => {
    let s: Sized = { bytes: 0, files: 0, maxFile: 0, capped: false, nested: [], links: [], carved: [] };
    try {
      const size = statSync(target).size;
      s = statSync(target).isDirectory() ? sizeTree(target, false) : { ...s, bytes: size, maxFile: size, files: 1 };
    } catch {
      /* unreadable target */
    }
    push({ path: rel(linkAbs), bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "none", target, repo }, target);
  };

  const sizedEntry = (abs: string, path: string, state: GitState, repo: string | undefined) => {
    const named = regenerable(path);
    const marker = named ? undefined : dirMarker(abs);
    const forced = permanentOf(path);
    // A regenerable-looking folder can still hold something you can't rebuild: carve those out as their own places.
    const looksRegen = !!(named || marker || userRegen.some((m) => m(path)));
    const carve: Carve | undefined = looksRegen && !forced && permanent.length ? (a, dir) => { const r = rel(a, dir); return permanentOf(r) ? r : undefined; } : undefined;
    const s = sizeTree(abs, !!forced || (!named && !marker), carve);
    push({ path, bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: state, repo, regen: marker, permanent: forced }, abs);
    for (const l of s.links) escapeEntry(l.abs, l.target, repo);
    for (const n of s.nested) scanDir(n);
    for (const c of s.carved) (c.dir ? sizedEntry : fileEntry)(c.abs, c.path, state, repo);
  };

  const fileEntry = (abs: string, path: string, state: GitState, repo: string | undefined) => {
    try {
      const ls = lstatSync(abs);
      if (ls.isSymbolicLink()) {
        const t = realTarget(abs);
        if (t && !inside(t) && writable(t)) return escapeEntry(abs, t, repo);
      }
      tick();
      push({ path, bytes: ls.size, files: 1, maxFile: ls.size, git: state, repo, regen: ls.isFile() ? binaryMarker(abs, ls.size) : undefined, permanent: permanentOf(path) }, abs);
    } catch {
      /* gone */
    }
  };

  const gitOk = gitVersion() !== null;

  const scanRepo = (top: string, pathspec?: string) => {
    if (seen.has(top)) return;
    seen.add(top);
    const repo = inside(top) ? rel(top) : "";
    const spec = ["--", pathspec ? pathspec.split(sep).join("/") : "."];
    const status = git(top, ["status", "--porcelain=v2", "-z", "--ignored=traditional", "--untracked-files=normal", ...spec]);
    if (!status.ok) {
      const why = /dubious ownership/i.test(status.err)
        ? `git refused: dubious ownership (git config --global --add safe.directory ${top})`
        : status.err.split("\n")[0] || "git status failed";
      skipped.push({ path: rel(top, true), reason: why });
      return;
    }
    const tok = status.out.split("\0");
    const dirty = new Set<string>();
    for (let i = 0; i < tok.length; i++) {
      const t = tok[i];
      if (!t) continue;
      const kind = t[0];
      if (kind === "?" || kind === "!") {
        const p = t.slice(2);
        const abs = join(top, p);
        const state: GitState = kind === "?" ? "untracked" : "ignored";
        if (p.endsWith("/")) {
          if (existsSync(join(abs, ".git"))) {
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
        if (kind === "2") i++; // original path follows
        dirty.add(p);
        if (sub[0] === "S" || xy.includes("D")) continue;
        const abs = join(top, p);
        try {
          const ls = lstatSync(abs);
          tick();
          push({ path: rel(abs), bytes: ls.size, files: 1, git: "dirty", repo }, abs);
        } catch {
          /* deleted */
        }
      }
    }
    const ls = git(top, ["ls-files", "-s", "-z", ...spec]);
    let bytes = 0;
    let files = 0;
    for (const t of ls.out.split("\0")) {
      const tab = t.indexOf("\t");
      if (tab < 0) continue;
      const mode = t.slice(0, 6);
      const p = t.slice(tab + 1);
      if (dirty.has(p)) continue;
      const abs = join(top, p);
      if (mode === "160000") {
        if (existsSync(join(abs, ".git"))) scanDir(abs);
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
        /* deleted in worktree: reported by status */
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
      // git prints C:/forward/slashes on Windows: resolve to the same native form as the root, so probes can match it.
      const gdRaw = git(top, ["rev-parse", "--absolute-git-dir"]).out.trim();
      const gd = gdRaw ? realTarget(resolve(gdRaw)) ?? resolve(gdRaw) : "";
      const commits = Number(git(top, ["rev-list", "--count", "--all"]).out.trim()) || 0;
      const s = gd ? sizeTree(gd, false) : { bytes: 0, files: 0, maxFile: 0, capped: false };
      push({ path: repoDir + ".git/", bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "clean", repoIssue: "no-remote", unpushed: commits, repo }, gd || top);
    }
    repos.push({ path: repo || ".", remote: remotes[0] ?? null, unpushed, branch });
  };

  const walkPlain = (dir: string) => {
    let ents: Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: rel(dir, true), reason: (e as NodeJS.ErrnoException).code ?? "unreadable" });
      return;
    }
    let looseBytes = 0;
    let looseFiles = 0;
    let looseMax = 0;
    for (const d of ents) {
      if (d.name === ".git") continue;
      const abs = join(dir, d.name);
      if (d.isSymbolicLink()) {
        const t = realTarget(abs);
        if (t && !inside(t) && writable(t)) escapeEntry(abs, t);
        else looseFiles++;
      } else if (d.isDirectory()) {
        if (existsSync(join(abs, ".git"))) scanDir(abs);
        else sizedEntry(abs, rel(abs, true), "none", undefined);
      } else {
        try {
          const size = lstatSync(abs).size;
          looseBytes += size;
          if (size > looseMax) looseMax = size;
          looseFiles++;
          tick();
        } catch {
          /* gone */
        }
      }
    }
    if (looseFiles) {
      const base = rel(dir, true);
      push({ path: (base === "./" ? "" : base) + "*", bytes: looseBytes, files: looseFiles, maxFile: looseMax, git: "none" }, dir);
    }
  };

  /** A directory that might be a repo top, inside a repo, or plain. */
  const scanDir = (dir: string) => {
    if (gitOk && existsSync(join(dir, ".git"))) {
      const top = git(dir, ["rev-parse", "--show-toplevel"]);
      if (top.ok && top.out.trim()) {
        const t = realpathSync.native(resolve(top.out.trim()));
        if (t === dir) return scanRepo(dir);
      }
    }
    walkPlain(dir);
  };

  // Where does the root sit?
  if (gitOk) {
    const top = git(root, ["rev-parse", "--show-toplevel"]);
    const t = top.ok && top.out.trim() ? realpathSync.native(resolve(top.out.trim())) : null;
    if (t && t !== root) {
      const sub = relative(t, root);
      const ignored = git(t, ["check-ignore", "-q", "--", sub.split(sep).join("/") + "/"]).ok;
      if (ignored) {
        // The whole root is gitignored inside a parent repo: nothing here is in history.
        const s = sizeTree(root, true);
        push({ path: "./", bytes: s.bytes, files: s.files, maxFile: s.maxFile, capped: s.capped, git: "ignored" }, root);
        for (const l of s.links) escapeEntry(l.abs, l.target);
        for (const n of s.nested) scanDir(n);
      } else scanRepo(t, sub);
    } else if (t) scanRepo(t);
    else walkPlain(root);
  } else walkPlain(root);

  const platform = opts.platform ?? process.platform;
  const snap = opts.snapshots ?? probeSnapshots(root, { platform, mode: opts.noProbe ? "off" : undefined });
  let cloud: ReturnType<typeof probeCloud>;
  try {
    cloud = probeCloud(root, { platform, ...opts.cloud, ...(opts.noProbe ? { mode: "off" } : {}) });
  } catch (e) {
    // A probe never fails the map.
    cloud = { probes: [{ name: "cloud sync", status: "unknown", detail: `probe failed: ${(e as Error).message}`, counts: true }], check: () => undefined };
  }
  for (const e of entries) {
    const fragile =
      e.repoIssue === "no-remote" || e.target || (!e.aggregate && !e.repoIssue && e.git !== "dirty" && e.git !== "clean" && (!!e.permanent || (!e.regen && !regenerable(e.path))));
    if (fragile) {
      const abs = absOf.get(e) ?? root;
      const label = snap.covers(abs);
      if (label) e.snapshot = label;
      else {
        const c = cloud.check(abs, { bytes: e.bytes, maxFile: e.maxFile, dir: e.path.endsWith("/") || e.path.endsWith("*"), capped: e.capped });
        if (c) e.cloud = c;
      }
    }
  }
  const gv = gitVersion();
  const probes: Probe[] = [
    gv
      ? { name: "git", status: "ok", detail: gv, counts: true }
      : { name: "git", status: "absent", detail: "git not found: every path is graded as outside git", counts: true },
    ...snap.probes,
    ...cloud.probes,
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
    skipped,
  };
}


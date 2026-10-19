// Pure grading: RawEntry[] + probes -> Report. No filesystem, no git: also runs in the browser.
import { critical, globMatch, isSecret, regenerable } from "./patterns.js";
import { fixFor, type FixContext } from "./fix.js";
import type { Finding, Probe, RawEntry, Report, Zone } from "./types.js";
import { VERSION } from "./version.js";

export interface Config {
  /** Extra paths that a script rebuilds (graded slow, not permanent). */
  regenerable?: string[];
  /** Paths you back up some other way (restic, rsync, a NAS job) — graded slow, not permanent. */
  backedUp?: string[];
  /**
   * Paths that can't be rebuilt even if they look regenerable (a hand-curated `data/` under `build/`, a `models/`
   * cache). They beat every regenerable guess; real coverage (`backedUp`, a snapshot) and git itself still win.
   */
  permanent?: string[];
}

export interface Inventory {
  root: string;
  rootName: string;
  platform: string;
  scannedAt: string;
  durationMs: number;
  repos: Report["repos"];
  probes: Probe[];
  entries: RawEntry[];
  skipped: Report["skipped"];
}

export interface GradeOptions {
  /** Permanent bytes allowed before the exit code turns 1 (default 0). */
  thresholdBytes?: number;
  config?: Config;
}

/** A machine-level snapshot covers paths, so a copy into ~/.undomap-safe is covered too. Cloud folders don't count. */
export const machineSnapshots = (probes: Probe[]) => probes.some((p) => p.counts && p.status === "ok" && p.name !== "git" && p.name !== "cloud sync");

const ZONE_ORDER: Record<Zone, number> = { VE: 0, AE: 1, X: 2 };

/**
 * Precedence, highest first:
 *   1. what git knows: clean tracked = X; uncommitted edits and unpushed commits = AE
 *   2. real coverage: `backedUp`, a snapshot that covers the path, cloud version history we could verify = AE
 *   3. `permanent` in .undomap.json: beats every "regenerable" guess (built-in names, markers, your `regenerable`)
 *   4. regenerable = AE
 *   5. everything else that git doesn't hold = VE
 */
export function classify(e: RawEntry, config: Config = {}): Omit<Finding, "fix"> {
  const base = { path: e.path, bytes: e.bytes, files: e.files, capped: !!e.capped, repo: e.repo, secret: false, target: e.target, unpushed: e.unpushed };
  const userRegen = (config.regenerable ?? []).some((g) => globMatch(g, e.path));
  const userBacked = (config.backedUp ?? []).some((g) => globMatch(g, e.path)) || e.backedUp;
  const c = e.cloud;
  const cloud = c ? { cloud: { provider: c.provider, status: c.status, note: c.note } } : {};
  const synced = c?.status === "covered";
  // Appended to a Zone VE reason when a sync folder is involved but its history doesn't (provably) cover the path.
  const cloudNote = !c || synced ? "" : c.status === "unverified" ? ` · possible ${c.provider} versioning, unverified` : c.status === "partial" ? ` · ${c.provider} keeps deletes 30 days, not overwrites` : ` · ${c.provider} skips it (${c.note})`;
  if (e.repoIssue === "no-remote") {
    if (userBacked) return { ...base, zone: "AE", kind: "backed-up", why: "no remote, but backed up per .undomap.json" };
    if (e.snapshot) return { ...base, zone: "AE", kind: "snapshot", why: `no remote; in ${e.snapshot}` };
    if (synced) return { ...base, ...cloud, zone: "AE", kind: "cloud", why: `no remote; .git syncs to ${c.provider} (${c.note})` };
    return { ...base, ...cloud, zone: "VE", kind: "no-remote", why: `repo with no remote: .git is the only copy of its history${cloudNote}` };
  }
  if (e.repoIssue === "unpushed") return { ...base, zone: "AE", kind: "unpushed", why: `${e.unpushed} commit${e.unpushed === 1 ? "" : "s"} not on any remote` };
  if (e.aggregate) return { ...base, zone: "X", kind: "tracked", why: "clean tracked files: git checkout / git restore" };
  if (e.git === "dirty") return { ...base, zone: "AE", kind: "dirty", why: "tracked, uncommitted edits: last commit comes back, the edits don't" };
  if (e.target) {
    if (e.snapshot) return { ...base, zone: "AE", kind: "snapshot", why: `link to ${e.target}; target in ${e.snapshot}` };
    if (synced) return { ...base, ...cloud, zone: "AE", kind: "cloud", why: `link to ${e.target}; target syncs to ${c.provider} (${c.note})` };
    return { ...base, ...cloud, zone: "VE", kind: "symlink-escape", why: `symlink out of the map · the agent writes through it${cloudNote}` };
  }
  const forcedBy = e.permanent ?? (config.permanent ?? []).find((g) => globMatch(g, e.path));
  const looked = userRegen ? "per your .undomap.json" : (e.regen ?? regenerable(e.path));
  const gitWhat = e.git === "ignored" ? "gitignored · " : e.git === "untracked" ? "untracked · " : "";
  if (looked && !forcedBy) return { ...base, zone: "AE", kind: "regenerable", why: `${gitWhat}regenerable (${looked})` };
  const secret = isSecret(e.path);
  const crit = critical(e.path);
  const what = e.git === "ignored" ? "gitignored" : e.git === "untracked" ? "untracked" : "outside any git repo";
  const kind = e.git === "ignored" ? "ignored" : e.git === "untracked" ? "untracked" : "no-git";
  const forced = forcedBy ? { forcedBy } : {};
  const marked = forcedBy ? ", marked permanent" : "";
  if (userBacked) return { ...base, ...forced, secret, zone: "AE", kind: "backed-up", why: `${what}${marked}, but backed up per .undomap.json` };
  if (e.snapshot) return { ...base, ...forced, secret, zone: "AE", kind: "snapshot", why: `${what}${marked}; restorable from ${e.snapshot}` };
  if (synced) return { ...base, ...forced, ...cloud, secret, zone: "AE", kind: "cloud", why: `${what}${marked}; in ${c.provider} (${c.note})` };
  const extra = secret ? " · looks like secrets" : crit ? ` · ${crit}` : "";
  const note = !forcedBy
    ? ""
    : userRegen
      ? " · on both lists in .undomap.json: permanent wins over regenerable"
      : looked
        ? ` · looks regenerable (${looked}) but .undomap.json marks it permanent`
        : " · permanent per .undomap.json";
  return { ...base, ...forced, ...cloud, secret, zone: "VE", kind, why: `${what}${extra}${note}${cloudNote}` };
}

export function grade(inv: Inventory, opts: GradeOptions = {}): Report {
  const config = opts.config ?? {};
  const threshold = Math.max(0, opts.thresholdBytes ?? 0);
  const ctx: FixContext = { platform: inv.platform, rootName: inv.rootName, snapshots: machineSnapshots(inv.probes) };
  const findings: Finding[] = [];
  for (const e of inv.entries) {
    if (e.bytes === 0 && e.files === 0 && !e.repoIssue) continue; // nothing to lose
    const f = classify(e, config) as Finding;
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
    thresholdBytes: threshold,
  };
}

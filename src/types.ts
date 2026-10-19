// Shared data model. Collect (filesystem + git) produces RawEntry[]; grade() is pure and turns
// them into a Report. The landing page runs the same grade() on canned inventories in the browser.

/** VE = permanent loss, AE = slow undo, X = undoable. Named after FEMA flood-zone letters. */
export type Zone = "VE" | "AE" | "X";

/** What git (or the lack of it) says about a path. */
export type GitState = "clean" | "dirty" | "untracked" | "ignored" | "none";

export type Kind =
  | "ignored" // gitignored and not regenerable
  | "untracked" // untracked and not regenerable
  | "no-git" // outside every git work tree
  | "symlink-escape" // a link inside the map pointing outside it
  | "no-remote" // a repo whose .git is the only copy of its history
  | "regenerable" // node_modules, dist, target, .venv, ...
  | "dirty" // tracked, with uncommitted changes
  | "unpushed" // commits that exist only in this .git
  | "snapshot" // would be permanent, but a local snapshot covers it
  | "backed-up" // would be permanent, but config says it is backed up elsewhere
  | "cloud" // would be permanent, but a running sync client keeps version history for it
  | "tracked"; // clean tracked files: git checkout brings them back

export type CloudProvider = "iCloud Drive" | "Dropbox" | "OneDrive" | "Google Drive";

/** What a cloud-sync folder's own history does for one path. Only "covered" demotes to Zone AE. */
export interface CloudCoverage {
  provider: CloudProvider;
  /** covered: client config + client running + no known exclusion · unverified: can't confirm it syncs ·
   *  partial: deletes kept, overwrites not versioned (iCloud) · gap: the provider skips this path */
  status: "covered" | "unverified" | "partial" | "gap";
  /** Why, in a few words. */
  note: string;
  /** The sync folder (absolute). */
  root: string;
}

export interface RawEntry {
  /** Path relative to the scan root, POSIX separators; directories end with "/". */
  path: string;
  bytes: number;
  files: number;
  git: GitState;
  /** True when sizing stopped at the entry cap; bytes/files are lower bounds. */
  capped?: boolean;
  /** Repo this entry belongs to (relative to root, "" = root itself, "/" suffix-less). */
  repo?: string;
  /** For symlink escapes: absolute target. */
  target?: string;
  /** Repo-level facts, set on synthetic entries. */
  repoIssue?: "no-remote" | "unpushed";
  unpushed?: number;
  /** Aggregate of clean tracked files (one entry per repo). */
  aggregate?: boolean;
  /** Snapshot coverage label if a probe says this path is in a local snapshot. */
  snapshot?: string;
  /** Matches a config `backedUp` entry. */
  backedUp?: boolean;
  /** Matches a config `regenerable` entry or a built-in pattern (set by grade). */
  regen?: string;
  /** The `.undomap.json` `permanent` pattern that matches this path (set by collect; grade also checks). */
  permanent?: string;
  /** Largest single file inside (set by collect, for cloud per-file size limits). */
  maxFile?: number;
  /** Set by collect when the path sits inside a cloud-sync folder. */
  cloud?: CloudCoverage;
}

export interface Fix {
  /** One-line advice, cheapest real protection first. */
  say: string;
  /** Copy-pasteable command, when there is one. */
  run?: string;
  /** Rough effort: seconds | minutes | setup */
  cost: "seconds" | "minutes" | "setup";
}

export interface Finding {
  zone: Zone;
  kind: Kind;
  path: string;
  bytes: number;
  files: number;
  capped: boolean;
  repo?: string;
  /** Short reason shown next to the path. */
  why: string;
  secret: boolean;
  target?: string;
  unpushed?: number;
  /** The `.undomap.json` `permanent` pattern that matched: it overrides any "regenerable" guess. */
  forcedBy?: string;
  /** Present when the path is inside a cloud-sync folder: what its version history does (and doesn't) cover. */
  cloud?: Omit<CloudCoverage, "root">;
  fix?: Fix;
}

export type ProbeStatus = "ok" | "absent" | "unknown";

export interface Probe {
  name: string;
  status: ProbeStatus;
  detail: string;
  /** Does this probe make paths recoverable? Trash does not (rm skips it). */
  counts: boolean;
}

export interface ZoneTotal {
  bytes: number;
  places: number;
  files: number;
}

export interface Report {
  tool: "undomap";
  version: string;
  root: string;
  scannedAt: string;
  durationMs: number;
  repos: { path: string; remote: string | null; unpushed: number; branch: string | null }[];
  probes: Probe[];
  totals: Record<Zone, ZoneTotal>;
  findings: Finding[];
  /** Paths that could not be read (permission denied etc.). */
  skipped: { path: string; reason: string }[];
  /** Exit code the CLI uses for this report under the given threshold. */
  exitCode: 0 | 1;
  thresholdBytes: number;
}

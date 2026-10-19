// The cheapest real protection for a finding. Cheap = seconds of your time, no new infrastructure.
import type { Finding, Fix } from "./types.js";

const SMALL = 25 * 1024 * 1024; // fits in git / a tarball without thinking about it
const MEDIA_SMALL = 2 * 1024 * 1024; // binaries bloat history forever: past this, copy instead of commit
const BINARY = /\.(mov|mp4|mkv|webm|avi|wav|flac|mp3|psd|blend|zip|tar|gz|tgz|7z|rar|iso|dmg|bin|onnx|safetensors|ckpt|pt|pth|gguf|sqlite|db|parquet)$/i;
const SAFE = "~/.undomap-safe";

const q = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);
const slug = (p: string) => p.replace(/\/+$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
const noSlash = (p: string) => p.replace(/\/+$/, "") || ".";

export interface FixContext {
  platform: string;
  /** Name of the scanned root, for backup file names. */
  rootName: string;
  /** Any snapshot probe that actually covers paths. */
  snapshots: boolean;
}

export function fixFor(f: Finding, ctx: FixContext): Fix | undefined {
  const fix = baseFix(f, ctx);
  return fix && f.zone === "VE" && f.cloud ? { ...fix, say: cloudSay(f.cloud, fix.say) } : fix;
}

/** A Zone VE place in a sync folder: the real fix first, then what the provider does and doesn't do. Same command. */
function cloudSay(c: NonNullable<Finding["cloud"]>, say: string): string {
  if (c.status === "unverified") return `${say} · possible ${c.provider} versioning, unverified`;
  if (c.status === "partial") return `${say} · ${c.provider} only brings back deletes, not overwrites`;
  return `${say} · ${c.provider} skips it: ${c.note}`;
}

/** One line per unverified sync folder: the cheapest way to find out whether its history counts. */
export function cloudCheck(c: NonNullable<Finding["cloud"]>): string {
  if (/not running/.test(c.note)) return `start ${c.provider}, let it finish syncing, then rerun undomap`;
  if (/stale copy/.test(c.note)) return `if ${c.provider} really syncs this folder, start its app and rerun undomap; if not, nothing versions it`;
  if (/install attr/.test(c.note)) return "install attr (getfattr), then rerun undomap";
  return `check the ${c.provider} app shows these synced, then rerun undomap`;
}

function baseFix(f: Finding, ctx: FixContext): Fix | undefined {
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
          cost: "seconds",
        };
      const binary = f.bytes > MEDIA_SMALL && (BINARY.test(p) || (f.path.endsWith("/") && f.bytes / Math.max(1, f.files) > 1024 * 1024));
      if (f.bytes > SMALL || f.capped || binary)
        return {
          say: ctx.snapshots
            ? `${binary && f.bytes <= SMALL ? "binary, keep it out of git" : "too big for git"}: copy it where the agent can't write (here, or better a disk, NAS or versioned bucket)`
            : `${binary && f.bytes <= SMALL ? "binary, keep it out of git" : "too big for git"}: copy it where the agent can't write, then snapshot that copy`,
          run: `mkdir -p -m 700 ${SAFE} && rsync -a ${q(p)}${f.path.endsWith("/") ? "/" : ""} ${SAFE}/${q(name)}/`,
          cost: "minutes",
        };
      if (f.kind === "untracked")
        return { say: "commit it, then git checkout brings it back", run: `git add -- ${q(p)} && git commit -m ${q(`track ${p}`)}`, cost: "seconds" };
      if (f.kind === "no-git")
        return f.path.endsWith("/")
          ? { say: "give it local history in one command", run: `git -C ${q(p)} init -q && git -C ${q(p)} add -A && git -C ${q(p)} commit -qm "undomap: baseline"`, cost: "seconds" }
          : { say: "copy it outside the agent's workspace", run: `mkdir -p -m 700 ${SAFE} && cp -p ${q(p)} ${SAFE}/`, cost: "seconds" };
      return {
        say: "ignored on purpose, so don't commit it: keep a copy outside the tree",
        run: `mkdir -p -m 700 ${SAFE} && tar -czf ${SAFE}/${q(name + ".tgz")} ${q(p)}`,
        cost: "seconds",
      };
    }
    case "symlink-escape":
      return {
        say: "the agent writes through this link: map the target too, or replace it with a copy",
        run: f.target ? `undomap ${q(f.target)}` : undefined,
        cost: "seconds",
      };
    case "no-remote":
      return {
        say: ".git is the only copy of the history: bundle it off-tree (or add a remote and push)",
        run: `git ${f.repo ? `-C ${q(f.repo)} ` : ""}bundle create ~/${q(slug(f.repo || ctx.rootName))}.bundle --all`,
        cost: "seconds",
      };
    case "unpushed":
      return { say: `${f.unpushed ?? "some"} commit${f.unpushed === 1 ? "" : "s"} exist only in this .git: push them`, run: `git ${f.repo ? `-C ${q(f.repo)} ` : ""}push --all`, cost: "seconds" };
    case "dirty":
      return { say: "uncommitted edits: checkpoint before the agent runs", run: `git stash push -u -m "before agent" && git stash apply   # or: agentckpt snap`, cost: "seconds" };
    default:
      return undefined;
  }
}

/** One machine-level fix, shown once when no snapshot probe covers the map. */
export function snapshotFix(platform: string): Fix {
  if (platform === "darwin") return { say: "turn on Time Machine: hourly local snapshots turn most of Zone VE into slow undo", run: "sudo tmutil enable   # then pick a backup disk in System Settings", cost: "setup" };
  if (platform === "win32") return { say: "turn on File History or System Protection (VSS) for this drive", run: "control /name Microsoft.FileHistory", cost: "setup" };
  return { say: "snapshot the workspace: btrfs/ZFS with snapper, or restic/borg on a timer", run: "sudo snapper -c home create-config /home   # btrfs example", cost: "setup" };
}

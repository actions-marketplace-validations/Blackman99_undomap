import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBytes } from "./bytes.js";
import { UsageError } from "./collect.js";
import { formatJson, formatMarkdown, formatText } from "./format.js";
import { runMcp } from "./mcp.js";
import { mapPath } from "./run.js";
import { VERSION } from "./version.js";

const HELP = `undomap ${VERSION} — which paths can your AI coding agent erase with no way back?

Usage
  undomap [path]                 map a directory (default: current directory)
  undomap map [path]             same
  undomap mcp                    MCP server on stdio (read-only: map_report, list_permanent)
  undomap version

Options
      --fix                      cheapest fix under every Zone VE place
      --json                     JSON report on stdout
      --markdown                 Markdown report (job summaries, issues)
      --all                      list every Zone VE place (default: top 12; secrets always shown)
      --max-permanent <size>     permanent bytes allowed before exit 1 (default 0), e.g. 1MB
      --config <file>            config file (default: <path>/.undomap.json)
      --reach                    also check credential reach: live credentials + network + writes outside
                                 the tree (the "lethal trifecta"). Names and paths only, never values
      --no-probe                 skip snapshot and cloud-sync probes (Time Machine, btrfs/ZFS, Timeshift, Dropbox…)
      --no-color                 plain output (also NO_COLOR=1)
  -h, --help / -v, --version

Zones (FEMA flood-map letters)
  VE  permanent   gitignored or untracked and not regenerable, outside git, symlinks out, repo with no remote
  AE  slow undo   regenerable (node_modules, dist, .venv…), uncommitted edits, unpushed commits, in a snapshot,
                  in a cloud folder whose version history undomap could verify
  X   undoable    clean tracked files: git checkout brings them back

Exit codes: 0 nothing permanent · 1 something in Zone VE · 2 usage or hard error
undomap never writes: git runs with GIT_OPTIONAL_LOCKS=0. Docs: https://blackman99.github.io/undomap/docs/`;

const BOOL = new Set(["fix", "json", "markdown", "all", "reach", "no-probe", "no-color", "help", "version"]);
const VALUED = new Set(["max-permanent", "config"]);
const SHORT: Record<string, string> = { h: "help", v: "version" };
const COMMANDS = ["map", "mcp", "version", "help"];

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Closest known word within two edits, for "did you mean" hints. */
export function nearest(word: string, known: Iterable<string>): string | undefined {
  let best: string | undefined;
  let score = 3;
  for (const k of known) {
    const s = distance(word, k);
    if (s < score) [best, score] = [k, s];
  }
  return best;
}

export interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const flags: Args["flags"] = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      let [k, v] = a.startsWith("--") ? a.slice(2).split(/=(.*)/s, 2) : [SHORT[a[1]] ?? a.slice(1), undefined];
      if (BOOL.has(k)) {
        if (v !== undefined) throw new UsageError(`--${k} takes no value`);
        flags[k] = true;
      } else if (VALUED.has(k)) {
        if (v === undefined) v = argv[++i];
        if (v === undefined || v.startsWith("--")) throw new UsageError(`--${k} needs a value`);
        flags[k] = v;
      } else {
        const near = nearest(k, [...BOOL, ...VALUED]);
        throw new UsageError(`unknown option ${a}${near ? ` (did you mean --${near}?)` : ""}`);
      }
    } else pos.push(a);
  }
  let cmd = "map";
  if (pos[0] === "map" || pos[0] === "mcp" || pos[0] === "version" || pos[0] === "help") cmd = pos.shift()!;
  return { cmd, pos, flags };
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  isTTY: boolean;
  errTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const defaultIo = (): Io => ({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  isTTY: !!process.stdout.isTTY,
  errTTY: !!process.stderr.isTTY,
  env: process.env,
  cwd: process.cwd(),
});

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const a = parseArgs(argv);
  if (a.flags.help || a.cmd === "help") {
    io.out(HELP + "\n");
    return 0;
  }
  if (a.flags.version || a.cmd === "version") {
    io.out(`undomap ${VERSION}\n`);
    return 0;
  }
  if (a.cmd === "mcp") {
    await runMcp();
    return 0;
  }
  if (a.pos.length > 1) throw new UsageError(`one path at a time (got ${a.pos.length}); run undomap once per directory`);
  if (a.flags.json && a.flags.markdown) throw new UsageError("pick one of --json or --markdown");
  const path = resolvePath(io.cwd, a.pos[0] ?? ".");
  if (a.pos[0] && !existsSync(path) && !/[\\/.]/.test(a.pos[0])) {
    const near = nearest(a.pos[0], COMMANDS);
    if (near) throw new UsageError(`no such directory: ${a.pos[0]} (did you mean \`undomap ${near}\`?)`);
  }
  const threshold = typeof a.flags["max-permanent"] === "string" ? safeBytes(a.flags["max-permanent"]) : 0;
  const forced = !!io.env.FORCE_COLOR && io.env.FORCE_COLOR !== "0" && io.env.FORCE_COLOR !== "false";
  const color = !a.flags["no-color"] && !io.env.NO_COLOR && (forced || (io.isTTY && io.env.TERM !== "dumb"));
  const progress = io.errTTY && !a.flags.json && !a.flags.markdown;
  let shown = false;
  const report = mapPath(path, {
    thresholdBytes: threshold,
    configFile: typeof a.flags.config === "string" ? resolvePath(io.cwd, a.flags.config) : undefined,
    noProbe: !!a.flags["no-probe"],
    reach: !!a.flags.reach,
    onProgress: progress
      ? (n) => {
          shown = true;
          io.err(`\r  surveying… ${n.toLocaleString("en-US")} files`);
        }
      : undefined,
  });
  if (shown) io.err("\r\x1b[2K");
  if (a.flags.json) io.out(formatJson(report) + "\n");
  else if (a.flags.markdown) io.out(formatMarkdown(report) + "\n");
  else
    io.out(
      formatText(report, {
        color,
        truecolor: color && /truecolor|24bit/i.test(io.env.COLORTERM ?? ""),
        fix: !!a.flags.fix,
        limit: a.flags.all ? Infinity : 12,
        width: process.stdout.columns,
        home: homedir(),
      }) + "\n",
    );
  return report.exitCode;
}

function safeBytes(s: string): number {
  try {
    return parseBytes(s);
  } catch (e) {
    throw new UsageError(`--max-permanent: ${(e as Error).message}`);
  }
}

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return norm(real(fileURLToPath(import.meta.url))) === norm(real(resolvePath(arg)));
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      if (e instanceof UsageError) {
        process.stderr.write(`undomap: ${e.message}\nRun \`undomap --help\` for usage.\n`);
      } else process.stderr.write(`undomap: ${(e as Error)?.stack ?? e}\n`);
      process.exitCode = 2;
    },
  );
}

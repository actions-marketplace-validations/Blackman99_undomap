// Human report (ANSI), Markdown (job summary / MCP) and JSON.
import { fmtBytes, plural } from "./bytes.js";
import { cloudCheck, snapshotFix } from "./fix.js";
import { machineSnapshots } from "./grade.js";
import type { Finding, Report, Zone } from "./types.js";

export interface TextOptions {
  color: boolean;
  truecolor?: boolean;
  fix?: boolean;
  width?: number;
  home?: string;
  platform?: string;
  /** VE rows shown before "… and N more" (secrets always shown). */
  limit?: number;
}

const ZONE_NAME: Record<Zone, string> = { VE: "PERMANENT", AE: "SLOW UNDO", X: "UNDOABLE" };

function palette(o: TextOptions) {
  const tc = o.truecolor;
  const c = (code: string) => (s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return {
    VE: c(tc ? "38;2;224;112;26" : "38;5;166"),
    AE: c(tc ? "38;2;201;164;58" : "38;5;178"),
    X: c(tc ? "38;2;42;157;149" : "38;5;36"),
    copper: c(tc ? "38;2;176;122;80" : "38;5;137"),
    bold: c("1"),
    dim: c("2"),
    under: c("4"),
  };
}

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
export function bar(frac: number, width: number): string {
  const eighths = Math.max(1, Math.round(Math.min(1, Math.max(0, frac)) * width * 8));
  const full = Math.floor(eighths / 8);
  return ("█".repeat(full) + BLOCKS[eighths % 8]).padEnd(width, " ");
}

const tilde = (p: string, home?: string) => (home && (p === home || p.startsWith(home + "/") || p.startsWith(home + "\\")) ? "~" + p.slice(home.length) : p);
// Unquoted absolute paths under $HOME read better as ~/… (still valid shell: ~ expands after a space).
const tildeRun = (run: string, home?: string) => (home && home !== "/" ? run.split(" " + home + "/").join(" ~/") : run);
const cut = (s: string, n: number) => (s.length <= n ? s : "…" + s.slice(s.length - n + 1));

function label(f: Finding, home?: string): string {
  if (f.kind === "symlink-escape") return `${f.path} → ${tilde(f.target ?? "?", home)}`;
  if (f.path === "*") return "./* (loose files)";
  if (f.path.startsWith("./")) return f.path.slice(2) || "./";
  return f.path;
}

function detail(f: Finding): string {
  const bits = [f.why];
  if (f.kind === "no-remote") bits.push(plural(f.unpushed ?? 0, "commit"));
  else if (f.kind === "unpushed") return f.why;
  else if (f.files > 1 || f.path.endsWith("/") || f.path.endsWith("*")) bits.push(plural(f.files, "file") + (f.capped ? "+" : ""));
  return bits.join(" · ");
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const amount = (f: Finding) => (f.kind === "unpushed" ? "—" : fmtBytes(f.bytes) + (f.capped ? "+" : ""));
export const fmtDuration = (ms: number) => (ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);

export function formatText(r: Report, o: TextOptions): string {
  const k = palette(o);
  const width = Math.max(60, Math.min(o.width ?? 100, 140));
  const out: string[] = [];
  const ve = r.findings.filter((f) => f.zone === "VE");
  const ae = r.findings.filter((f) => f.zone === "AE");
  const x = r.findings.filter((f) => f.zone === "X");
  const files = r.findings.filter((f) => !f.path.endsWith(".git/")).reduce((n, f) => n + f.files, 0);
  out.push(
    `${k.bold("undomap")} ${k.dim(r.version)}  ${k.dim("·")}  ${tilde(r.root, o.home)}  ${k.dim("·")}  ${k.dim(
      `${plural(r.repos.length, "repo")} · ${plural(files, "file")} · ${fmtDuration(r.durationMs)}`,
    )}`,
  );
  out.push("");

  // Zone VE
  out.push(`${k.VE("▲")} ${k.bold(k.VE("ZONE VE"))} ${k.dim("·")} ${k.VE(ZONE_NAME.VE)}`);
  if (!ve.length) {
    out.push(`  ${k.bold("0 B")} — nothing here your agent can erase for good.`);
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
    if (shown.length < ve.length) out.push(k.dim(`  … and ${ve.length - shown.length} more (undomap --json for all)`));
  }
  out.push("");

  // Zone AE
  out.push(
    `${k.AE("▲")} ${k.bold(k.AE("ZONE AE"))} ${k.dim("·")} ${k.AE(ZONE_NAME.AE)}   ${
      ae.length ? `${fmtBytes(r.totals.AE.bytes)} across ${plural(r.totals.AE.places, "place")} ${k.dim("— rebuild, restore or re-download")}` : k.dim("nothing")
    }`,
  );
  const aeShow = ae.slice(0, 6);
  if (aeShow.length) {
    const amtW = Math.max(...aeShow.map((f) => amount(f).length));
    const pathW = Math.min(Math.max(...aeShow.map((f) => label(f, o.home).length)), Math.floor(width * 0.42));
    for (const f of aeShow) out.push(`  ${k.AE(amount(f).padStart(amtW))}  ${cut(label(f, o.home), pathW).padEnd(pathW)}  ${k.dim(detail(f))}`);
    if (ae.length > aeShow.length) out.push(k.dim(`  … and ${ae.length - aeShow.length} more`));
  }
  out.push("");

  // Zone X
  out.push(
    `${k.X("▲")} ${k.bold(k.X("ZONE X"))} ${k.dim("·")} ${k.X(ZONE_NAME.X)}   ${
      x.length ? `${fmtBytes(r.totals.X.bytes)} · ${plural(r.totals.X.files, "tracked file")} ${k.dim("— git checkout / git restore")}` : k.dim("no clean tracked files")
    }`,
  );
  if (x.length > 1) for (const f of x.slice(0, 5)) out.push(`  ${k.X(fmtBytes(f.bytes).padStart(8))}  ${f.path}  ${k.dim(plural(f.files, "file"))}`);
  out.push("");

  // Probes
  const probeBits = r.probes.filter((p) => p.counts || p.status === "ok").map((p) => {
    const mark = p.status === "ok" ? (p.counts ? k.X("✓") : k.AE("~")) : p.status === "absent" ? k.VE("✗") : k.dim("?");
    return `${p.name} ${mark} ${k.dim(p.detail)}`;
  });
  out.push(`  ${k.dim("probes")}  ${probeBits.join(k.dim("  ·  "))}`);
  if (r.skipped.length) out.push(`  ${k.dim("skipped")} ${r.skipped.length} unreadable: ${r.skipped.slice(0, 3).map((s) => `${s.path} (${s.reason})`).join(", ")}${r.skipped.length > 3 ? ", …" : ""}`);

  // Fix footer: the biggest permanent place, then the machine-level fix, then the hints.
  const snapOk = machineSnapshots(r.probes);
  if (ve.length && !o.fix) {
    const top = ve[0];
    out.push("");
    out.push(`  ${k.copper("fix first")}  ${k.bold(label(top, o.home))} — ${top.fix?.say ?? ""}`);
    if (top.fix?.run) out.push(`    ${k.dim("$")} ${tildeRun(top.fix.run, o.home)}`);
  }
  if (ve.length && !snapOk) {
    const s = snapshotFix(o.platform ?? process.platform);
    out.push("");
    out.push(`  ${k.copper("whole map")}  ${s.say}`);
    if (o.fix && s.run) out.push(`    ${k.dim("$")} ${s.run}`);
  }
  const unverified = new Map<string, { c: NonNullable<Finding["cloud"]>; n: number }>();
  for (const f of ve)
    if (f.cloud?.status === "unverified") {
      const key = f.cloud.provider + "\0" + f.cloud.note;
      unverified.set(key, { c: f.cloud, n: (unverified.get(key)?.n ?? 0) + 1 });
    }
  for (const { c, n } of unverified.values()) {
    out.push("");
    out.push(`  ${k.copper("cloud sync")}  ${c.provider} may keep versions of ${n === ve.length ? (n === 1 ? "the place" : n === 2 ? "both places" : `all ${n} places`) : plural(n, "place")} above, but undomap can't confirm it (${c.note})`);
    out.push(`    ${k.dim("→")} ${cloudCheck(c)}`);
  }
  if (ve.length && !o.fix) {
    out.push("");
    out.push(k.dim(`  undomap --fix for every place · --json for scripts · exit 1 = something in Zone VE`));
  }
  return out.join("\n");
}

export function formatMarkdown(r: Report): string {
  const ve = r.findings.filter((f) => f.zone === "VE");
  const ae = r.findings.filter((f) => f.zone === "AE");
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const lines = [
    `### undomap — ${ve.length ? `${fmtBytes(r.totals.VE.bytes)} across ${plural(r.totals.VE.places, "place")} your agent can erase forever` : "nothing your agent can erase for good"}`,
    "",
    `\`${r.root}\` · ${plural(r.repos.length, "repo")} · undomap ${r.version}`,
    "",
    "| Zone | Bytes | Places |",
    "|---|---:|---:|",
    `| 🟧 **VE** permanent | ${fmtBytes(r.totals.VE.bytes)} | ${r.totals.VE.places} |`,
    `| 🟨 **AE** slow undo | ${fmtBytes(r.totals.AE.bytes)} | ${r.totals.AE.places} |`,
    `| 🟩 **X** undoable | ${fmtBytes(r.totals.X.bytes)} | ${plural(r.totals.X.files, "file")} |`,
  ];
  if (ve.length) {
    lines.push("", "#### Zone VE — no way back", "", "| Bytes | Path | Why | Cheapest fix |", "|---:|---|---|---|");
    for (const f of ve.slice(0, 30))
      lines.push(`| ${amount(f)} | \`${esc(label(f))}\` | ${esc(detail(f))} | ${f.fix ? esc(cap(f.fix.say)) + (f.fix.run ? `<br>\`${esc(f.fix.run)}\`` : "") : ""} |`);
    if (ve.length > 30) lines.push(`| | … ${ve.length - 30} more | | |`);
  }
  if (ae.length) {
    lines.push("", "<details><summary>Zone AE — slow undo (" + ae.length + ")</summary>", "", "| Bytes | Path | Why |", "|---:|---|---|");
    for (const f of ae.slice(0, 30)) lines.push(`| ${amount(f)} | \`${esc(label(f))}\` | ${esc(detail(f))} |`);
    lines.push("", "</details>");
  }
  lines.push("", "Probes: " + r.probes.map((p) => `${p.name}: ${p.detail}`).join(" · "));
  return lines.join("\n");
}

export function formatJson(r: Report): string {
  return JSON.stringify(r, null, 2);
}

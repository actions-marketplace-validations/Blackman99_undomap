// Materialize fixture repos with real git in a temp dir. Fixture files that git would treat specially
// in *this* repo are stored with a leading underscore (_gitignore, _env, _node_modules) and renamed here.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "fixtures");

const RENAME: Record<string, string> = { _gitignore: ".gitignore", _env: ".env", _node_modules: "node_modules" };

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=undomap-test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface RepoSpec {
  commit: string[];
  generate?: Record<string, number>;
  /** Files that start with an ELF header (a compiled binary, as far as undomap can tell). */
  elf?: string[];
  modify?: Record<string, string>;
  remote?: boolean;
}

function renameSpecial(dir: string) {
  for (const [from, to] of Object.entries(RENAME)) if (existsSync(join(dir, from))) renameSync(join(dir, from), join(dir, to));
}

function makeRepo(dir: string, spec: RepoSpec, base: string, name: string) {
  for (const [p, n] of Object.entries(spec.generate ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff;
    writeFileSync(join(dir, p), buf);
  }
  for (const p of spec.elf ?? []) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    const buf = Buffer.alloc(256, 0);
    buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
    writeFileSync(join(dir, p), buf);
  }
  git(dir, "init", "-q");
  git(dir, "add", "--", ...spec.commit);
  git(dir, "commit", "-qm", "init");
  if (spec.remote) {
    const bare = join(base, `${name}-remote.git`);
    git(base, "init", "-q", "--bare", bare);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "HEAD");
  }
  for (const [p, extra] of Object.entries(spec.modify ?? {})) writeFileSync(join(dir, p), readFileSync(join(dir, p), "utf8") + extra);
}

export interface Materialized {
  dir: string;
  base: string;
  cleanup: () => void;
}

export function materialize(name: string, overrides: Partial<RepoSpec> = {}): Materialized {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "undomap-")));
  const dir = join(base, name);
  const src = join(FIXTURES, name);
  cpSync(src, dir, { recursive: true, filter: (p) => !p.endsWith("fixture.json") });
  renameSpecial(dir);
  const spec = JSON.parse(readFileSync(join(src, "fixture.json"), "utf8"));
  if (spec.commit) makeRepo(dir, { ...spec, ...overrides }, base, name);
  for (const [sub, rs] of Object.entries((spec.repos ?? {}) as Record<string, RepoSpec>)) makeRepo(join(dir, sub), rs, base, sub);
  for (const [p, content] of Object.entries((spec.outside ?? {}) as Record<string, string>)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), content);
  }
  if (process.platform !== "win32")
    for (const [link, target] of Object.entries((spec.symlinks ?? {}) as Record<string, string>)) symlinkSync(resolve(dir, target), join(dir, link));
  return { dir, base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

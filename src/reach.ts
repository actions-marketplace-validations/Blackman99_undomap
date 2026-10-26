// Credential reach: the "lethal trifecta" for a workspace. When the process that runs here can read live
// credentials, reach the network and write outside the tree at once, a bad command can leak as well as erase.
//
// Value-blind by construction: credential files are only stat()ed / access()ed, never opened; environment
// variables are judged by NAME (plus "is it set"), and only the name is kept. Nothing here writes or connects.
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSecret, regenerable } from "./patterns.js";
import type { Finding, Fix, Reach, ReachCredential } from "./types.js";

export interface ReachOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  /** os.networkInterfaces() result (tests inject one). */
  interfaces?: ReturnType<typeof networkInterfaces>;
  /** Directory entries looked at in the tree before stopping (default 20k). */
  maxEntries?: number;
}

/** Well-known credential files under $HOME: [relative path, type]. Presence only. */
const HOME_FILES: [string, string][] = [
  [".aws/credentials", "AWS credentials"],
  [".config/gcloud/application_default_credentials.json", "Google Cloud credentials"],
  [".config/gcloud/credentials.db", "gcloud login"],
  [".azure/msal_token_cache.json", "Azure CLI tokens"],
  [".azure/accessTokens.json", "Azure CLI tokens"],
  [".kube/config", "Kubernetes config"],
  [".docker/config.json", "Docker registry auth"],
  [".config/gh/hosts.yml", "GitHub CLI token"],
  [".git-credentials", "git credential store"],
  [".netrc", "netrc passwords"],
  ["_netrc", "netrc passwords"],
  [".npmrc", "npm config, may hold a token"],
  [".pypirc", "PyPI config, may hold a token"],
  [".cargo/credentials.toml", "crates.io token"],
  [".terraform.d/credentials.tfrc.json", "Terraform Cloud token"],
  [".vault-token", "Vault token"],
  [".pgpass", "Postgres passwords"],
];

const ENV_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|CREDENTIALS?)$/i;
const ENV_EXACT: Record<string, string> = {
  AWS_SECRET_ACCESS_KEY: "AWS secret key",
  AWS_SESSION_TOKEN: "AWS session",
  GOOGLE_APPLICATION_CREDENTIALS: "path to Google credentials",
  DATABASE_URL: "database URL, may embed a password",
  SSH_AUTH_SOCK: "ssh-agent socket",
};
/** Names that look like credentials but only point at config, not at a secret. */
const ENV_NOT = /(_FILE|_PATH|_DIR|_URL_TEMPLATE|_HELPER)$|^(GPG_TTY|NPM_CONFIG_USERCONFIG)$/i;

/** Type of a credential-looking file or folder, from its name only. */
export function credentialType(name: string, dir: boolean): string {
  if (dir) return "credential folder";
  if (/^\.env/i.test(name)) return "dotenv";
  if (/^id_/i.test(name)) return "ssh key";
  if (/\.(pem|key|ppk|age)$/i.test(name)) return "private key";
  if (/\.(p12|pfx|jks|keystore)$/i.test(name)) return "keystore";
  if (/\.kdbx$/i.test(name)) return "password vault";
  if (/\.json$/i.test(name) && /^(credentials|service|client)/i.test(name)) return "cloud credentials";
  if (/^\.(npmrc|pypirc)$/i.test(name)) return "registry config, may hold a token";
  if (/^\.(netrc|pgpass|git-credentials)$/i.test(name)) return "password file";
  return "secrets file";
}

const readable = (p: string) => {
  try {
    accessSync(p, constants.R_OK); // access(2): a permission check, no open, no read
    const st = statSync(p);
    return st.isFile() || st.isDirectory();
  } catch {
    return false;
  }
};
const writable = (p: string) => {
  try {
    accessSync(p, constants.W_OK);
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const real = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};
const inside = (child: string, parent: string) => {
  const r = relative(parent, child);
  return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r));
};

/** Credential-looking names in the tree: a bounded, read-only directory walk (no file is opened). */
function treeCredentials(root: string, max: number): { found: ReachCredential[]; capped: boolean } {
  const found: ReachCredential[] = [];
  let seen = 0;
  const walk = (abs: string, rel: string, depth: number): boolean => {
    let ents;
    try {
      ents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return true;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (++seen > max) return false;
      const r = rel + e.name;
      if (e.isDirectory()) {
        if (e.name === ".git" || regenerable(r + "/")) continue;
        if (isSecret(r + "/")) {
          found.push({ path: r + "/", type: credentialType(e.name, true), where: "tree" });
          continue;
        }
        if (depth < 6 && !walk(join(abs, e.name), r + "/", depth + 1)) return false;
      } else if (e.isFile() && isSecret(r) && !/\.pub$/i.test(e.name)) {
        found.push({ path: r, type: credentialType(e.name, false), where: "tree" });
      }
    }
    return true;
  };
  const done = walk(root, "", 0);
  return { found, capped: !done };
}

function homeCredentials(home: string, platform: string, env: NodeJS.ProcessEnv): ReachCredential[] {
  const out: ReachCredential[] = [];
  const files = [...HOME_FILES];
  if (platform === "win32" && env.APPDATA) {
    const app = relative(home, env.APPDATA).split(sep).join("/");
    if (app && !app.startsWith("..")) files.push([`${app}/gcloud/application_default_credentials.json`, "Google Cloud credentials"]);
  }
  for (const [rel, type] of files) {
    const abs = join(home, ...rel.split("/"));
    if (readable(abs)) out.push({ path: abs, type, where: "home" });
  }
  const ssh = join(home, ".ssh");
  try {
    for (const name of readdirSync(ssh).sort())
      if ((/^id_[\w-]+$/.test(name) || /\.(pem|key)$/i.test(name)) && readable(join(ssh, name))) out.push({ path: join(ssh, name), type: "ssh key", where: "home" });
  } catch {
    /* no ~/.ssh */
  }
  return out;
}

/** Credential-looking environment variable names that are set. The value is never kept. */
export function envCredentials(env: NodeJS.ProcessEnv): ReachCredential[] {
  const out: ReachCredential[] = [];
  for (const name of Object.keys(env).sort()) {
    if (!env[name] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ENV_NOT.test(name)) continue;
    const exact = ENV_EXACT[name.toUpperCase()];
    if (exact || ENV_NAME.test(name)) out.push({ path: name, type: exact ?? "token-like name", where: "env" });
  }
  return out;
}

function network(env: NodeJS.ProcessEnv, ifs?: ReturnType<typeof networkInterfaces>): Reach["network"] {
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") return { status: "closed", detail: "Codex sandbox, network disabled" };
  let list: ReturnType<typeof networkInterfaces>;
  try {
    list = ifs ?? networkInterfaces();
  } catch {
    return { status: "unknown", detail: "can't list network interfaces" };
  }
  const up = Object.entries(list).filter(([, a]) => (a ?? []).some((x) => !x.internal && x.address));
  const proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].some((k) => env[k]);
  // Loopback plus a proxy is how sandboxes (Claude Code /sandbox, bwrap --unshare-net) hand out allow-listed egress.
  if (!up.length) return proxy ? { status: "unknown", detail: "loopback only, egress through a proxy whose allowlist undomap can't see" } : { status: "closed", detail: "loopback only" };
  const names = up.map(([n]) => n);
  return {
    status: "open",
    detail: `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""} ${names.length > 1 ? "have" : "has"} an address${proxy ? ", proxy set" : ""} (no connection attempted)`,
  };
}

function writableOutside(root: string, home: string, findings: Finding[]): Reach["writable"] {
  const out: Reach["writable"] = [];
  const seen = new Set<string>();
  const add = (abs: string, why: string) => {
    const r = real(abs);
    if (seen.has(r) || inside(r, root) || !writable(r)) return;
    seen.add(r);
    out.push({ path: r, why });
  };
  if (!inside(home, root)) add(home, "your home folder");
  const parent = dirname(root);
  if (parent !== root) add(parent, "the folder above the tree");
  for (const f of findings) if (f.kind === "symlink-escape" && f.target) add(f.target, `${f.path.replace(/\/+$/, "")} links there`);
  return out;
}

function reachFix(r: Omit<Reach, "fix" | "legs" | "trifecta">, legs: number, platform: string): Fix {
  const names = r.credentials.filter((c) => c.where === "env" && c.path !== "SSH_AUTH_SOCK").map((c) => c.path);
  const files = r.credentials.some((c) => c.where !== "env");
  if (legs < 3) {
    const missing = [!r.credentials.length && "no credentials", r.network.status !== "open" && "no network", !r.writable.length && "no writes outside the tree"].filter(Boolean).join(", ");
    return { say: `not all three at once (${missing}): a bad command can erase here, but not ship your keys out`, cost: "seconds" };
  }
  const sandbox = "sandbox the agent's commands so they write only this workspace and reach only allowed hosts (Codex --sandbox workspace-write, Claude Code /sandbox, a devcontainer)";
  if (names.length && platform !== "win32")
    return {
      say: files ? `break one leg: ${sandbox}; at least start it without the tokens` : "break one leg: start the agent from a shell without the tokens",
      run: `env ${names.map((n) => `-u ${n}`).join(" ")} "$SHELL"`,
      cost: files ? "minutes" : "seconds",
    };
  return { say: `break one leg: ${sandbox}`, cost: "minutes" };
}

/** Measure what the process running undomap can reach: run it the way your agent runs (same user, same sandbox). */
export function probeReach(root: string, findings: Finding[], opts: ReachOptions = {}): Reach {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = real(opts.home ?? homedir());
  const absRoot = real(root);
  const tree = treeCredentials(absRoot, opts.maxEntries ?? 20_000);
  const homeCreds = homeCredentials(home, platform, env).filter((c) => !inside(real(c.path), absRoot));
  const credentials = [...tree.found, ...homeCreds, ...envCredentials(env)];
  const base = { credentials, credentialsCapped: tree.capped, network: network(env, opts.interfaces), writable: writableOutside(absRoot, home, findings) };
  const legs = (credentials.length ? 1 : 0) + (base.network.status === "open" ? 1 : 0) + (base.writable.length ? 1 : 0);
  return { ...base, legs: legs as Reach["legs"], trifecta: legs === 3, fix: reachFix(base, legs, platform) };
}

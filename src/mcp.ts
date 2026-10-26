// Minimal MCP server (JSON-RPC 2.0, newline-delimited over stdio). Read-only tools only.
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fmtBytes } from "./bytes.js";
import { formatMarkdown } from "./format.js";
import { mapPath } from "./run.js";
import { VERSION } from "./version.js";

const PATH_PROP = { type: "string", description: "Directory to map (absolute, or relative to the server's working directory). Default: the working directory." };

export const TOOLS = [
  {
    name: "map_report",
    description:
      "Map which paths under a directory an AI coding agent could erase with no way back. Grades every significant path: Zone VE (permanent: gitignored or untracked and not regenerable, outside git, symlinks escaping the tree, repos with no remote), Zone AE (slow undo: regenerable build output, uncommitted edits, unpushed commits, covered by a local snapshot or by cloud-sync version history undomap could verify), Zone X (clean tracked files). Ranked by bytes, with the cheapest fix for each permanent place. With reach=true it also reports credential reach (the lethal trifecta): whether this process can read live credentials (.env files, cloud and ssh keys, token env var names; presence only, values are never read), reach the network and write outside the tree at once. Read-only: never writes, deletes or runs fixes.",
    inputSchema: {
      type: "object",
      properties: {
        path: PATH_PROP,
        reach: { type: "boolean", description: "also report credential reach (lethal trifecta) for the environment this server runs in. Default false." },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_permanent",
    description:
      "Just the Zone VE list: paths under a directory that would be lost forever if deleted or overwritten (no git history, no remote, no snapshot), biggest first, each with a one-line reason and the cheapest fix. Call this before running destructive commands (rm -rf, git clean -fdx, git reset --hard, checkpoint restore) to see what they could destroy. Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: PATH_PROP, limit: { type: "number", description: "max places to return (default 25)" } },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

type Json = Record<string, any>;

export function callTool(name: string, args: Json, cwd = process.cwd()): { text: string; isError?: boolean } {
  const path = resolve(cwd, typeof args.path === "string" && args.path ? args.path : ".");
  if (name === "map_report") {
    const r = mapPath(path, { reach: args.reach === true });
    return { text: formatMarkdown(r) + "\n\n```json\n" + JSON.stringify({ root: r.root, totals: r.totals, findings: r.findings.slice(0, 60), probes: r.probes, repos: r.repos, reach: r.reach }, null, 2) + "\n```" };
  }
  if (name === "list_permanent") {
    const limit = Math.max(1, Math.min(500, Number(args.limit ?? 25) || 25));
    const r = mapPath(path);
    const ve = r.findings.filter((f) => f.zone === "VE");
    return {
      text: JSON.stringify(
        {
          root: r.root,
          summary: ve.length ? `${fmtBytes(r.totals.VE.bytes)} across ${r.totals.VE.places} place(s) an agent can erase forever` : "nothing an agent can erase for good",
          permanent: ve.slice(0, limit).map((f) => ({ path: f.path, bytes: f.bytes, size: fmtBytes(f.bytes), kind: f.kind, why: f.why, secret: f.secret, forcedBy: f.forcedBy, cloud: f.cloud, fix: f.fix?.say, run: f.fix?.run })),
          more: Math.max(0, ve.length - limit),
        },
        null,
        2,
      ),
    };
  }
  return { text: `unknown tool ${name}`, isError: true };
}

export async function runMcp(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  const send = (m: Json) => process.stdout.write(JSON.stringify(m) + "\n");
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined || id === null) continue; // notification
    const reply = (result: Json) => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "undomap", version: VERSION },
        instructions:
          "Before destructive file operations, call list_permanent on the workspace to see which paths have no undo (no git history, no remote, no snapshot). map_report gives the full flood-zone map. Both are read-only.",
      });
    } else if (method === "ping") reply({});
    else if (method === "tools/list") reply({ tools: TOOLS });
    else if (method === "tools/call") {
      try {
        const r = callTool(params?.name, params?.arguments ?? {});
        reply({ content: [{ type: "text", text: r.text }], isError: !!r.isError });
      } catch (e) {
        reply({ content: [{ type: "text", text: `error: ${(e as Error).message}` }], isError: true });
      }
    } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

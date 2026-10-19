import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materialize } from "./helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("MCP stdio: initialize, tools/list, list_permanent, map_report", () => {
  const fx = materialize("textures-app");
  try {
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_permanent", arguments: { path: fx.dir, limit: 2 } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "map_report", arguments: { path: fx.dir } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf", arguments: {} } },
    ];
    const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), "mcp"], {
      input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n",
      encoding: "utf8",
      env: { ...process.env, UNDOMAP_SNAPSHOTS: "off", UNDOMAP_CLOUD: "off" },
    });
    const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    const by = Object.fromEntries(lines.map((l) => [l.id, l]));
    assert.equal(by[1].result.serverInfo.name, "undomap");
    assert.deepEqual(by[2].result.tools.map((t: any) => t.name), ["map_report", "list_permanent"]);
    assert.ok(by[2].result.tools.every((t: any) => t.annotations.readOnlyHint === true));
    const perm = JSON.parse(by[3].result.content[0].text);
    assert.equal(perm.permanent.length, 2);
    assert.equal(perm.permanent[0].path, "textures_sorted/");
    assert.equal(perm.more, 3);
    assert.match(by[4].result.content[0].text, /### undomap — .* across 5 places your agent can erase forever/);
    assert.equal(by[5].result.isError, true);
    assert.equal(lines.length, 5); // the notification got no reply
  } finally {
    fx.cleanup();
  }
});

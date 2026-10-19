import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError } from "./collect.js";
import type { Config } from "./grade.js";

/** Load <root>/.undomap.json (or an explicit file). Unknown keys are an error: typos should not silently grade data as safe. */
export function loadConfig(root: string, explicit?: string): { config: Config; file: string | null } {
  const file = explicit ?? join(root, ".undomap.json");
  if (!existsSync(file)) {
    if (explicit) throw new UsageError(`config not found: ${explicit}`);
    return { config: {}, file: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsageError(`${file}: expected an object like {"permanent": [], "regenerable": [], "backedUp": []}`);
  const out: Config = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if (k !== "regenerable" && k !== "backedUp" && k !== "permanent") throw new UsageError(`${file}: unknown key "${k}" (known: permanent, regenerable, backedUp)`);
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new UsageError(`${file}: "${k}" must be an array of path patterns`);
    out[k] = v as string[];
  }
  return { config: out, file };
}

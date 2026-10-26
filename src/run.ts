// Library entry: map a directory end to end.
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { collect, type CollectOptions } from "./collect.js";
import { loadConfig } from "./config.js";
import { grade, type Config } from "./grade.js";
import { probeReach, type ReachOptions } from "./reach.js";
import type { Report } from "./types.js";

export interface MapOptions extends CollectOptions {
  thresholdBytes?: number;
  config?: Config;
  configFile?: string;
  /** Add the credential-reach section (lethal trifecta). Opt-in; never changes the exit code. */
  reach?: boolean | ReachOptions;
}

export function mapPath(path: string, opts: MapOptions = {}): Report {
  // The config is read before the walk: `permanent` patterns change what collect sizes and probes.
  let config = opts.config;
  if (!config) {
    let root: string | undefined;
    try {
      root = statSync(path).isDirectory() ? realpathSync.native(resolve(path)) : undefined;
    } catch {
      /* collect reports the bad path */
    }
    if (root) config = loadConfig(root, opts.configFile).config;
  }
  const inv = collect(path, { ...opts, config });
  config ??= loadConfig(inv.root, opts.configFile).config;
  const report = grade(inv, { thresholdBytes: opts.thresholdBytes, config });
  if (opts.reach) report.reach = probeReach(report.root, report.findings, typeof opts.reach === "object" ? opts.reach : {});
  return report;
}

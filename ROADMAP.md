# Roadmap

## v0.1 — shipped (2026-10-15)

- `undomap [path]`: Zone VE / AE / X map from real git state (`status --porcelain=v2 -z`, ignored and untracked, `ls-files`, remotes, unpushed commits, submodules, nested repos).
- Content markers so regenerable things aren't reported as permanent: `pyvenv.cfg`, `CACHEDIR.TAG`, ELF/Mach-O/PE binaries, a known list of build and cache directories.
- Writable symlinks that leave the tree are counted as permanent.
- Snapshot probes: Time Machine (`tmutil`), btrfs/snapper, ZFS, Timeshift. The trash is reported but never counted (`rm`, `git clean` and `fs.rm` skip it).
- `--fix` (cheapest fix per place), `--json`, `--markdown`, `--all`, `--max-permanent`, `.undomap.json` (`regenerable`, `backedUp`).
- Exit codes 0 / 1 / 2, GitHub Action with a job summary and annotations, read-only MCP server (`map_report`, `list_permanent`).

## v0.2 — reach, not just reversibility

### Unreleased (on main)

- [x] **Cloud-sync versioning**: iCloud Drive, Dropbox, OneDrive and Google Drive folders are detected read-only (client config, env, folder names, `.dropbox` markers) and reported under probes. A path moves to Zone AE (`kind: "cloud"`) only when the client config points at the folder, the client is running and no known exclusion applies (Dropbox ignore attributes and `rules.dropboxignore`, temp/system/refused names, per-file size limits). iCloud keeps deletes but not overwrites, so it never demotes. Everything else stays Zone VE as "possible cloud versioning, unverified".
- [x] `permanent` overrides in `.undomap.json`: force a place into Zone VE even if it looks regenerable. A permanent folder inside a regenerable one is carved out with its own bytes. Precedence: git facts, then real coverage (`backedUp`, snapshots), then `permanent`, then regenerable guesses. JSON findings carry `forcedBy`.
- [x] **Credential reach / lethal trifecta** (`--reach`, MCP `map_report` `reach: true`): flags workspaces where the process can read live credentials, reach the network and write outside the tree at once (the conditions that turn a deletion into an exfiltration). Credentials by name and path only (tree files, well-known home files, `~/.ssh/id_*`, credential-like env var *names*), never values; network from interfaces with no connection attempted; writes outside from `access()` on home, the parent and symlink targets. Prints the cheapest leg to break. Opt-in, never changes the exit code.

### Planned

- Windows: VSS shadow-copy and File History probes.

## v0.3 — before and after the agent

- `undomap diff before.json after.json`: what moved between zones during a session.
- Agent hooks: run as a Claude Code / Codex pre-session hook and print one line when Zone VE grows.
- Per-agent profiles: read the agent's own allow-list (e.g. Claude Code `permissions`) and map only what it can write.

## v1.0

- Stable JSON schema (versioned) and MCP tool contracts.
- Signed release binaries alongside the npm package.
- A documented fix catalogue that other tools can reuse.

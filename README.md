<p align="center">
  <a href="https://blackman99.github.io/undomap/"><img src="site/logo-512.png" width="96" alt="undomap logo: a survey benchmark triangle half under orange flood water"></a>
</p>

<h1 align="center">undomap</h1>

<p align="center"><b>Which paths can your AI coding agent erase with no way back?</b><br>
One read-only command maps them as flood zones, ranked by the bytes you'd lose forever, with the cheapest fix for each.</p>

<p align="center">
  <a href="https://github.com/Blackman99/undomap/actions/workflows/ci.yml"><img src="https://github.com/Blackman99/undomap/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/Blackman99/undomap/releases"><img src="https://img.shields.io/github/v/release/Blackman99/undomap?color=d4600a" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f6a" alt="MIT"></a>
  <a href="https://blackman99.github.io/undomap/"><b>Live map →</b></a>
</p>

<p align="center"><img src="site/demo.gif" width="760" alt="undomap surveying a project: untracked and gitignored files land in Zone VE, each with a one-line fix"></p>

## Why

"The agent ran `rm -rf` / `git clean -fdx` / `git checkout .` and it's gone" is now a weekly post. `git` only protects what it tracks. The things people actually lose are the untracked folder of renders, the gitignored `.env`, the local SQLite database, the repo that was never pushed. You can't see any of that from `git status`.

undomap gives you the list **before** you hand an agent write access.

## 30-second start

```sh
cd your-project
npx github:Blackman99/undomap          # map it (Node ≥ 18.17, nothing to install)
npx github:Blackman99/undomap --fix    # plus the cheapest fix under every finding
```

Exit code `0` means nothing in Zone VE. `1` means something can be lost forever. `2` is a usage error.

## What you get

```text
▲ ZONE VE · PERMANENT
  2.4 GB across 5 places your agent can erase forever

  2.1 GB ██████████  renders/  untracked · 1 file
                     fix too big for git: copy it where the agent can't write, then snapshot that copy
                       $ mkdir -p -m 700 ~/.undomap-safe && rsync -a renders/ ~/.undomap-safe/textures-app-renders/
  380 MB █▊          data/     gitignored · 1 file
                     fix too big for git: copy it where the agent can't write, then snapshot that copy
                       $ mkdir -p -m 700 ~/.undomap-safe && rsync -a data/ ~/.undomap-safe/textures-app-data/
   27 KB ▏           .git/     repo with no remote: .git is the only copy of its history · 1 commit
                     fix .git is the only copy of the history: bundle it off-tree (or add a remote and push)
                       $ git bundle create ~/textures-app.bundle --all
    23 B ▏           .env      gitignored · looks like secrets
                     fix keep a copy outside the tree (password manager or ~/.config)
                       $ mkdir -p -m 700 ~/.undomap-safe && cp -Rp .env ~/.undomap-safe/textures-app-.env
     5 B ▏           notes/    untracked · 1 file
                     fix commit it, then git checkout brings it back
                       $ git add -- notes && git commit -m 'track notes'

▲ ZONE AE · SLOW UNDO   90 MB across 2 places — rebuild, restore or re-download
  90 MB  node_modules/  gitignored · regenerable (npm / pnpm / yarn install) · 1 file
   24 B  src/index.ts   tracked, uncommitted edits: last commit comes back, the edits don't

▲ ZONE X · UNDOABLE   41 B · 2 tracked files — git checkout / git restore

  probes  git ✓ 2.47.3  ·  snapshots ? not probed (--no-probe)

  whole map  snapshot the workspace: btrfs/ZFS with snapper, or restic/borg on a timer
    $ sudo snapper -c home create-config /home   # btrfs example
```

The zone letters come from FEMA flood maps:

| Zone | Meaning | What lands here |
|---|---|---|
| **VE** permanent | gone for good | gitignored or untracked and not regenerable, outside any repo, a repo with no remote, a writable symlink out of the tree, nothing snapshotting it |
| **AE** slow undo | recoverable, slowly | `node_modules/`, build output, venvs; uncommitted edits; unpushed commits; anything a detected snapshot or verified cloud version history covers |
| **X** undoable | one command away | clean tracked files: `git checkout` brings them back |

Secret-looking files (`.env`, keys, credentials) are always listed, even past the top 12, because they can't be regenerated.

## Everywhere you need it

**Scripts:** `--json` (stable schema) or `--markdown`. Use `--max-permanent 10MB` to tolerate a little.

**GitHub Actions:** maps the checkout and writes a job summary.

```yaml
- uses: actions/checkout@v5
- uses: Blackman99/undomap@v0
  with:
    fail-on-permanent: "false"   # just report
    max-permanent: "0"
```

Outputs: `permanent-bytes`, `permanent-places`, `slow-bytes`, `json`.

**Agents (MCP):** a read-only stdio server, so the agent can check before it deletes.

```json
{ "mcpServers": { "undomap": { "command": "npx", "args": ["-y", "github:Blackman99/undomap", "mcp"] } } }
```

Tools: `map_report` (the whole map) and `list_permanent` (just Zone VE).

**Config:** `.undomap.json` in the mapped directory tells undomap what it can't detect:

```json
{
  "permanent": ["dist/atlas/", ".cache/models/"],
  "regenerable": ["generated/"],
  "backedUp": ["media/"]
}
```

`permanent` forces a place into Zone VE even when its name or contents look regenerable (a hand-tuned folder under `dist/`, model weights in a cache). Precedence: what git knows (tracked, uncommitted, unpushed) wins, then real coverage (`backedUp`, a snapshot), then `permanent`, then any regenerable guess. See [configuration](https://blackman99.github.io/undomap/docs/configuration.html#precedence).

## Guarantees

- **Never writes.** No file in the mapped tree, `.git` or the index is touched. Git runs with `GIT_OPTIONAL_LOCKS=0`.
- **Snapshots are probed, not assumed.** Time Machine, btrfs/snapper, ZFS and Timeshift are checked. A probe that can't run is reported as unknown and never fails the map.
- **Cloud sync is verified, not trusted.** Inside an iCloud Drive, Dropbox, OneDrive or Google Drive folder, a path only moves to Zone AE when the client's own config points at the folder, the client is running, and none of the provider's known exclusions apply (Dropbox ignore attributes and `rules.dropboxignore`, `.nosync`/temp/system names, per-file size limits). iCloud keeps deletes but not overwrites, so it never demotes. Anything undomap can't confirm stays in Zone VE as "possible cloud versioning, unverified", with a one-line way to check. [Rules](https://blackman99.github.io/undomap/docs/reference.html#cloud).
- **No network.** No telemetry, no uploads.

## What it isn't

undomap is a survey, not a guard. It does not block commands, take backups, or recover deleted files. Pair it with your agent's permission settings, and with [agentckpt](https://github.com/Blackman99/agentckpt) for working-tree checkpoints. To find secrets *inside* agent transcripts, use [spillscan](https://github.com/Blackman99/spillscan). Scope: [GOAL.md](GOAL.md) · plans: [ROADMAP.md](ROADMAP.md).

## Docs

[Install](https://blackman99.github.io/undomap/docs/install.html) · [Usage](https://blackman99.github.io/undomap/docs/usage.html) · [Configuration](https://blackman99.github.io/undomap/docs/configuration.html) · [Reference](https://blackman99.github.io/undomap/docs/reference.html) · [FAQ](https://blackman99.github.io/undomap/docs/faq.html)

## Contributing

Bug reports with a `--json` excerpt are gold. See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

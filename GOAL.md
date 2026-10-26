# Goal

Tell you, in one command, which paths your AI coding agent can erase with no way back — ranked by permanent-loss bytes — and the cheapest fix for each.

## Who it is for

Developers and small teams who give Claude Code, Codex, Cursor, Cline, OpenCode or any other coding agent write access to a directory.

## In scope

- Grading every significant path under a directory into three zones:
  - **Zone VE (permanent)**: gitignored, untracked, outside any git repo, a repo with no remote, a writable symlink out of the tree, with no snapshot covering it.
  - **Zone AE (slow undo)**: regenerable (`node_modules/`, build output, venvs, compiled binaries), uncommitted edits to tracked files, unpushed commits, anything a detected snapshot covers.
  - **Zone X (undoable)**: clean tracked files: `git checkout` brings them back.
- Ranking Zone VE by bytes, with one concrete, cheapest fix per place (a command where there is one).
- Best-effort snapshot probes (Time Machine, btrfs/snapper, ZFS, Timeshift) and cloud-sync probes (iCloud Drive, Dropbox, OneDrive, Google Drive version history). A probe that can't run never fails the map.
- Credential reach (`--reach`, opt-in): whether the process can read live credentials, reach the network and write outside the tree at once, from names, paths and permissions only.
- Output for people (terminal), scripts (`--json`, exit codes), CI (GitHub Action, Markdown job summary) and agents (read-only MCP server).

## Out of scope

- Blocking commands. undomap is a survey, not a guard: pair it with your agent's permission settings or a command blocker.
- Taking backups or checkpoints itself (use `git`, [agentckpt](https://github.com/Blackman99/agentckpt), restic, Time Machine).
- Scanning for secrets in content (see [spillscan](https://github.com/Blackman99/spillscan)). undomap only flags secret-looking *files* as places that can't be regenerated.
- Post-mortem recovery of something already deleted.
- Writing anything. undomap never modifies the directory it maps, `.git`, or the index (`GIT_OPTIONAL_LOCKS=0`).

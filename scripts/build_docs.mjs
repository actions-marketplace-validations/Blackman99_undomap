// Generates site/docs/*.html. Edit content here, then: node scripts/build_docs.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "https://blackman99.github.io/undomap";
const pages = [
  ["index", "Overview", "What undomap answers, the three zones, and what it deliberately does not do."],
  ["install", "Install", "npx, global install, release tarball, requirements."],
  ["usage", "Usage", "Mapping a directory, --fix, --json, CI, the GitHub Action and the MCP server."],
  ["configuration", "Configuration", ".undomap.json, flags, thresholds and exit codes."],
  ["reference", "Reference", "Zones, finding kinds, cloud-sync rules, JSON schema, MCP tools."],
  ["faq", "FAQ", "Trash, Time Machine, cloud sync, why .git can be permanent, false positives."],
];

const C = {
index: `
<p class="lead">undomap tells you, in one command, which paths your AI coding agent can erase with no way back — ranked by permanent-loss bytes — and the cheapest fix for each.</p>
<pre><code>npx github:Blackman99/undomap</code></pre>
<h2>Why</h2>
<p>Agents with write access delete things: a checkpoint restore that cleans a gitignored folder (<a href="https://github.com/cline/cline/issues/15023">cline#15023</a>), a cleanup that takes a whole edit with it (<a href="https://news.ycombinator.com/item?id=50085323">HN, TV4</a>), a worktree removed with the work still inside. In every thread the question afterwards is the same: <em>what else could it have taken?</em> Command blockers try to stop the next <code>rm -rf</code>. undomap answers the question before the session starts.</p>
<h2>The three zones</h2>
<table>
<tr><th>Zone</th><th>Means</th><th>Examples</th></tr>
<tr><td><b class="ve">VE</b> permanent</td><td>Gone forever if deleted or overwritten</td><td>gitignored data and <code>.env</code>; untracked notes; folders outside any repo; symlinks that point outside; a repo with no remote</td></tr>
<tr><td><b class="ae">AE</b> slow undo</td><td>Comes back, at a cost</td><td><code>node_modules</code>, <code>dist</code>, <code>.venv</code>, compiled binaries; uncommitted edits; unpushed commits; anything inside a local snapshot</td></tr>
<tr><td><b class="x">X</b> undoable</td><td><code>git checkout</code> brings it back</td><td>clean tracked files</td></tr>
</table>
<p>The letters come from US flood insurance rate maps: Zone VE is the coastal high-hazard area where water moves fast, AE is the base floodplain, X is minimal risk.</p>
<h2>What it doesn't do</h2>
<ul><li>It doesn't block commands. Pair it with a guard (deny-lists, sandboxes) if you want that.</li>
<li>It doesn't take backups or checkpoints. It tells you where they're missing. <a href="https://github.com/Blackman99/agentckpt">agentckpt</a> is one option for checkpoints.</li>
<li>It never writes. git runs with <code>GIT_OPTIONAL_LOCKS=0</code>, so not even the index gets refreshed.</li></ul>
<p>Next: <a href="install.html">Install</a> · <a href="usage.html">Usage</a></p>`,
install: `
<h2>Run without installing</h2>
<pre><code>npx github:Blackman99/undomap            # map the current directory
npx github:Blackman99/undomap ~/code     # or any directory</code></pre>
<p>Requires <b>Node.js 18.17+</b> and <b>git</b> on <code>PATH</code>. Without git, undomap still runs but grades everything as outside git and tells you so. The package is one bundled file with no runtime dependencies.</p>
<h2>Install the command</h2>
<pre><code>npm install -g github:Blackman99/undomap
undomap --version</code></pre>
<p>Or download <code>undomap-0.1.0.tgz</code> from <a href="https://github.com/Blackman99/undomap/releases/latest">GitHub Releases</a> and run <code>npm install -g ./undomap-0.1.0.tgz</code>. It isn't on the npm registry yet. Once it is, <code>npx undomap</code> will work too.</p>
<h2>Platforms</h2>
<table><tr><th>OS</th><th>Snapshot probe</th></tr>
<tr><td>macOS</td><td><code>tmutil destinationinfo</code>, <code>listlocalsnapshots</code>, and <code>isexcluded</code> for each fragile path</td></tr>
<tr><td>Linux</td><td><code>findmnt</code> for the mount, then snapper (<code>.snapshots</code>), ZFS (<code>.zfs/snapshot</code>) and Timeshift</td></tr>
<tr><td>Windows</td><td>Shadow copies are reported as unknown, because <code>vssadmin</code> needs an admin shell</td></tr></table>
<p>Every platform also gets the read-only <a href="reference.html#cloud">cloud-sync probe</a> (iCloud Drive, Dropbox, OneDrive, Google Drive). It reads client config files, lists running apps (<code>ps</code> / <code>tasklist</code>) and reads the Dropbox ignore attribute (<code>xattr</code>, <code>getfattr</code> from the <code>attr</code> package on Linux, an NTFS stream on Windows).</p>`,
usage: `
<h2 id="map">Map a directory</h2>
<pre><code>undomap                    # current directory
undomap ~/code             # a folder of many repos: each repo is surveyed with git
undomap . --fix            # cheapest fix under every Zone VE place
undomap . --all            # every Zone VE place, not just the top 12</code></pre>
<p>The report leads with Zone VE: <code>{bytes} across {n} places your agent can erase forever</code>, biggest first. Secrets (<code>.env</code>, keys, credentials) are always listed, even when they're small. Zone AE and Zone X follow, then the probes that were run.</p>
<h2 id="fix">Fixes</h2>
<p>Each permanent place gets one fix, the cheapest that actually protects it. A few examples:</p>
<table><tr><th>Finding</th><th>Fix</th></tr>
<tr><td>untracked, small</td><td><code>git add -- notes && git commit</code></td></tr>
<tr><td>gitignored, small</td><td>tarball outside the tree (it's ignored on purpose, so don't commit it)</td></tr>
<tr><td>secret-looking</td><td>copy to a password manager or <code>~/.config</code></td></tr>
<tr><td>over 25 MB, or a binary/media file over 2 MB</td><td><code>rsync</code> to somewhere the agent can't write, plus snapshots</td></tr>
<tr><td>folder outside git</td><td><code>git init && git add -A && git commit</code></td></tr>
<tr><td>repo with no remote</td><td><code>git bundle create ~/repo.bundle --all</code></td></tr>
<tr><td>symlink out of the tree</td><td>map the target too, or replace the link with a copy</td></tr>
<tr><td>inside a sync folder undomap can't verify</td><td>the same fix, tagged "possible Dropbox versioning, unverified", plus one line per folder with the cheapest check (start the app, install <code>attr</code>, …)</td></tr></table>
<p>When no snapshot probe covers the map, one machine-level fix is added at the end: Time Machine, snapper or ZFS, or File History.</p>
<h2 id="json">JSON and Markdown</h2>
<pre><code>undomap --json > undomap.json      # also drop it on the landing page to draw your own map
undomap --markdown >> "$GITHUB_STEP_SUMMARY"</code></pre>
<h2 id="ci">Exit codes in scripts</h2>
<pre><code>undomap ~/agent-workspace || echo "something in Zone VE"
undomap . --max-permanent 1MB      # tolerate small things</code></pre>
<h2 id="action">GitHub Action</h2>
<p>Useful before an agent step on a self-hosted runner, a mounted volume or a long-lived dev box. On a fresh checkout everything is tracked, so the Action matters where state persists.</p>
<pre><code>- uses: Blackman99/undomap@v0
  id: map
  with:
    path: .                    # default
    fail-on-permanent: true    # default; false = warn only
    max-permanent: 0           # bytes allowed, e.g. 10MB
- run: echo "permanent=\${{ steps.map.outputs.permanent-bytes }}"</code></pre>
<p>Outputs: <code>permanent-bytes</code>, <code>permanent-places</code>, <code>slow-bytes</code>, <code>json</code>. The job summary gets the Zone VE table.</p>
<h2 id="mcp">MCP server</h2>
<pre><code>claude mcp add undomap -- npx -y github:Blackman99/undomap mcp</code></pre>
<pre><code>// Cursor / Cline / any MCP client
{ "mcpServers": { "undomap": { "command": "npx", "args": ["-y", "github:Blackman99/undomap", "mcp"] } } }</code></pre>
<p>Two read-only tools, <code>map_report</code> and <code>list_permanent</code>. Both take <code>path</code>, which defaults to the server's working directory. A good instruction for your agent: <em>before <code>rm -rf</code>, <code>git clean -fdx</code>, <code>git reset --hard</code> or a checkpoint restore, call list_permanent on the workspace.</em></p>`,
configuration: `
<h2>.undomap.json</h2>
<p>Optional, at the root you map (or pass <code>--config file</code>). It tells undomap what it can't detect.</p>
<pre><code>{
  "permanent": ["build/atlas/", ".cache/models/", "vendor/patched/"],
  "regenerable": ["generated/", "*.parquet", "data/cache/**"],
  "backedUp": ["media/", "Rushes/"]
}</code></pre>
<ul><li><code>permanent</code>: paths that can't be rebuilt even though they look like they can: a hand-tuned folder under <code>build/</code> or <code>dist/</code>, model weights in <code>.cache/models/</code>, a vendored patch, a prebuilt binary with no source. They're graded Zone VE with the reason "looks regenerable (…) but .undomap.json marks it permanent", and the JSON finding carries <code>"forcedBy": "&lt;pattern&gt;"</code>. A permanent folder inside a regenerable one is carved out as its own place, so <code>.cache/</code> stays Zone AE and <code>.cache/models/</code> shows up in Zone VE with its own bytes.</li>
<li><code>regenerable</code>: paths your scripts rebuild. They're graded Zone AE.</li>
<li><code>backedUp</code>: paths you back up some other way (restic, borg, rsync to a NAS, a versioned bucket). They're graded Zone AE with the reason "backed up per .undomap.json".</li></ul>
<h2 id="precedence">Precedence</h2>
<p>When rules disagree, the first one that applies wins:</p>
<ol><li><b>What git knows.</b> Clean tracked files are Zone X and uncommitted edits or unpushed commits are Zone AE, whatever the config says. <code>permanent</code> can't make git forget a commit.</li>
<li><b>Real coverage.</b> <code>backedUp</code>, a snapshot that covers the path, and <a href="reference.html#cloud">cloud version history undomap could verify</a> move it to Zone AE, even if it's also <code>permanent</code>: a copy really exists somewhere else. The reason says both ("marked permanent, but backed up per .undomap.json").</li>
<li><b><code>permanent</code></b> beats every "regenerable" guess: built-in folder names (<code>dist</code>, <code>.cache</code>, <code>vendor</code>…), content markers (<code>pyvenv.cfg</code>, <code>CACHEDIR.TAG</code>, ELF/Mach-O/PE headers) and your own <code>regenerable</code> list. If a path is on both of your lists, <code>permanent</code> wins.</li>
<li><b>Regenerable</b> (built-in or yours): Zone AE.</li>
<li>Everything else git doesn't hold: Zone VE.</li></ol>
<p>Pattern rules: <code>dir/</code> matches that directory at any depth, or anchored if it contains another slash (<code>a/dir/</code>). <code>*.ext</code> matches a basename. <code>a/**/b</code> matches across directories. Unknown keys are an error, so a typo can't silently grade your data as safe.</p>
<h2>Flags</h2>
<table><tr><th>Flag</th><th>Default</th><th></th></tr>
<tr><td><code>--fix</code></td><td>off</td><td>fix under every Zone VE place (otherwise only the biggest)</td></tr>
<tr><td><code>--json</code> / <code>--markdown</code></td><td>text</td><td>output format</td></tr>
<tr><td><code>--all</code></td><td>top 12</td><td>list every Zone VE place</td></tr>
<tr><td><code>--max-permanent &lt;size&gt;</code></td><td><code>0</code></td><td>permanent bytes allowed before exit 1: <code>512KB</code>, <code>10MB</code>, <code>1.5GB</code></td></tr>
<tr><td><code>--config &lt;file&gt;</code></td><td><code>&lt;path&gt;/.undomap.json</code></td><td>config file</td></tr>
<tr><td><code>--no-probe</code></td><td>probe</td><td>skip snapshot and cloud-sync probes (<code>UNDOMAP_CLOUD=off</code> skips only the cloud one)</td></tr>
<tr><td><code>--no-color</code></td><td>auto</td><td>also <code>NO_COLOR=1</code>. <code>FORCE_COLOR=1</code> forces color in pipes</td></tr></table>
<h2>Exit codes</h2>
<table><tr><td><code>0</code></td><td>nothing in Zone VE (or under <code>--max-permanent</code>)</td></tr><tr><td><code>1</code></td><td>something in Zone VE</td></tr><tr><td><code>2</code></td><td>usage error, unreadable root, invalid config</td></tr></table>`,
reference: `
<h2>Finding kinds</h2>
<table><tr><th>kind</th><th>zone</th><th>when</th></tr>
<tr><td><code>ignored</code></td><td>VE</td><td>gitignored, not regenerable (or regenerable-looking but listed under <code>permanent</code>)</td></tr>
<tr><td><code>untracked</code></td><td>VE</td><td>untracked, not regenerable</td></tr>
<tr><td><code>no-git</code></td><td>VE</td><td>outside every git work tree (<code>dir/</code>, or <code>*</code> for loose files)</td></tr>
<tr><td><code>symlink-escape</code></td><td>VE</td><td>a link inside the map whose target is outside it and writable by you; bytes are the target's</td></tr>
<tr><td><code>no-remote</code></td><td>VE</td><td>repo with commits and no remote: <code>.git</code> is the only copy</td></tr>
<tr><td><code>regenerable</code></td><td>AE</td><td>known build output by name, or by marker: <code>pyvenv.cfg</code>, <code>CACHEDIR.TAG</code>, ELF/Mach-O/PE headers</td></tr>
<tr><td><code>dirty</code></td><td>AE</td><td>tracked file with uncommitted changes</td></tr>
<tr><td><code>unpushed</code></td><td>AE</td><td>commits on local branches not on any remote</td></tr>
<tr><td><code>snapshot</code></td><td>AE</td><td>would be VE, but a snapshot probe covers it</td></tr>
<tr><td><code>backed-up</code></td><td>AE</td><td>would be VE, but <code>.undomap.json</code> says it's backed up</td></tr>
<tr><td><code>cloud</code></td><td>AE</td><td>would be VE, but it's in a sync folder whose version history undomap could verify (see <a href="#cloud">cloud sync</a>)</td></tr>
<tr><td><code>tracked</code></td><td>X</td><td>clean tracked files, one aggregate per repo</td></tr></table>
<h2 id="cloud">Cloud sync</h2>
<p>A sync client copies a delete to the cloud within seconds, so the real undo is the provider's version history and deleted-files bin. undomap only counts it when it can show the history covers the path. The probe is read-only and can't fail the map.</p>
<table><tr><th>Provider</th><th>Detected from</th><th>History</th><th>Known gaps (stay Zone VE)</th></tr>
<tr><td>Dropbox</td><td><code>~/.dropbox/info.json</code> (or <code>%APPDATA%</code>/<code>%LOCALAPPDATA%\\Dropbox\\info.json</code>) paths; weaker: a <code>.dropbox</code> marker above the map, <code>~/Dropbox*</code></td><td>versions and deleted files, 30+ days by plan</td><td><code>com.dropbox.ignored</code> / <code>com.apple.fileprovider.ignore#P</code> on the path or a folder above it; <code>rules.dropboxignore</code>; <code>desktop.ini</code>, <code>.DS_Store</code>, <code>~$…</code>, <code>.~…</code>, <code>~…tmp</code></td></tr>
<tr><td>OneDrive</td><td><code>%OneDrive%</code>, <code>%OneDriveConsumer%</code>, <code>%OneDriveCommercial%</code>, <code>~/Library/CloudStorage/OneDrive-*</code>; weaker: <code>~/OneDrive*</code></td><td>version history and recycle bin, 30 days (93 for work)</td><td>files over 250 GB; <code>.tmp</code>, <code>desktop.ini</code>, <code>.DS_Store</code>, <code>~$…</code>, <code>.lock</code>, <code>CON</code>/<code>NUL</code>/…, <code>_vti_</code>, <code>" * : &lt; &gt; ? |</code></td></tr>
<tr><td>Google Drive</td><td><code>~/Library/CloudStorage/GoogleDrive-*</code>, <code>G:\\My Drive</code>-style virtual drives; weaker: legacy <code>~/Google Drive</code></td><td>file versions for 30 days or 100 versions, trash for 30 days</td><td>files over 5 TB; <code>.tmp</code>, <code>desktop.ini</code>, <code>.DS_Store</code>, <code>~$…</code></td></tr>
<tr><td>iCloud Drive</td><td><code>~/Library/Mobile Documents</code> (macOS), <code>~/iCloudDrive</code> (Windows)</td><td>Recently Deleted keeps deleted files 30 days; <b>no older versions</b> of overwritten files</td><td>always: an overwrite is permanent. Also <code>*.nosync</code>, <code>*.tmp</code>, files over 50 GB</td></tr></table>
<p><b>The demotion rule.</b> A path moves to Zone AE (<code>kind: "cloud"</code>) only when all of these hold:</p>
<ol><li>the client's own config (Dropbox <code>info.json</code>, the OneDrive environment variables, the <code>~/Library/CloudStorage</code> folder the client creates) points at a folder containing it;</li>
<li>the client is running right now (<code>ps</code> / <code>tasklist</code>), so the folder isn't a stale copy;</li>
<li>no known gap applies to the path or any folder above it, and its largest file is under the provider's per-file limit;</li>
<li>for Dropbox, the ignore attribute could be read and isn't set, and <code>rules.dropboxignore</code> doesn't match.</li></ol>
<p>iCloud Drive never demotes: it keeps deletes but not overwrites, and an agent overwriting a file is as final as deleting it. Anything undomap can't confirm (client not running, a folder name or <code>.dropbox</code> marker with no client config, attributes it can't read) stays in Zone VE with <em>possible cloud versioning, unverified</em> in the reason, the probe line, and one <code>cloud sync</code> line under the report with the cheapest way to check. A snapshot or <code>backedUp</code> still wins over all of this.</p>
<p><b>What it can't see.</b> A paused sync, a full quota, or a subfolder <em>inside</em> a place that's marked ignored (undomap checks the place itself and the folders above it). If the client shows errors, treat cloud Zone AE as Zone VE. iCloud's Desktop &amp; Documents sync isn't detected, which only errs towards Zone VE.</p>
<h2>JSON</h2>
<pre><code>{
  "tool": "undomap", "version": "0.1.0", "root": "/home/me/app", "scannedAt": "…", "durationMs": 41,
  "repos": [{ "path": ".", "remote": "origin", "unpushed": 2, "branch": "main" }],
  "probes": [{ "name": "git", "status": "ok", "detail": "2.47.3", "counts": true }, …],
  "totals": { "VE": { "bytes": 1300000000, "places": 4, "files": 3155 }, "AE": {…}, "X": {…} },
  "findings": [{ "zone": "VE", "kind": "ignored", "path": "textures_sorted/", "bytes": 1300000000,
                 "files": 3112, "capped": false, "why": "gitignored", "secret": false,
                 "forcedBy": "textures_sorted/",   // only when a .undomap.json "permanent" pattern matched
                 "cloud": { "provider": "Dropbox", "status": "unverified", "note": "Dropbox app not running" },
                 "fix": { "say": "…", "run": "…", "cost": "minutes" } }, …],
  "skipped": [{ "path": "private/", "reason": "EACCES" }],
  "exitCode": 1, "thresholdBytes": 0
}</code></pre>
<p><code>cloud</code> is present for a path inside a sync folder: <code>status</code> is <code>covered</code> (graded AE), <code>unverified</code>, <code>partial</code> (iCloud: deletes only) or <code>gap</code> (the provider skips it); <code>note</code> says why. <code>forcedBy</code> is present when a <code>permanent</code> pattern from <code>.undomap.json</code> matched the path (see <a href="configuration.html#precedence">precedence</a>); <code>why</code> then says the config forced it. Paths are relative to <code>root</code>, use POSIX separators, and directories end in <code>/</code>. <code>capped: true</code> means sizing stopped at 250,000 entries for that place, so bytes is a lower bound (shown with a <code>+</code>). Remote URLs are never printed, only remote names, because URLs can carry tokens.</p>
<h2>MCP tools</h2>
<table><tr><th>tool</th><th>args</th><th>returns</th></tr>
<tr><td><code>map_report</code></td><td><code>path?</code></td><td>Markdown report + compact JSON</td></tr>
<tr><td><code>list_permanent</code></td><td><code>path?</code>, <code>limit?</code> (25)</td><td>JSON: summary, permanent[] with path, bytes, why, forcedBy, cloud, fix, run; more</td></tr></table>
<p>Both are annotated <code>readOnlyHint: true</code>, <code>destructiveHint: false</code>.</p>`,
faq: `
<h2>My files go to the Trash when I delete them. Isn't that an undo?</h2>
<p>Not for agents. <code>rm</code>, <code>rimraf</code>, Node's <code>fs.rm</code>, Python's <code>shutil.rmtree</code> and <code>git clean</code> all skip the Trash and Recycle Bin. In cline#15023 the Recycle Bin was empty. undomap shows the Trash under probes but never counts it.</p>
<h2>Why is a whole <code>.git</code> in Zone VE?</h2>
<p>If a repo has no remote, its history exists only in <code>.git</code>. One <code>rm -rf</code> of the project directory takes the files and every way back to them. A <code>git bundle</code> is a single file you can keep anywhere.</p>
<h2>Clean tracked files are "undoable". What if the agent deletes <code>.git</code> too?</h2>
<p>Then they're only as safe as your remote. That's why "no remote" is permanent and "unpushed commits" is slow undo. Zone X assumes <code>.git</code> survives, which is the common case for file-level edits and deletes.</p>
<h2>Time Machine is on. Why is something still in Zone VE?</h2>
<p>undomap asks <code>tmutil isexcluded</code> for each fragile path. Big folders (datasets, VM images, <code>~/code</code> itself) are often excluded on purpose. They show as VE with no snapshot.</p>
<h2>My project is in Dropbox / OneDrive / Google Drive / iCloud. Isn't that a backup?</h2>
<p>Partly. The client copies the agent's delete to the cloud within seconds, so the undo is the provider's version history (30 days on most plans). undomap detects the folder and counts that history only when it can verify it: the client's own config points there, the client is running, and the path isn't one the provider skips (Dropbox-ignored folders, <code>.nosync</code>, temp files, files over the size limit). iCloud Drive brings back deleted files but not overwritten ones, so it never counts. Everything else stays Zone VE, marked <em>possible cloud versioning, unverified</em>, with the check to run. <a href="reference.html#cloud">The full rules.</a> If you know better, list the folder under <code>backedUp</code>.</p>
<h2>It says my <code>dist/</code> is regenerable, but it isn't.</h2>
<p>Built-in names are a guess. List it under <code>permanent</code> in <code>.undomap.json</code> and it's graded Zone VE with a fix, even if it sits inside a regenerable folder (<code>"permanent": [".cache/models/"]</code> carves just that subfolder out). If it's protected some other way, use <code>backedUp</code> instead. See <a href="configuration.html#precedence">precedence</a>.</p>
<h2>Does it read file contents?</h2>
<p>Only the first 4 bytes of gitignored or untracked files, to spot compiled binaries. Everything else is <code>lstat</code> and git metadata. Nothing leaves your machine. The landing page draws dropped JSON in the browser tab.</p>
<h2>How is this different from agentckpt, blast-radius tools or command blockers?</h2>
<p>Blockers stop commands. Checkpoint tools (like <a href="https://github.com/Blackman99/agentckpt">agentckpt</a>) save state. Post-mortem tools read transcripts after the fact. undomap is the pre-flight audit: where would a mistake cost you something you can't get back?</p>`,
};

const nav = (cur) => pages.map(([id, t]) => `<li><a href="${id}.html"${id === cur ? ' aria-current="page"' : ""}>${t}</a></li>`).join("");
mkdirSync("site/docs", { recursive: true });
pages.forEach(([id, title, desc], i) => {
  const url = `${BASE}/docs/${id === "index" ? "" : id + ".html"}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · undomap docs</title>
<meta name="description" content="${desc}">
<link rel="canonical" href="${url}">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#cfdce3">
<meta property="og:type" content="article"><meta property="og:site_name" content="undomap">
<meta property="og:url" content="${url}"><meta property="og:title" content="undomap docs · ${title}"><meta property="og:description" content="${desc}">
<meta property="og:image" content="${BASE}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="undomap flood-zone survey map">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="undomap docs · ${title}"><meta name="twitter:description" content="${desc}"><meta name="twitter:image" content="${BASE}/og.png">
<link rel="stylesheet" href="docs.css"></head>
<body>
<header class="strip"><a class="mark" href="../"><img src="../favicon.svg" width="20" height="20" alt=""><span>undomap</span></a><p>DOCS · SHEET ${String(i + 1).padStart(2, "0")} OF ${String(pages.length).padStart(2, "0")}</p><nav><a href="../">Map</a><a href="https://github.com/Blackman99/undomap">GitHub</a></nav></header>
<div class="wrap"><nav class="side" aria-label="Docs"><p>Index of sheets</p><ol>${nav(id)}</ol></nav>
<main><h1>${title}</h1>${C[id]}
<p class="next">${i + 1 < pages.length ? `Next sheet: <a href="${pages[i + 1][0]}.html">${pages[i + 1][1]}</a>` : `Back to <a href="./">Overview</a>`}</p></main></div>
<footer class="foot">undomap 0.1.0 · MIT · <a href="https://github.com/Blackman99/undomap/issues">issues</a></footer>
</body></html>
`;
  writeFileSync(`site/docs/${id}.html`, html);
});
console.log("wrote", pages.length, "docs pages");

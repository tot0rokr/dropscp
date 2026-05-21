# dropscp

A browser-based SFTP file manager. Two side-by-side panes, drag-and-drop
between local and remote (and remote↔remote), multiple host tabs, batched
parallel transfers over a single SSH connection.

Built because WinSCP is blocked by the IT shop and typing `scp` by hand for
every file is tiring. Single-user, runs entirely on `127.0.0.1`. No SSH
keys (v1) — username + password only, password never persisted.

## Quick start

```bash
npm install
npm start
# open http://127.0.0.1:8765
```

That's it. The server binds only to loopback, so it won't be visible to
anything outside your machine.

## Installation

### Prerequisites

- **Node.js ≥ 20** (uses `node:net`, `fs.promises.rm`, modern `ssh2`).
- **A reachable SFTP server**. OpenSSH on the remote side is enough; no
  special agent or extra service required.
- **Windows is the assumed host platform** (paths like `%APPDATA%\dropscp`).
  Other platforms work — the config dir falls back to `~/.config/dropscp` —
  but Windows is where this gets used day-to-day.

### Setup

```bash
git clone <repo-url>
cd dropscp
npm install
npm start            # production-ish: just runs node server/index.js
# or
npm run dev          # node --watch — restarts on file changes
```

The first run creates `%APPDATA%\dropscp\config.json` with default values.
You can edit that file to change the port, worker count, or pre-seed
presets (see [Configuration](#configuration)).

### First connection

1. Open <http://127.0.0.1:8765>.
2. Click the **`+`** button (top-right of the tab bar).
3. Fill in `username`, `host`, `port`, `password`. Optionally **Save as
   preset** so the non-secret fields persist (the password never does).
4. Hit Connect. The left pane shows the remote home dir, the right shows
   your local home dir. Drag-and-drop between them to transfer.

## Features

| Feature | Notes |
|---|---|
| Side-by-side trees | Remote (left, active tab) and Local (right). Double-click a folder to navigate; `..` button to go up. |
| Drag-and-drop transfer | Local↔remote in either direction. Drop on the pane background → current folder; drop on a folder row → into that folder. |
| Folder transfers | Drop a folder: it's recursively walked and every leaf file is queued. Empty folders are not created on the destination (v1 limitation). |
| **Multi-select** | Click a row to select it; Ctrl/⌘-click to toggle; Shift-click to range-select. Clicking the pane background clears the selection. |
| **Multi-item drag** | If the row you start dragging is part of the selection, the whole selection drags. If not, the selection is replaced with just that row before the drag starts. |
| **Parallel transfers** | A batch drop dispatches leaf files across N workers, each holding its own SFTP channel multiplexed on the host's single SSH connection. Default 10 workers; configurable up to 10 (OpenSSH `MaxSessions` default). |
| **Conflict dialog** | If any item collides with an existing name on the destination, a single batch dialog asks Overwrite / Skip / Cancel. |
| **Per-file progress** | The status bar at the bottom has an aggregate progress bar plus a scrollable list with every queued file (icon, name, mini progress bar, status / bytes). Errors don't abort the batch. |
| **File type icons** | The tree and transfer list pick an emoji per extension (image, video, audio, archive, code, doc, executable, font, disk image). |
| **Presets** | Save the non-secret bits of a connection (name + user + host + port) to `config.json`. The login dialog has a dropdown to recall and a button to delete presets. |
| **Multi-host tabs** | One tab per open SSH session. `+` to add, `×` to close (terminates the session). Each tab keeps its own current path and tree state. |
| **R2R (remote↔remote)** | Toggle button in the top bar; right pane swaps from local to a second remote chosen via dropdown. Drops between the two remotes go through `/api/r2r`. v1 uses a local-relay strategy (src → local temp → dst); direct `scp` via `sshpass` is deferred (see [Roadmap](#roadmap)). |
| **Resizable splitter** | The divider between the two panes can be dragged to resize. Default 50/50, clamped to [0.1, 0.9], scales proportionally on window resize, not persisted. |

## Configuration

`%APPDATA%\dropscp\config.json` (override the directory with the
`DROPSCP_CONFIG_DIR` env var).

```json
{
  "version": 1,
  "server":   { "port": 8765, "bindHost": "127.0.0.1" },
  "transfer": { "workers": 10 },
  "presets": [
    { "name": "dev-vm", "username": "kim", "host": "10.0.0.5", "port": 22 }
  ],
  "ui": { "lastLocalPath": "C:\\Users\\you" }
}
```

- **`server.bindHost`** — kept as `127.0.0.1` by design. Exposing this on
  a real interface would let any process on the network use your SSH
  credentials.
- **`server.port`** — `8765` by default.
- **`transfer.workers`** — max SFTP channels per session. Clamped to
  `[1, 10]`. The effective cap is the remote server's `MaxSessions`
  (OpenSSH default = 10).
- **`presets[]`** — the login dropdown shows these. Edited via the UI
  (Save as preset / `×`); the file is rewritten atomically.
- The file is rewritten on every preset change. If it's ever unparseable,
  it gets moved to `config.json.bak` and a fresh default is written.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Browser (public/*)                                            │
│   - vanilla HTML/CSS/JS, no build step                        │
│   - panes, tabs, drag-and-drop, splitter                      │
│   - EventSource for transfer progress (SSE)                   │
└──────────────────────────────────────────────────────────────┘
                   │ HTTP + SSE on 127.0.0.1:8765
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Node backend (server/*)                                       │
│   index.js       Express app, routes, SSE wiring             │
│   config.js      load/save config.json, clamp helpers        │
│   ssh-session.js per-session SSH client + lazy SFTP pool     │
│   transfer.js    job model, worker pool, planning, relay     │
│   local-fs.js    local readdir / mkdir                       │
│   presets.js     CRUD over cfg.presets                       │
└──────────────────────────────────────────────────────────────┘
                   │ ssh2.Client (one TCP+SSH per session)
                   ▼
            ┌────────────────────┐
            │ Remote SFTP server │
            └────────────────────┘
```

A few load-bearing pieces:

- **One `ssh2.Client` per session, many SFTP channels.** When a batch
  starts, `acquireSftpPool(sessionId, n)` lazily opens up to `n` SFTP
  channels on that single SSH connection and caches them. Workers run on
  separate channels, so transfers run truly in parallel within the
  host's `MaxSessions`. Channels persist until the session is closed.
- **Job + leaves model.** Every transfer is a `job` with metadata plus
  `leaves: [{ id, name, size, transferred, status, error, phase? }]`.
  The planner walks any directory items in the input and pushes leaf
  jobs. Workers consume leaves off a shared index. Per-leaf status and
  transferred bytes are mutated in place; SSE snapshots project the
  array.
- **Two transfer endpoints, one job pipeline.** `/api/transfer` covers
  upload + download (one session). `/api/r2r` covers remote↔remote (two
  sessions). Both produce jobs with the same SSE event protocol so the
  UI's progress code is unified.
- **R2R relay.** Each leaf in an r2r job runs in two phases: SFTP
  download from src to `os.tmpdir()/dropscp-relay-<jobId>/<idx>`, then
  SFTP upload from that temp file to dst, then delete the temp file.
  The whole temp directory is `rm -rf`ed in a `finally` even on partial
  failure. `totalBytes` is set to `2 × sum(sizes)`, and each leaf carries
  a `phase` field so the UI can label the active operation.

## API reference

All requests are JSON unless noted. Errors come back as `{ "error": "..." }`
with status 400 / 401 / 404 / etc.

### Sessions

#### `POST /api/connect`

Open an SFTP session.

```json
{ "username": "kim", "host": "10.0.0.5", "port": 22, "password": "..." }
```

Returns `{ sessionId, username, host, port }`. The password is held in
memory only, never written to disk, never logged. `401` on auth/network
failure.

#### `POST /api/disconnect`

```json
{ "sessionId": "..." }
```

Closes the session and any SFTP channels.

### Browsing

#### `GET /api/ls?sessionId=...&path=/some/dir`

Lists a remote directory. Returns `{ path, entries: [{ name, isDirectory,
size, mtime }] }`. `path` is what the server resolved (so `'.'` becomes an
absolute path).

#### `POST /api/mkdir`

```json
{ "sessionId": "...", "path": "/some/new/dir" }
```

#### `GET /api/local/ls?path=C:/...`

Lists a local directory. Returns `{ path, entries: [{ name, isDirectory }] }`.
Path defaults to the user's home dir when omitted.

#### `POST /api/local/mkdir`

```json
{ "path": "C:/some/new/dir" }
```

### Presets

#### `GET /api/presets`

Returns `{ presets: [{ name, username, host, port }] }`.

#### `POST /api/presets`

Upsert a preset (replaces an existing preset by `name`):

```json
{ "name": "dev-vm", "username": "kim", "host": "10.0.0.5", "port": 22 }
```

#### `POST /api/presets/delete`

```json
{ "name": "dev-vm" }
```

Both return the updated `{ presets: [...] }`.

### Transfers

#### `POST /api/transfer` — local↔remote

```json
{
  "direction": "upload",                // "upload" | "download"
  "sessionId": "...",
  "items": [
    { "src": "C:/Users/me/foo.txt", "dst": "/home/kim/foo.txt" },
    { "src": "C:/Users/me/bar",     "dst": "/home/kim/bar"     }
  ],
  "workers": 8                          // optional, clamped to config
}
```

Returns `{ jobId }`. Each `item.dst` is the **final** path (including the
basename); directory items are walked recursively into leaf files whose
remote paths are derived from the dst root.

#### `POST /api/r2r` — remote↔remote (relay)

```json
{
  "srcSessionId": "...",
  "dstSessionId": "...",
  "items": [{ "src": "/srcabs/path", "dst": "/dstabs/path" }],
  "workers": 10
}
```

`srcSessionId` must differ from `dstSessionId`. Returns `{ jobId }`. The
job runs over the local relay; see [R2R relay](#architecture).

#### `GET /api/transfer/:jobId/events` — Server-Sent Events

Progress stream for any job (transfer or r2r). Three event types:

- **`progress`** — frequent (throttled to ~100 ms). Full job snapshot:
  ```json
  {
    "id": "...",
    "status": "running",
    "direction": "upload",            // or "download" | "r2r"
    "workers": 10,
    "totalBytes": 12345678,            // 2x for r2r jobs
    "transferredBytes": 8000000,
    "totalFiles": 42,
    "doneFiles": 17,
    "errors": [{ "src": "...", "message": "..." }],   // planning-stage
    "leaves": [
      {
        "id": 0,
        "name": "main.js",
        "size": 12345,
        "transferred": 12345,
        "status": "done",              // "waiting" | "active" | "done" | "error"
        "error": null,
        "phase": "upload"              // r2r only: "download" | "upload"
      }
    ]
  }
  ```
- **`done`** — `{ ok: true, errors: [...] }` once the batch finishes,
  even if individual leaves errored.
- **`fail`** — `{ message: "..." }` for fatal batch-level errors (e.g.,
  session not found, no SFTP channels). Per-leaf errors do **not**
  trigger `fail` — they live in the `errors` field of the final snapshot.

## Security model

- **Backend binds only to `127.0.0.1`.** Other machines on the LAN cannot
  see the server.
- **Passwords are never written.** Held in memory by the `ssh2` client
  during a session; not on disk, not in logs, not in `config.json`.
- **No `process.argv` exposure of credentials.** R2R will use `sshpass`
  with `SSHPASS` env-var passing when the direct path is added (M8); v1
  doesn't shell out at all.
- **Host key handling.** Currently uses `ssh2`'s defaults; PRD calls for a
  config-dir known-hosts file with first-seen pinning. Not yet enforced —
  see [Roadmap](#roadmap).
- **Per-launch token.** PRD §6 calls for a token attached to every API
  request to defend against drive-by requests from other local processes.
  Not yet implemented — see [Roadmap](#roadmap).

## File layout

```
dropscp/
├── PRD.md              product requirements (source of truth)
├── README.md           this file
├── package.json
├── server/
│   ├── index.js        Express app, routes
│   ├── config.js       config.json load/save, worker clamp
│   ├── ssh-session.js  per-session SSH + SFTP channel pool
│   ├── transfer.js     job model, planning, worker pool, relay
│   ├── local-fs.js     local readdir/mkdir
│   └── presets.js      preset CRUD
└── public/
    ├── index.html
    ├── style.css
    └── app.js          vanilla JS UI (no build step)
```

## Known limitations and quirks

- **Symlinks**. v1 follows symlinks (transfers the *target's* content) at
  the top level. Inside a recursive directory walk, symlinks are silently
  skipped on upload, and on download they're fetched (target content) if
  they point to a file or recorded as an error if they point to a
  directory. A symlink is never re-created on the destination as a
  symlink. Loops are safe (recursion stops at the first non-dir).
- **Empty directories**. The recursive walker only emits file leaves, so
  empty source directories aren't created on the destination.
- **Local listing has no size column**. `local-fs.js#ls` doesn't stat
  files; the tree shows a blank size for local files. Pre-existing from
  M2.
- **R2R direct mode is deferred.** v1 always relays through a local temp
  directory. See [PRD §3 F3-deferred decisions](PRD.md) for the open
  design choices (dst password caching, `sshpass` detection,
  `StrictHostKeyChecking`, SSE notice event, /api/r2r shape, relay
  progress accounting) so we can pick it up later.
- **No transfer cancel UI.** The status bar shows progress but there's no
  cancel button per job/leaf yet.
- **No persistence of session state across restarts.** SSH sessions live
  in backend memory keyed by `sessionId` and are gone if the Node
  process exits.

## Roadmap

Per [PRD.md](PRD.md):

| Milestone | Scope | Status |
|---|---|---|
| M1 | Backend skeleton: SSH connect, remote `ls`/`mkdir`, local `ls` | ✅ |
| M2 | HTML UI + side-by-side trees | ✅ |
| M3 | Drag-and-drop + progress | ✅ |
| M4 | Presets + config | ✅ |
| M5 | Multi-select + worker-pool concurrent transfer | ✅ |
| M6 | Multi-host tabs | ✅ |
| M7 | R2R via local relay only | ✅ |
| M8 (deferred) | R2R direct via `sshpass` | open |
| §6 | Per-launch API token, known-hosts pinning | open |

## License

MIT

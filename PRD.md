# PRD: dropscp — SFTP Drag-and-Drop Web App

## 1. Background & Goals

- Manually typing `scp` for every transfer is tedious.
- Goal: a browser-based tool with **side-by-side file trees** and
  **drag-and-drop** transfers between local and remote hosts.
- Top non-functional priority: **simplicity and maintainability**. Features are
  intentionally minimal.

## 2. Confirmed Decisions

| Item | Decision |
|---|---|
| Deployment | Single-user web app running on the user's machine (browser ↔ local backend) |
| Backend | Node.js + Express + `ssh2` |
| Frontend | Static HTML/CSS/JS, no build step |
| Auth | Username + password only (no SSH keys in v1) |
| File ops | Drag-and-drop transfer + `mkdir`. Same-host **move / rename / delete / copy** (see F8). |
| Remote ↔ remote | v1: local relay only (src → local temp → dst). Direct (`sshpass`) deferred — see F3 |
| Config | JSON file at `%APPDATA%\dropscp\config.json` |
| Host platform | Windows |
| Password storage | **Backend process memory only**, retained for the lifetime of the session so the backend can auto-reconnect on idle/network drop (see F7). Never written to disk, never logged, never exposed in API responses. |

## 3. Functional Requirements

### F1. Login & Presets

- Inputs: `username`, `host`, `port` (default 22), `password`.
- **Presets** save everything *except* the password under a user-chosen name.
- Preset CRUD (add / rename / overwrite / delete) persists to the config file.
- Login errors surface clearly (auth fail / host unreachable / timeout).

### F2. Side-by-side trees + local ↔ remote drag-and-drop

- Two trees displayed side-by-side: remote (active tab) and local.
- Tree UI: expand on click, navigate via double-click, parent (`..`), current
  path display.
- Drag-and-drop:
  - Remote → Local: SFTP `get`.
  - Local → Remote: SFTP `put`.
  - Folder drops transfer recursively.
- Per-file and overall transfer progress.
- Conflict on same-named file: dialog (overwrite / skip / cancel).
- `mkdir` button per side.
- **Multi-select**: Ctrl+click toggles an item in the selection, Shift+click
  range-selects, a plain click clears and selects just one. Selected rows
  get a visual highlight.
- **Multi-item drag**: dragging a row that is part of the selection drags
  the whole selection; dragging an unselected row drags only that row
  (and replaces the selection with it on `dragstart`).
- **Concurrent transfers**: a batch drop launches a **worker pool** that
  transfers files in parallel. Default 10 workers, configurable via
  `transfer.workers` in the config file (range 1–10). Each worker holds its
  own SFTP channel multiplexed on the host's single SSH connection. The
  effective upper bound is the remote server's `MaxSessions` (OpenSSH
  default is 10).
- Batch progress aggregates: total bytes, total files, files completed,
  and currently-active filenames across all workers. A batch finishes when
  every item has either completed or errored; individual errors are surfaced
  in a summary at the end without aborting the rest.
- Within a directory drop the recursive walk produces leaf-file jobs which
  feed the same worker pool, so a single folder also transfers in parallel.

### F3. Remote ↔ Remote transfer

- Toggle "R2R mode" to replace the local tree with a second remote tree
  (src on left, dst on right).
- **v1 scope: local-relay only.** Transfer goes src → local temp dir →
  dst, reusing the existing SFTP transfer engine. Temp files are deleted
  on completion (including failures).
- Direct mode (src host runs `scp`/`sftp` straight to dst via `sshpass`)
  is **deferred** — see *F3-deferred decisions* below.

### F3-deferred decisions (for the eventual direct-mode work)

When direct mode is added, these need to be resolved up front:

1. **Dst password handling.** Direct mode needs the destination host's
   password available on the src side. Two options:
   - (a) Cache the password in memory on the dst session object when the
     user first connects. PRD §6 ("memory only") permits this.
   - (b) Re-prompt the user for the dst password each R2R operation.
   - Tentative default: (a) — cache in memory.
2. **`sshpass` detection.** Probe `command -v sshpass` once on src session
   create and cache the result; if absent, R2R direct is unavailable for
   that src and we silently fall back to relay (the only path in v1).
3. **`StrictHostKeyChecking`.** First-time src→dst SSH from src will hit
   an unknown host key. Use `-o StrictHostKeyChecking=accept-new` so the
   src records the fingerprint on first use.
4. **SSE notice event.** When a planned direct attempt falls back to
   relay mid-job, push an `event: notice` over the existing SSE channel
   with the reason so the UI can surface it.
5. **`/api/r2r` shape.** Reuse the batch protocol:
   `{ srcSessionId, dstSessionId, items: [{src,dst}], workers }`.
   Same `jobId` + SSE progress events as `/api/transfer`.
6. **Progress accounting under relay.** Each leaf moves `2 × size` bytes
   (download then upload). Either double `totalBytes` and label phases,
   or keep `totalBytes = sum(size)` and animate twice. Tentative default:
   the former — clearer to the user.

### F4. Multi-host tabs

- Tab bar at the top; one tab per active SSH session (label: `user@host`).
- `+` opens login dialog; `×` closes a tab (terminates that SSH session).
- Switching tabs preserves each host's current path and tree state.

### F5. Configuration file

Path: `%APPDATA%\dropscp\config.json` (override via `DROPSCP_CONFIG_DIR`).

```json
{
  "version": 1,
  "server": { "port": 8765, "bindHost": "127.0.0.1" },
  "transfer": { "workers": 10 },
  "presets": [
    { "name": "dev-vm", "username": "kim", "host": "10.0.0.5", "port": 22 }
  ],
  "ui": { "lastLocalPath": "C:\\Users\\..." }
}
```

- Written atomically on every preset change.
- If the file is corrupt, back it up to `config.json.bak` and regenerate
  defaults.
- Passwords are never written.

### F6. Resizable pane split

- A draggable vertical splitter sits between the two panes.
- Default split is 50 / 50.
- Dragging the splitter resizes either side; the ratio is clamped to
  roughly [0.1, 0.9] so neither pane disappears.
- On window resize, both panes scale proportionally — the current
  ratio is preserved.
- Not persisted across reloads (resets to 50 / 50).

### F7. Auto-reconnect on idle/network drop

- A session is created with `POST /api/connect`. The backend retains the
  password in process memory (never disk, never response body) so it can
  silently reconnect if the underlying SSH connection drops (idle timeout,
  network blip, VPN reconnect).
- ssh2 `error` / `close` / `end` events mark the session as `dead`. The
  `sessionId` slot is **kept**; only the inner `Client` is replaced on
  reconnect, so tab references, R2R pairings, and in-flight UI state stay
  intact.
- Reconnect is **lazy**: it triggers on the next remote API call (ls,
  mkdir, transfer start, fileop, …) via an internal `ensureAlive`
  helper. Concurrent requests that hit a dead session share a single
  reconnect promise.
- UI: a dead tab is recoloured (red border) so the user can see the
  state. Pressing **Refresh** on a dead tab re-runs the listing, which
  in turn triggers the lazy reconnect — no separate "reconnect" button.
- Explicit `POST /api/disconnect` still deletes the slot — that is not a
  reconnect candidate.
- New endpoint: `GET /api/session/status?sessionId=…` →
  `{ status: "connected" | "dead" | "reconnecting" }`.
- Out of scope here: mid-stream retry inside a running transfer (a
  dropped transfer fails, the user restarts it and the next call
  reconnects). See M9.

### F8. Same-host file operations

Operations affecting a single host (local or remote), distinct from the
cross-host transfer engine:

- **Move**: rename across directories on the same host. Triggered by
  drag-and-drop **within the same pane**: drop on a folder moves into
  it; drop on the background moves to the current directory; drop in
  the same parent is a no-op.
- **Rename**: single-selection only. Header button prompts for a new
  name; performed as a rename in place.
- **Delete**: multi-selection allowed. Confirmation dialog required;
  directories are removed **recursively**; no trash.
- **Copy**: same pane only (cross-host copy is the existing transfer
  flow). On a remote host, performed via `ssh exec "cp -r -- SRC DST"`
  with safely-escaped arguments (POSIX remote required; Windows remote
  hosts are out of scope for copy). On local, `fs.cp({ recursive: true })`.

Header buttons on each pane: `Delete`, `Rename`, `Copy`. Enabled state
depends on the current selection (Rename: exactly 1; Copy/Delete: ≥ 1).

Single HTTP route: `POST /api/fileop` with
`{ side, sessionId?, op, ...args }` where `op ∈ {move, rename, delete, copy}`.
Operations respond synchronously; large recursive deletes/copies show a
spinner — no SSE job system for these (see scope note below).

Failures surface as a single error toast; partial-progress reporting for
large trees is **out of scope for this version** and may be promoted to
a job/SSE model later if needed.

## 4. Architecture

```
[Browser]
  ├─ HTML/JS UI (drag-and-drop, trees, tabs, multi-select)
  └─ HTTP + SSE  ←→  [Node Backend (127.0.0.1:8765)]
                        ├─ POST /api/connect                (open SSH; returns sessionId)
                        ├─ POST /api/disconnect
                        ├─ GET  /api/ls                     (remote directory listing)
                        ├─ POST /api/mkdir                  (remote)
                        ├─ POST /api/transfer               (start a batch; returns jobId)
                        ├─ GET  /api/transfer/:jobId/events (SSE progress/done/fail)
                        ├─ POST /api/r2r                    (remote↔remote via local relay; direct path deferred)
                        ├─ GET  /api/session/status         (connected | dead | reconnecting — see F7)
                        ├─ POST /api/fileop                 (same-host move/rename/delete/copy — see F8)
                        ├─ /api/presets                     (CRUD)
                        └─ /api/local/*                     (local filesystem)
```

- SSH sessions live in backend memory keyed by `sessionId` (lost on restart).
- Each session lazily opens an **SFTP channel pool** sized by
  `transfer.workers` (default 10). Channels are reused across batches and
  closed only when the session is closed.
- `/api/transfer` body shape:
  ```json
  {
    "direction": "upload" | "download",
    "sessionId": "...",
    "items": [{ "src": "...", "dst": "..." }, ...],
    "workers": 10
  }
  ```
  `workers` is optional and clamps to `[1, transfer.workers]`.
- Backend binds only `127.0.0.1`.
- *(Planned, not yet implemented)* A startup token will accompany every
  API call to defend against drive-by requests from other local
  processes. See §6.

## 5. UI Sketch

```
┌─────────────────────────────────────────────────────────────┐
│ [user@host1] [user@host2] [+]                       [R2R]   │  tabs + R2R toggle
├──────────────────────┬──┬──────────────────────────────────┤
│ Remote: /home/kim    │  │ Local: C:\Users\me\...           │
│ [..] [mkdir] [↻]     │  │ [..] [mkdir] [↻]                 │
│  📁 projects         │  │  📁 Downloads                    │
│  📁 logs             │  │  🖼 photo.png                    │
│  📜 readme.md        │  │  📄 file.txt                     │
├──────────────────────┴──┴──────────────────────────────────┤
│ Uploading (3/20) — main.js  ████████░░ 40%   8M / 20M      │
│  📜 main.js          ████████  done    12K                  │
│  🖼 photo.png        ████░░░░  62%     1.2M / 2M            │
│  🗜 archive.tar.gz   ░░░░░░░░  wait    5M                   │
└─────────────────────────────────────────────────────────────┘
```

The thin gap between panes is the draggable splitter (F6). In R2R mode
the right pane is replaced by a second remote host (picked via a
dropdown that appears in that pane's header).

## 6. Security

- Backend bound to `127.0.0.1` only. ✅
- Passwords held in **backend process memory** only — never written to
  disk, never logged, never sent back to the client. The password is
  retained for the session's lifetime to support auto-reconnect (F7);
  it is dropped when the session is explicitly disconnected or the
  backend process exits.
- **Host key handling** *(planned, not yet implemented)*. On first connect,
  store the fingerprint in a known-hosts file under the config directory;
  warn on mismatch. Currently uses `ssh2`'s defaults.
- R2R direct mode (deferred; see F3) uses `sshpass` with the password
  passed via env var (not as a CLI argument). If `sshpass` is not present
  on src, fall back to local relay. v1 always runs the relay path.
- **Per-launch token** *(planned, not yet implemented)*. A token will
  accompany every API request (passed as a query parameter on the
  initial page open) to defend against drive-by requests from other
  local processes.

## 7. Out of Scope (v1)

- SSH key authentication.
- File **edit / preview**. (Delete / rename / move / copy are in scope
  via F8 from M10 onward.)
- Trash / undo for deletes.
- Mid-stream retry of an in-flight transfer when the session drops
  (the next user-initiated call reconnects; see F7).
- Multi-user, authentication, sessions across restarts (the in-memory
  password is lost when the backend process exits).
- HTTPS, external deployment.
- Mobile UI.
- Transfer queue prioritization (within a batch, items are FIFO across
  available workers; there are no per-item priorities or pause/reorder).
- Copy on Windows remote hosts (the `cp -r` shell-out assumes POSIX).

## 8. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| M1 | Backend skeleton: SSH connect, remote ls/mkdir, local ls | curl can list a remote directory |
| M2 | HTML UI, single tab, side-by-side trees | Click navigation works |
| M3 | Drag-and-drop upload/download + progress | 1 GB file transfers successfully |
| M4 | Presets + config file | Presets restore after restart |
| M5 | Multi-select + worker-pool concurrent transfer | 20-file batch transfers with 10 workers in parallel; per-batch aggregate progress works; one failing item does not abort the rest |
| M6 | Multi-tab | Two remote hosts open simultaneously |
| M7 | R2R via local relay only | A file copies src → local temp → dst; temp cleaned up; errors surfaced per leaf |
| M8 (deferred) | R2R direct via `sshpass` | See §3 F3-deferred decisions |
| M9 | Auto-reconnect on idle/network drop (F7) | A killed sshd session reconnects on next ls/transfer; tab turns red while dead and recovers; concurrent dead-session requests share a single reconnect |
| M10 | Same-host file ops: move / rename / delete / copy (F8) | Drag within a pane moves; Delete/Rename/Copy header buttons work on local and remote; recursive directory delete works; cp on remote uses safely-escaped exec |

## 9. Dependencies

- Runtime: `express`, `ssh2`. (Progress streaming uses native SSE via
  `EventSource`, not WebSockets.)
- Optional on remote src host, **only when M8 ships**: `sshpass` (enables
  R2R direct mode; absent → local-relay fallback). v1 doesn't shell out
  at all.

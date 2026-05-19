# PRD: dropscp — SFTP Drag-and-Drop Web App

## 1. Background & Goals

- WinSCP is blocked by corporate security software; manually typing `scp` for
  every transfer is tedious.
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
| File ops | Drag-and-drop transfer + `mkdir`. No delete/rename. |
| Remote ↔ remote | Try direct (src → dst via ssh); on failure auto-fall-back to local relay |
| Config | JSON file at `%APPDATA%\dropscp\config.json` |
| Host platform | Windows |
| Password storage | **Never**. Re-entered each session. |

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

### F3. Remote ↔ Remote transfer

- Toggle "R2R mode" to replace the local tree with a second remote tree
  (src on left, dst on right).
- Transfer strategy:
  1. **Direct**: SSH into src and run `scp`/`sftp` to push to dst. dst password
     is passed via env var to `sshpass` (avoids process-arg leak).
  2. **Local relay (auto-fallback)**: if direct fails for any reason, transfer
     via the local machine to a temp directory, then up to dst. User is
     notified that the fallback fired. Temp files are deleted on completion.

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

## 4. Architecture

```
[Browser]
  ├─ HTML/JS UI (drag-and-drop, trees, tabs)
  └─ HTTP / WebSocket  ←→  [Node Backend (127.0.0.1:8765)]
                              ├─ POST /api/connect       (open SSH; returns sessionId)
                              ├─ POST /api/disconnect
                              ├─ GET  /api/ls            (remote directory listing)
                              ├─ POST /api/mkdir         (remote)
                              ├─ WS   /transfer          (up/download with progress)
                              ├─ POST /api/r2r           (remote↔remote w/ auto-fallback)
                              ├─ /api/presets            (CRUD)
                              └─ /api/local/*            (local filesystem)
```

- SSH sessions live in backend memory keyed by `sessionId` (lost on restart).
- Backend binds only `127.0.0.1`.
- A startup token is required on every API call to defend against drive-by
  requests from other local processes.

## 5. UI Sketch

```
┌─────────────────────────────────────────────────────────┐
│ [user@host1] [user@host2] [+]               [R2R mode]  │  tabs
├──────────────────────┬──────────────────────────────────┤
│ Remote: /home/kim    │ Local: C:\Users\me\...           │
│ [..] [mkdir] [↻]     │ [..] [mkdir] [↻]                 │
│  📁 projects         │  📁 Downloads                    │
│  📁 logs             │  📄 file.txt                     │
│  📄 readme.md        │                                  │
├─────────────────────────────────────────────────────────┤
│ Transfer: readme.md  ████████░░ 80%   cancel            │
└─────────────────────────────────────────────────────────┘
```

In R2R mode the right pane shows the second remote host instead of local.

## 6. Security

- Backend bound to `127.0.0.1` only.
- Passwords held in memory only — never written to disk, never logged.
- Host key handling: on first connect, store fingerprint in a known-hosts file
  under the config directory. Warn on mismatch.
- R2R direct mode uses `sshpass` with the password passed via env var (not as
  a CLI argument). If `sshpass` is not present on src, fall back to local
  relay.
- A per-launch token must accompany every API request (passed as a query
  parameter on the initial page open).

## 7. Out of Scope (v1)

- SSH key authentication.
- File delete / rename / edit / preview.
- Multi-user, authentication, sessions across restarts.
- HTTPS, external deployment.
- Mobile UI.
- Transfer queue prioritization (transfers run sequentially).

## 8. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| M1 | Backend skeleton: SSH connect, remote ls/mkdir, local ls | curl can list a remote directory |
| M2 | HTML UI, single tab, side-by-side trees | Click navigation works |
| M3 | Drag-and-drop upload/download + progress | 1 GB file transfers successfully |
| M4 | Presets + config file | Presets restore after restart |
| M5 | Multi-tab | Two remote hosts open simultaneously |
| M6 | R2R direct + local-relay fallback | Both paths verified |

## 9. Dependencies

- `express`, `ssh2`, `ws`
- Optional on remote src host: `sshpass` (enables R2R direct mode; absent →
  local-relay fallback).

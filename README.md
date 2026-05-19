# dropscp

A simple SFTP drag-and-drop web app for moving files between local and remote
hosts, built because WinSCP is blocked by corporate security software.

Runs entirely on `127.0.0.1`. Single-user. No SSH keys (v1).

## Status

M1 — backend skeleton: SSH connect, remote `ls`, remote `mkdir`, local `ls`.

## Run

```
npm install
npm start
```

Then open <http://127.0.0.1:8765>.

## Smoke test (M1)

```
curl -X POST http://127.0.0.1:8765/api/connect \
  -H "Content-Type: application/json" \
  -d '{"username":"user","host":"10.0.0.5","password":"..."}'
# => { "sessionId": "..." }

curl "http://127.0.0.1:8765/api/ls?sessionId=...&path=."
```

## Roadmap

See [PRD.md](PRD.md) for the full plan. Milestones: M1 backend → M2 UI →
M3 drag-and-drop transfer → M4 presets → M5 multi-tab → M6 remote-to-remote.

## License

MIT

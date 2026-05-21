# dropscp

*[← English](README.md)*

브라우저로 쓰는 SFTP 파일 매니저. 좌우 두 패널, 로컬↔원격 드래그 앤 드롭
(원격↔원격까지), 여러 호스트 탭, 하나의 SSH 연결 위에서 병렬로 도는 배치
전송.

회사에서 WinSCP가 막혀있고 매번 `scp`를 손으로 치는 게 피곤해서 만든 도구.
싱글유저, 전적으로 `127.0.0.1`에서만 동작. SSH 키는 v1에서 미지원 — 사용자
이름 + 비밀번호 인증만, 비밀번호는 디스크에 절대 저장하지 않음.

## 빠른 시작

```bash
npm install
npm start
# http://127.0.0.1:8765 로 접속
```

끝. 루프백에만 바인딩하므로 다른 머신에서는 보이지 않습니다.

## 설치

### 사전 요구사항

- **Node.js ≥ 20** (`node:net`, `fs.promises.rm`, 최신 `ssh2` 사용).
- **접근 가능한 SFTP 서버**. 원격 측에 OpenSSH 깔려있으면 충분. 별도 에이전트나
  추가 서비스 불필요.
- **Windows를 가정**한 호스트 플랫폼 (`%APPDATA%\dropscp` 경로). 다른 OS도
  동작 — 설정 디렉터리가 `~/.config/dropscp`로 폴백 — 다만 일상적으로 굴리는
  환경은 Windows.

### 셋업

```bash
git clone <repo-url>
cd dropscp
npm install
npm start            # 그냥 node server/index.js 실행
# 또는
npm run dev          # node --watch — 파일 변경 시 재시작
```

첫 실행 시 `%APPDATA%\dropscp\config.json`이 기본값으로 생성됩니다. 포트,
워커 개수, 미리 만들어둘 preset 등을 거기서 편집할 수 있습니다 (아래
[설정](#설정) 참조).

### 첫 접속

1. <http://127.0.0.1:8765> 열기.
2. 탭바 우상단의 **`+`** 클릭.
3. `username`, `host`, `port`, `password` 입력. **Save as preset** 누르면
   비밀번호 제외 모든 항목이 저장됨 (비밀번호는 절대 저장 안 됨).
4. Connect. 좌측 패널이 원격 홈디렉터리, 우측이 로컬 홈디렉터리를
   보여줍니다. 양쪽 사이로 드래그 앤 드롭하면 전송.

## 기능

| 기능 | 설명 |
|---|---|
| 좌우 트리 | 원격 (좌, 활성 탭) + 로컬 (우). 폴더 더블클릭으로 진입, `..` 버튼으로 상위. |
| 드래그 앤 드롭 전송 | 로컬↔원격 양방향. 패널 배경에 드롭 → 현재 폴더, 폴더 행에 드롭 → 해당 폴더 안. |
| 폴더 전송 | 폴더 드롭 시 재귀 워크해서 모든 leaf 파일을 큐에. 빈 디렉터리는 대상에 생성되지 않음 (v1 제약). |
| **멀티 셀렉트** | 클릭으로 선택, Ctrl/⌘-클릭으로 토글, Shift-클릭으로 범위 선택. 패널 배경 클릭하면 해제. |
| **멀티 드래그** | 드래그 시작한 행이 선택 안에 있으면 선택 전체가 끌림. 선택 밖이면 그 행 하나로 선택이 교체된 뒤 드래그. |
| **병렬 전송** | 배치 드롭이 N개의 워커로 leaf 파일을 분배. 각 워커는 호스트의 단일 SSH 연결 위에 자기 SFTP 채널을 멀티플렉싱. 기본 10, 최대 10 (OpenSSH `MaxSessions` 기본값). |
| **충돌 다이얼로그** | 배치 안에서 대상에 같은 이름이 하나라도 있으면 한 번에 묶어서 Overwrite / Skip / Cancel 묻기. |
| **파일별 진행률** | 하단 상태바에 집계 진행바 + 모든 큐 파일을 보여주는 스크롤 리스트 (아이콘, 이름, 미니 진행바, 상태/바이트). 개별 실패는 배치를 중단시키지 않음. |
| **파일 타입 아이콘** | 트리와 전송 리스트가 확장자 기반으로 이모지 픽 (이미지, 비디오, 오디오, 압축, 코드, 문서, 실행파일, 폰트, 디스크 이미지). |
| **Preset** | 비밀번호 제외 연결 정보 (name + user + host + port)를 `config.json`에 저장. 로그인 다이얼로그에서 dropdown으로 불러오기, 휴지통 아이콘으로 삭제. |
| **멀티 호스트 탭** | 활성 SSH 세션마다 탭 1개. `+`로 추가, `×`로 닫음 (세션 종료). 각 탭이 현재 경로와 트리 상태를 자기 안에서 유지. |
| **R2R (원격↔원격)** | 상단바 토글; 우측 패널이 로컬에서 두 번째 원격으로 바뀜 (드롭다운으로 호스트 선택). 두 원격 사이의 드롭은 `/api/r2r`로 감. v1은 로컬 릴레이 전략 (src → 로컬 임시 → dst); `sshpass` direct는 deferred ([로드맵](#로드맵) 참조). |
| **리사이저블 스플리터** | 두 패널 사이의 줄을 드래그해 크기 조절. 기본 50/50, [0.1, 0.9]로 클램프, 창 크기에 비례 스케일, 저장 안 됨. |

## 설정

`%APPDATA%\dropscp\config.json` (`DROPSCP_CONFIG_DIR` 환경변수로 디렉터리
재정의 가능).

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

- **`server.bindHost`** — 의도적으로 `127.0.0.1` 고정. 실제 NIC에 노출하면 같은
  네트워크의 다른 프로세스가 내 SSH 자격으로 명령을 보낼 수 있음.
- **`server.port`** — 기본 `8765`.
- **`transfer.workers`** — 세션당 최대 SFTP 채널 수. `[1, 10]`로 클램프.
  실효 상한은 원격 서버의 `MaxSessions` (OpenSSH 기본 10).
- **`presets[]`** — 로그인 dropdown에서 보이는 항목. UI를 통해 편집
  (Save as preset / `×`); 파일은 원자적으로 다시 쓰임.
- preset 변경마다 파일 재작성. 파싱 불가 상태가 되면 `config.json.bak`로
  옮기고 기본값으로 재생성.

## 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│ Browser (public/*)                                            │
│   - 빌드 스텝 없는 vanilla HTML/CSS/JS                        │
│   - 패널, 탭, DnD, 스플리터                                   │
│   - 전송 진행률은 EventSource (SSE)                           │
└──────────────────────────────────────────────────────────────┘
                   │ HTTP + SSE on 127.0.0.1:8765
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Node 백엔드 (server/*)                                        │
│   index.js       Express 앱, 라우트, SSE 와이어링            │
│   config.js      config.json 로드/저장, 클램프 헬퍼          │
│   ssh-session.js 세션별 SSH 클라이언트 + lazy SFTP 풀        │
│   transfer.js    job 모델, 워커 풀, planning, 릴레이         │
│   local-fs.js    로컬 readdir / mkdir                         │
│   presets.js     cfg.presets CRUD                            │
└──────────────────────────────────────────────────────────────┘
                   │ ssh2.Client (세션당 TCP+SSH 1개)
                   ▼
            ┌────────────────────┐
            │ 원격 SFTP 서버     │
            └────────────────────┘
```

핵심 동작 몇 가지:

- **세션당 `ssh2.Client` 하나, 그 위에 SFTP 채널 여러 개.** 배치 시작 시
  `acquireSftpPool(sessionId, n)`이 lazy로 최대 `n`개의 SFTP 채널을 그 단일
  SSH 연결 위에 열고 캐시합니다. 워커들은 서로 다른 채널에서 돌아 호스트의
  `MaxSessions` 한도 안에서 진짜로 병렬 전송. 채널은 세션이 닫힐 때까지 유지.
- **Job + leaves 모델.** 모든 전송은 job 1개에 메타데이터 +
  `leaves: [{ id, name, size, transferred, status, error, phase? }]`. 플래너가
  디렉터리 아이템을 재귀로 펼쳐 leaf job을 push, 워커들이 공유 인덱스를 통해
  leaf를 가져감. 진행 바이트와 상태는 leaf 객체에서 in-place로 갱신, SSE
  스냅샷이 이 배열을 그대로 투영.
- **두 전송 endpoint, 같은 job 파이프라인.** `/api/transfer`는 업/다운로드
  (세션 1개). `/api/r2r`은 원격↔원격 (세션 2개). 둘 다 같은 SSE 이벤트
  프로토콜로 job을 만들기 때문에 UI 진행률 코드는 하나로 통일.
- **R2R 릴레이.** r2r job의 leaf는 두 phase로 동작: src에서 SFTP로
  `os.tmpdir()/dropscp-relay-<jobId>/<idx>`로 다운로드 → 그 임시 파일을 dst로
  SFTP 업로드 → 임시 파일 삭제. 임시 디렉터리는 부분 실패 상황에서도
  `finally` 블록에서 통째로 `rm -rf`. `totalBytes`는 `2 × sum(sizes)`로 잡고,
  각 leaf의 `phase` 필드로 UI가 현재 단계를 라벨링.

## API 레퍼런스

요청·응답 모두 JSON. 에러는 `{ "error": "..." }` 형식에 status 400 / 401 /
404 등.

### 세션

#### `POST /api/connect`

SFTP 세션을 엽니다.

```json
{ "username": "kim", "host": "10.0.0.5", "port": 22, "password": "..." }
```

`{ sessionId, username, host, port }` 반환. 비밀번호는 메모리에만 보관, 디스크
저장·로그 기록 없음. 인증/네트워크 실패 시 `401`.

#### `POST /api/disconnect`

```json
{ "sessionId": "..." }
```

세션과 그 안의 SFTP 채널들을 닫음.

### 탐색

#### `GET /api/ls?sessionId=...&path=/some/dir`

원격 디렉터리 목록.
`{ path, entries: [{ name, isDirectory, size, mtime }] }` 반환. `path`는 서버가
실제로 resolve한 경로 (예: `'.'`는 절대 경로로 변환됨).

#### `POST /api/mkdir`

```json
{ "sessionId": "...", "path": "/some/new/dir" }
```

#### `GET /api/local/ls?path=C:/...`

로컬 디렉터리 목록. `{ path, entries: [{ name, isDirectory }] }` 반환. path
생략 시 사용자 홈디렉터리.

#### `POST /api/local/mkdir`

```json
{ "path": "C:/some/new/dir" }
```

### Preset

#### `GET /api/presets`

`{ presets: [{ name, username, host, port }] }` 반환.

#### `POST /api/presets`

Preset upsert (같은 `name` 있으면 교체):

```json
{ "name": "dev-vm", "username": "kim", "host": "10.0.0.5", "port": 22 }
```

#### `POST /api/presets/delete`

```json
{ "name": "dev-vm" }
```

양쪽 모두 갱신된 `{ presets: [...] }` 반환.

### 전송

#### `POST /api/transfer` — 로컬↔원격

```json
{
  "direction": "upload",                // "upload" | "download"
  "sessionId": "...",
  "items": [
    { "src": "C:/Users/me/foo.txt", "dst": "/home/kim/foo.txt" },
    { "src": "C:/Users/me/bar",     "dst": "/home/kim/bar"     }
  ],
  "workers": 8                          // 선택, config 상한으로 클램프
}
```

`{ jobId }` 반환. 각 `item.dst`는 **최종** 경로 (basename 포함). 디렉터리
아이템은 재귀 워크되어 leaf 파일들이 되고, 그들의 원격 경로는 dst 루트에서
파생됨.

#### `POST /api/r2r` — 원격↔원격 (릴레이)

```json
{
  "srcSessionId": "...",
  "dstSessionId": "...",
  "items": [{ "src": "/srcabs/path", "dst": "/dstabs/path" }],
  "workers": 10
}
```

`srcSessionId`와 `dstSessionId`는 달라야 함. `{ jobId }` 반환. job은 로컬
릴레이로 동작 ([R2R 릴레이](#아키텍처) 참조).

#### `GET /api/transfer/:jobId/events` — Server-Sent Events

전송 job (일반/r2r 동일) 진행률 스트림. 이벤트 세 종류:

- **`progress`** — 자주 (약 100 ms 스로틀). 전체 job 스냅샷:
  ```json
  {
    "id": "...",
    "status": "running",
    "direction": "upload",            // 또는 "download" | "r2r"
    "workers": 10,
    "totalBytes": 12345678,            // r2r은 2x
    "transferredBytes": 8000000,
    "totalFiles": 42,
    "doneFiles": 17,
    "errors": [{ "src": "...", "message": "..." }],   // planning 단계 에러
    "leaves": [
      {
        "id": 0,
        "name": "main.js",
        "size": 12345,
        "transferred": 12345,
        "status": "done",              // "waiting" | "active" | "done" | "error"
        "error": null,
        "phase": "upload"              // r2r 한정: "download" | "upload"
      }
    ]
  }
  ```
- **`done`** — `{ ok: true, errors: [...] }`. 배치 완료 시 (개별 leaf 에러가
  있어도 발생).
- **`fail`** — `{ message: "..." }`. 배치 레벨 치명적 에러 (예: 세션 없음,
  SFTP 채널 못 얻음). 개별 leaf 에러로는 `fail`이 안 뜨고 최종 스냅샷의
  `errors`에 들어감.

## 보안 모델

- **백엔드는 `127.0.0.1`에만 바인딩.** 같은 LAN의 다른 머신에서 안 보임.
- **비밀번호 디스크 저장 없음.** 세션 동안 `ssh2` 클라이언트가 메모리에만
  보관, 디스크에도 로그에도 `config.json`에도 안 들어감.
- **`process.argv`로 자격 노출 없음.** M8에서 R2R direct를 추가할 때 `sshpass`
  + `SSHPASS` 환경변수를 쓸 것 (CLI 인자에 비밀번호를 박지 않음). v1은
  shell-out 자체를 안 함.
- **호스트 키 처리.** 현재는 `ssh2` 기본값. PRD는 config 디렉터리에 known-hosts
  파일을 두고 first-seen 고정을 요구함. 아직 미구현 — [로드맵](#로드맵) 참조.
- **Per-launch 토큰.** PRD §6은 모든 API 요청에 토큰을 첨부해서 같은 머신의
  다른 프로세스 drive-by 요청을 막도록 요구. 아직 미구현 — [로드맵](#로드맵)
  참조.

## 파일 레이아웃

```
dropscp/
├── PRD.md              제품 요구사항 (진실의 원본)
├── README.md           영문 README
├── README.ko.md        이 문서
├── package.json
├── server/
│   ├── index.js        Express 앱, 라우트
│   ├── config.js       config.json 로드/저장, 워커 클램프
│   ├── ssh-session.js  세션별 SSH + SFTP 채널 풀
│   ├── transfer.js     job 모델, planning, 워커 풀, 릴레이
│   ├── local-fs.js     로컬 readdir/mkdir
│   └── presets.js      preset CRUD
└── public/
    ├── index.html
    ├── style.css
    └── app.js          UI (빌드 스텝 없음)
```

## 알려진 제약과 특이사항

- **심볼릭 링크**. v1은 최상위 레벨에서 링크를 따라가서 *타깃의 내용*을 전송.
  재귀 워크 중 만나는 링크는 업로드 시 조용히 스킵, 다운로드 시 타깃이 파일이면
  내용을 가져오고 디렉터리면 에러로 기록. 링크를 링크로 대상에 재생성하지는
  않음. 순환 링크는 안전 (첫 비-디렉터리에서 재귀 중단).
- **빈 디렉터리**. 재귀 워커가 파일 leaf만 emit하므로, 빈 디렉터리는 대상에
  생성되지 않음.
- **로컬 목록에 사이즈 컬럼 없음**. `local-fs.js#ls`가 파일 stat을 안 함, 로컬
  파일 사이즈 표시 비어있음. M2부터 있던 묵은 빠짐.
- **R2R direct 모드는 deferred**. v1은 항상 로컬 임시 디렉터리를 통한 릴레이.
  열려있는 설계 결정은 [PRD §3 F3-deferred decisions](PRD.md)에 박아둠 (dst
  비밀번호 캐싱, `sshpass` 탐지, `StrictHostKeyChecking`, SSE notice 이벤트,
  /api/r2r 스키마, 릴레이 진행률 회계 방식).
- **전송 취소 UI 없음**. 상태바에 진행률은 표시되지만 job/leaf별 cancel 버튼은
  아직 없음.
- **세션 상태가 재시작 사이에 유지되지 않음**. SSH 세션은 `sessionId` 키로
  백엔드 메모리에 살아있고, Node 프로세스가 끝나면 사라짐.

## 로드맵

[PRD.md](PRD.md) 기준:

| 마일스톤 | 범위 | 상태 |
|---|---|---|
| M1 | 백엔드 골격: SSH connect, 원격 `ls`/`mkdir`, 로컬 `ls` | ✅ |
| M2 | HTML UI + 좌우 트리 | ✅ |
| M3 | 드래그 앤 드롭 + 진행률 | ✅ |
| M4 | Preset + config | ✅ |
| M5 | 멀티 셀렉트 + 워커풀 병렬 전송 | ✅ |
| M6 | 멀티 호스트 탭 | ✅ |
| M7 | R2R via 로컬 릴레이만 | ✅ |
| M8 (deferred) | `sshpass`로 R2R direct | open |
| §6 | Per-launch API 토큰, known-hosts 고정 | open |

## 라이선스

MIT

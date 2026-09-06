# CONTEXT (glossary) — Zeph CLI/MCP encryption

Glossary only — no implementation detail. Terms for the per-device E2E domain
(design in encl ADR-0007 / ADR-0008, currently **deferred**). Captured during a
grill-with-docs session 2026-06-29.

## Terms

### Machine Device
A single logical device representing one host. Identified by `deviceId =
computeListenerDeviceId()` (deterministic from platform **machine id**; machine id를
못 읽는 예외에서만 hostname fallback — 이때는 `~/.zeph/listener-device-id`에 고정(persist)해
hostname drift가 한 머신을 여러 device로 분열시키지 않게 한다). All Zeph processes on that
host — `zeph notify` (sender), the listener (receiver), and the MCP server (sender) —
share **one** Machine Device identity and **one** Device Keypair. The phone sees one
device per machine, not one per process.

### Config precedence
flag > config file > built-in default — cli/mcp-server/plugin. `wsUrl` 만 예외로 env 가 **config 아래**다 (`ZEPH_WS_URL` deprecated — 셸 프로파일 export 가 config 를 조용히 덮던 것을 뒤집었고, 그것만 있는 머신이 안 죽게 최하위로 남겨둠)
3패키지 공통 계약. CLI flag 최상위 tier는 cli 전용(mcp-server는 stdio 서버,
plugin은 hook이라 flag 없음). 우선순위 변경 시 이 절부터 갱신한다.

### Device Keypair
The ECDH P-256 key material owned by a Machine Device. The **private** key never
leaves the host. The **public** key is registered with the server so other devices
can encrypt to this one. Distinct from the obsolete per-user keypair (removed).

### Sender / Recipient
A **Sender** is the process producing a push (CLI notify, MCP tool). A **Recipient**
is a device that should be able to read it. A Sender encrypts for every Recipient
that has a per-device public key, excluding its own Machine Device.

### deviceKeyMap
The per-recipient wrapped-key bundle that rides with an encrypted push:
`{ deviceId → the message key wrapped for that device }`. Opaque to the server.

### encryptionEnabled
The single authoritative signal a client reads (from the server) to decide whether to
encrypt. True implies the user is PRO and has opted in. Clients do not inspect the
plan directly.

### Eligible Recipient
A Recipient that currently has a per-device public key registered. Encryption targets
only Eligible Recipients; if there are none, the Sender falls back to plaintext.

### Passive vs Active operator (threat-model term)
"Operator can't read" holds against a **passive** operator (won't tamper — covers
DB leak, subpoena, honest-but-curious). It does **not** yet hold against an **active**
operator that substitutes public keys (MITM); that needs out-of-band device
verification (a later phase).

### Listener version stamp
`~/.zeph/listener.version` — the CLI version the *running* daemon booted from,
written next to `listener.pid` by `writeListenerRuntime()` and read by the `zeph cc`
wrapper. `npm i -g`는 디스크의 패키지만 바꾸고 상주 프로세스는 그대로 두므로, 이 스탬프가
"설치본 ≠ 상주본" drift를 감지하는 유일한 신호다. **없으면 = 구버전** (스탬프 도입 이전
빌드라는 뜻). 두 파일은 `listener-process.ts` 한 곳에서만 쓰고 지운다 — listener와 wrapper가
각자 경로를 재구현하면 drift 판정이 갈린다.

### Login-time service = listener 소유권 이전 (`listener-service.ts`)
`zeph listener --install-service`가 launchd LaunchAgent(`to.zeph.listener`)를 심으면
**프로세스 소유자가 launchd로 바뀐다**. 이후 `zeph cc`(`ensureListenerRunning`)와
`zeph listener --stop|--restart`는 spawn/SIGTERM 대신 `launchctl kickstart|bootout`으로
위임한다 — launchd 자식을 직접 죽이면 launchd가 대체본을 띄우는 동시에 호출자도 하나
띄워, 싱글턴 가드에서 진 쪽이 exit 0 하고 `KeepAlive:{SuccessfulExit:false}`가 그걸
"의도된 정지"로 읽어 로그인 세션 내내 포기한다. 설치 시 **기존 데몬을 먼저 stop**하는
이유도 같다.

plist는 node·cli.js 절대경로와 **tmux가 잡히는 PATH**를 설치 시점에 굽는다 — launchd가
주는 PATH는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이고 `verifyTmux()`는 tmux 없으면
`exit 127`이다. 정지는 `bootout`만 쓴다(`disable`은 영속 DB라 로그인을 넘어 살아남음).
로그 회전이 rename이 아니라 copy-truncate인 것도 여기서 나온다 — launchd가
`StandardOutPath` fd를 쥐고 있어 rename하면 같은 inode에 계속 쓴다.
`listener-service.ts`는 **node 빌트인만** import한다 (wrapper 핫패스가 읽는다).

### Inventory worker = listener.ts를 두 번째 스레드에서 import (`inventory-worker.ts`)
5초 세션 스윕(`collectSessionsVerbose`)은 worker thread에서 돈다 — 동기 tmux spawn이
메인 루프를 막아 소켓이 초 단위로 멈추던 것이 원인이었다. worker는 `listener.js` 모듈
전체를 로드하므로 **listener.ts는 import 시점에 아무 일도 하지 않아야 한다**(모듈 스코프에
소켓·타이머·spawn 금지). 스윕 결과의 세션 이름 스냅샷이 메인 스레드의 멤버십 판정
(`isInventoried`)을 답하고, miss일 때만 in-thread 스윕으로 폴백한다.

### Agent key whitelist (3-site 동기)
`ALLOWED_KEYS` (listener.ts, phone→pane 키 주입) is mirrored in two other repos'
files that MUST change together, else a new key is rejected before it reaches the
daemon: zeph `pushes.ts ALLOWED_AGENT_KEYS` (server gate) and the zeph web key row.
Add a key → update all three.

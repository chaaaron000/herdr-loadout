# Herdr 실측 사실 (검증 로그)

대상: 설치된 Herdr **0.9.1** (`herdr --version`), 문서는 v0.9.3 태그 소스. Windows 11, Git Bash.
아래 항목은 모두 이 머신에서 실제로 실행해 관찰한 결과다. 추론만 있는 항목은 `[INFERENCE]`로 표시한다.

## 1. 플러그인 호스트 표면

### 1.1 링크 / 레지스트리

```bash
herdr plugin link <절대경로>      # herdr-plugin.toml 이 있는 디렉터리
herdr plugin list [--plugin ID] [--json]
herdr plugin unlink <plugin_id>
herdr plugin config-dir <plugin_id>   # 디렉터리 생성 후 경로 출력
herdr plugin action list [--plugin ID]
herdr plugin action invoke <qualified_action_id>
herdr plugin log list [--plugin ID] [--limit N]
herdr plugin pane open --plugin ID --entrypoint ID [--placement overlay|popup|split|tab|zoomed] [...]
herdr plugin pane focus <pane_id>
herdr plugin pane close <pane_id>
```

- `link`는 **절대 경로**를 요구한다. Git Bash의 `/tmp/...` 가상 경로는
  `Working directory does not exist: /tmp/hpspike`로 실패한다. (→ `$(pwd -W)` 또는 네이티브 경로 사용)
- 링크 응답의 `result.plugin`에 `plugin_root`, `manifest_path`, 선언된 `actions`/`panes`가 그대로 반영된다.
- `plugin config-dir`는 `<RoamingAppData>/herdr/plugins/config/<plugin_id>`를 출력하고 **없으면 생성**한다.
- 플러그인은 사용자 전역(모든 세션 공통)이다.

### 1.2 액션 invoke의 실제 시맨틱 (설계에 결정적)

```bash
herdr plugin action invoke test.spike.slow      # 내부에서 3초 sleep 후 출력
```

| 관찰 | 값 |
|---|---|
| 호출 반환 시간 | **0.03s** (즉시 반환, 비동기 fire-and-forget) |
| 반환된 `result.log.status` | `"running"` (종료 대기 없음) |
| 액션의 stdout 위치 | 호출자 stdout **아님**. `herdr plugin log list`의 `stdout` 필드에만 기록 |
| 인자 전달 | **불가**. `invoke <id> extra-arg` → `unknown option: extra-arg`, `invoke <id> -- --alpha` → `unknown option: --` |
| 종료 코드 | 로그 필드 `exit_code`로만 확인 가능 (`status: succeeded`, `stdout`, `stderr`, `started_unix_ms`, `finished_unix_ms`) |

**결론**: `herdr plugin action invoke`는 "인자를 받아 결과를 stdout으로 돌려주는 CLI"로 쓸 수 없다.
→ Director용 CLI는 **플러그인 액션이 아니라 독립 실행 파일**이어야 한다.

### 1.3 액션/이벤트 환경변수

액션 프로세스에서 실제로 관찰된 값:

```
HERDR_BIN_PATH   = C:\Users\<HOME_USER>\.herdr\packages\standalone\releases\0.9.1-x86_64-pc-windows-msvc\herdr.exe
HERDR_SOCKET_PATH= C:\Users\<HOME_USER>\AppData\Roaming\herdr\herdr.sock
HERDR_ENV         = 1
HERDR_PLUGIN_ID / HERDR_PLUGIN_ROOT / HERDR_PLUGIN_CONFIG_DIR / HERDR_PLUGIN_STATE_DIR
HERDR_PLUGIN_ACTION_ID
HERDR_PLUGIN_CONTEXT_JSON
HERDR_WORKSPACE_ID / HERDR_TAB_ID / HERDR_PANE_ID
```

`HERDR_PLUGIN_CONTEXT_JSON`은 **문자열로 인코딩된 JSON**이며 파싱하면:

```json
{"workspace_id":"w2","workspace_label":"herdr-loadout","workspace_cwd":"D:\\...\\herdr-loadout",
 "tab_id":"w2:t1","tab_label":"1","focused_pane_id":"w2:p1","focused_pane_cwd":"D:\\...\\herdr-loadout",
 "focused_pane_agent":"omp","focused_pane_status":"idle","invocation_source":"cli","correlation_id":"cli:plugin"}
```

- `HERDR_PLUGIN_CONFIG_DIR` = `…/Roaming/herdr/plugins/config/<id>` (사용자 편집 대상)
- `HERDR_PLUGIN_STATE_DIR`  = `…/Local/herdr/plugins/<id>` (런타임 캐시; lazy 생성)
- `[INFERENCE]` startup 훅은 `link` 시점에 실행되지 않았다(문서상 "세션 복원 후 1회"). → 상태 복원 용도로만
  쓰고, MVP에서는 startup 훅에 의존하지 않는다.

### 1.4 플러그인 프로세스에서의 중첩 herdr 호출

액션 프로세스에서 `spawnSync(process.env.HERDR_BIN_PATH, ["plugin","pane","open",...])`가 **정상 동작**했다
(팝업이 이미 열려 있어 `ui_busy` JSON을 받았고, 이는 요청이 서버까지 도달했음을 증명).

### 1.5 플러그인 pane

| 관찰 | 값 |
|---|---|
| PTY | `process.stdin.isTTY === true` (split pane, popup 모두) |
| 크기 | split: 132x45 / popup 60%x40%: 76x16 (`stdout.columns/rows`) |
| 키 입력 | 전달됨. `↑` = `\x1b[A`, `ctrl+s` = `\x13`, 텍스트 그대로 |
| 리사이즈 | `stdout.on('resize')` 동작 |
| 프로세스 종료 시 pane | **자동으로 닫힘** (빈 pane이 남지 않음) |
| split pane ID | 부여됨 (`w2:p4`) |
| popup | **pane ID 없음**. 세션 모달 싱글턴. 다른 팝업이 열려 있으면 `ui_busy`. 닫으려면 프로세스가 종료해야 함 |
| 렌더링 | Ink 7 + React 19 렌더/입력/리사이즈 실측 정상 |

### 1.6 CLI 확장성 한계

- `herdr profiles list` → `unknown command: profile`. **플러그인은 herdr CLI에 서브커맨드를 추가할 수 없다**
  (문서: "Runtime action registration … not part of plugin v1").
- `herdr api` = `snapshot` | `schema` 뿐. **임의 API 요청 패스스루 없음**.
- `herdr config` = `check` | `reset-keys` 뿐. 별칭(alias) 기능 없음.
- 키바인딩은 가능: `[[keys.command]]`에 `type = "plugin_action"` + `command = "<plugin_id>.<action_id>"`.
  (`type = "shell"|"pane"|"popup"` + 임의 명령 문자열도 지원 — 사용자 로컬 설정에서만 가능)

### 1.7 에러 규약

- 문법 오류: `unknown option: X` + **exit 2** (실측: `herdr plugin action list --json`).
- API 오류: JSON (`{"error":{"code":"plugin_action_not_found",...}}`) + 문서상 exit 1.
  실측한 코드: `plugin_action_not_found`, `plugin_pane_not_found`, `ui_busy`, `workspace_group_close_required`.

## 2. 하네스 실측 (이 머신)

설치 여부: `claude.exe` ✓, `codex.exe` ✓, `opencode.exe` ✓, `omp.exe` ✓, `agy.exe` ✓ / `pi`, `gemini`, `cursor-agent` ✗.
Node v22.23.2, npm 10.9.8, Python 3.14.7. (`bun`, `cargo`, `go` 없음)

| 하네스 | 모델 지정 | Effort 지정 | 모델 목록 조회 |
|---|---|---|---|
| claude | `--model <m>` | `--effort <low\|medium\|high\|xhigh\|max>` (help 실측) | **없음** (`claude --help`에 목록 서브커맨드 부재) → 자유 입력 |
| codex | `-m/--model <m>` | `-c model_reasoning_effort=<lvl>` (**따옴표 없이**. `~/.codex/config.toml`에 동일 키 확인) | **`codex debug models`** → JSON (`models[].slug`, `display_name`, `default_reasoning_level`, `supported_reasoning_levels[].effort`) |
| opencode | `-m/--model provider/model` | `--variant <v>` ("provider-specific reasoning effort, e.g. high, max, minimal") | **`opencode models [provider]`** → `provider/model` 라인 목록 (`--verbose`로 메타데이터) |
| omp | `--model <m>` | `--thinking <off\|minimal\|low\|medium\|high\|xhigh\|max\|auto>` | **`omp models --json`** → `models[].{provider,id,selector,name,reasoning,thinking:[...]}` |
| agy (Antigravity CLI) | `--model <m>` | `--effort <low\|medium\|high\|xhigh\|max>` (help 실측. 1.2.14 에는 `xhigh` 없음) | **`agy models`** → `Fetching available models...` 한 줄 뒤 `id<TAB>label` 라인 목록. 같은 모델을 수준별 id 로 나눠 낸다(`gemini-3.8-flash-low`/`-medium`/`-high`, `gpt-oss-120b-medium`) |
| pi / 기타 | 미설치 → 미검증 | 미검증 | 미검증 → 자유 입력 + extra_args |

기타 실측 플래그:
- claude: `--permission-mode <mode>` 존재
- codex: `-s/--sandbox read-only|workspace-write|danger-full-access`, `-a/--ask-for-approval`, `--dangerously-bypass-approvals-and-sandbox`
- omp: `--profile`, `--cwd`, `--mode text|json|rpc|rpc-ui`, `--no-tools`
- opencode: `--agent <a>`
- agy: `--mode accept-edits|plan`, `--dangerously-skip-permissions`, `--sandbox`(값 없는 스위치), `--add-dir`.
  Herdr `agent start --kind agy` 지원. 처음 여는 폴더에서는 "Do you trust the contents of this project?"
  확인 창이 떠서 `agent start` 가 `agent_not_ready`(blocked during startup)로 끝난다. 폴더를 한 번 신뢰하면 해소.

## 3. 라이브러리 실측

- **smol-toml 1.9.0**: 의존성 0, `parse`/`stringify` 왕복 **멱등성 확인** (`stringify(parse(x)) === x`),
  `[[profiles]]` + 멀티라인 문자열 + 배열 + 중첩 테이블 모두 정상. → `loadout.toml` I/O에 채택.
- **ink 7.1.1 + react 19**: `engines.node >= 22`. Herdr 플러그인 pane 안에서 렌더/입력/리사이즈 검증 완료.
  (`ink` 6은 `node >= 20` — Node 20 지원이 필요하면 이쪽으로 내린다.)
- **@opentui/core 0.5.14**: `engines.node >= 26` → 부적합.

## 4. 재현 방법

스파이크는 임시 디렉터리(`%TEMP%/hpspike`)에서 수행 후 **전부 삭제**했다. 재현 시:

```bash
mkdir spike && cd spike && npm init -y && npm i ink@7 react@19
cat > herdr-plugin.toml   # [[actions]] / [[panes]] 선언
herdr plugin link "$(pwd -W)"                 # Git Bash: -W 로 네이티브 경로
herdr plugin pane open --plugin <id> --entrypoint <pane_id>
herdr pane send-keys <pane_id> down
herdr pane read <pane_id> --source visible
herdr plugin log list --plugin <id> --limit 5 # 액션 stdout/stderr/exit_code 확인
herdr plugin unlink <id> && herdr pane close <pane_id>
```

주의: 플러그인 pane 프로세스가 살아 있으면 pane이 남는다. 스파이크 정리 시 `herdr pane close`까지 수행할 것.

## 4.1 skills-manager 로 배포할 때

이 저장소의 스킬(`skills/herdr-loadout`, `skills/herdr-loadout-edit`)은 중앙 라이브러리
(`~/.skills-manager/skills/`)에 배포되어 있다. 실측으로 확인한 주의점:

- **`set-source` 의 `content_changed` 는 신뢰할 수 없다.** 이 값은 라이브러리에 *기록된*
  해시와 비교하므로, 스킬을 설치한 뒤 소스를 편집하면(`skills update` 로 라이브러리를
  갱신했더라도) 실제 내용이 같아도 `true` 로 나온다. 실제 비교는 클론해서 `diff` 로 할 것.
- **`--force` 는 검증 후에만.** 클론한 파일이 라이브러리·배포본과 바이트 단위로 같음을
  확인한 뒤 실행하면 잃을 것이 없다(메타데이터만 갱신된다).
- **줄바꿈이 내용 차이로 잡힌다.** `core.autocrlf=true` 환경에서 체크아웃하면 LF→CRLF 로
  변환되어, 내용이 같아도 해시가 달라진다. 이 저장소는 `.gitattributes` 로 LF 를 고정했다.
- **상대 경로 소스는 cwd 에 묶인다.** `./skills/herdr-loadout` 로 등록하면 저장소 루트에서만
  `update` 가 동작하고 다른 디렉터리에서는 `Original source path no longer exists` 로 실패한다.
  git URL + `--subpath` 로 등록해야 어디서든 동작한다(현재 그렇게 되어 있음).

## 5. Windows 환경 함정 (nvm + 공백 경로)

이 머신의 nvm 레이아웃은 `codex`/`opencode` 런처를 **공백이 포함된 경로**에 둔다.

```text
PATH 순서:
  C:\Users\<user>\AppData\Local\Author Software\nvm\installs\v22.23.2   ← codex.cmd, opencode.cmd
  C:\Users\<user>\AppData\Local\Author Software\nvm\.nodejs             ← codex.exe, opencode.exe (이 경로도 공백 포함)
```

> 정정: `.nodejs` 의 `.exe` 도 전체 경로에는 `Author Software` 가 들어 있어 공백이 있다.
> 아래 "회피"는 `.cmd` 대신 `.exe` 를 고르게 할 뿐 공백 문제를 없애지 못한다. 근본 해결은
> 공백 없는 junction 을 PATH 에 두는 것이다(아래 "적용한 해결").

- 셸은 `.nodejs/codex.exe` 를 찾아 정상 실행한다.
- 하지만 경로에 **공백이 있으면 Herdr 의 에이전트 시작이 실패**한다:
  `'C:\Users\<user>\AppData\Local\Author'은(는) 내부 또는 외부 명령...`
  (Herdr 가 만든 PowerShell/명령 문자열에서 경로가 인용되지 않음)
- 즉 `codex.cmd` 경로로는 `herdr agent start` 가 동작하지 않는다.
- **회피**: PATH 에서 `.nodejs` 를 `installs` 앞에 두면 공백 없는 `.exe` 가 선택되어 정상 동작한다.
  실측 확인: `rx-test` codex 에이전트가 idle 상태로 기동.
- `claude`(`~/.local/bin`)와 `omp`(`~/.local/omp`)는 공백 없는 경로라 영향 없음.

이 프로젝트의 `which()` 는 PATH 순서를 그대로 따르므로 `codex.cmd` 를 반환한다.
그 경로를 그대로 `herdr agent start` 에 넘기면 실패하므로, Windows 에서는 공백 없는 후보를
우선하거나 사용자에게 PATH 조정을 안내해야 한다.

**적용한 해결 (2026-10-01).** 공백 없는 junction 을 만들고 사용자 PATH 맨 앞에 둔다:

```powershell
New-Item -ItemType Junction -Path C:\tools\nvm -Target "C:\Users\<user>\AppData\Local\Author Software\nvm"
[Environment]::SetEnvironmentVariable('PATH', 'C:\tools\nvm\.nodejs;' + [Environment]::GetEnvironmentVariable('PATH','User'), 'User')
```

- 새 프로세스에서 `Get-Command codex` 가 `C:\tools\nvm\.nodejs\codex.exe` 를 먼저 반환한다. nvm 버전을 바꿔도 junction 이 따라간다.
- Herdr 와 터미널은 **재시작**해야 새 PATH 를 읽는다.
- 주의: nvm 의 `node` 래퍼는 실행 시 `nvm\installs\<ver>` 를 PATH 맨 앞에 붙인다. 그래서 `node` 로
  실행되는 이 프로젝트의 `which()` 는 여전히 `codex.cmd` 를 먼저 보고, dry-run 이 "launchable path"
  경고를 낼 수 있다. 이는 `herdr agent start` 가 보는 PATH 와 다르므로 실제 기동에는 영향이 없다.

**정정 (2026-10-01): 위 "공백 경로" 증상의 실제 원인은 인자의 큰따옴표였다.**
nvm 의 `codex.exe` 는 "Node.js Module Shim" 이라 실제 런처(`installs\<ver>\codex.cmd`)를 cmd 로 다시
호출하는데, 이때 인자에 큰따옴표가 있으면 공백 경로가 쪼개져 같은 오류가 난다.

```text
codex.exe -c model_reasoning_effort=high --version      → 정상
codex.exe -c 'model_reasoning_effort="high"' --version  → 'C:\Users\<user>\AppData\Local\Author'은(는) ...
```

- 인자가 없거나 따옴표가 없으면 공백 경로여도 기동된다. 그래서 인자 없는 `agent start` 만 성공했다.
- codex 는 `-c` 값을 TOML 로 해석하고 실패하면 문자열로 취급한다. `codex app-server` 의 `config/read` 로
  `model_reasoning_effort=high` 가 문자열 `"high"` 로 읽히는 것을 확인했다.
- 그래서 `buildLaunchArgs` 는 따옴표 없는 형태를 낸다. 위의 junction/PATH 조정은 `which()` 결과를 공백 없는
  경로로 고르는 데 여전히 유용하다.

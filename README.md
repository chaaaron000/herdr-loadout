# herdr-loadout

**Language:** [한국어](./README.md) · [English](./docs/i18n/README.en.md) · [日本語](./docs/i18n/README.ja.md) · [简体中文](./docs/i18n/README.zh-CN.md)

Herdr용 lightweight agent profile registry 플러그인.

Director(또는 사용자)가 **어떤 harness / model / effort 를 어떤 역할에 쓸지** 정의하고,
오케스트레이터가 최소 컨텍스트 비용으로 프로필을 조회해 Herdr Skill 로 worker 를 띄운다.

```text
Profile Registry (이 플러그인)
      "누구를 쓸까?"
           ↓
       Director
           ↓
      Herdr Skill          "어떻게 띄울까?"
           ↓
      Herdr Runtime
```

이 플러그인은 오케스트레이터가 아니다. pane 생성, agent lifecycle, worktree, 메시징,
task DAG, scheduler 는 기존 Herdr + Herdr Skill 이 담당한다.

## 요구사항

- **Node.js ≥ 22** (플러그인 명령과 CLI 가 Node 로 실행된다)
- Herdr ≥ 0.7.0 (TUI). Herdr 데스크톱 앱(herdr-core `hc`)에서도 CLI와 스킬이 동작한다 — [Herdr 앱에서 쓰기](#herdr-앱에서-쓰기) 참고
- `npm` (GitHub 설치 시 의존성 설치 단계 `npm ci --omit=dev` 가 실행된다)

## 설치

GitHub 에서 (권장):

```bash
herdr plugin install chaaaron000/herdr-loadout
```

특정 버전은 `--ref <tag>` 로 고정한다. 소스 체크아웃으로 개발할 때는 아래처럼 링크한다.

```bash
# 소스 체크아웃에서
npm install

# Herdr 에 플러그인 등록 (로컬 링크)
herdr plugin link "$(pwd -W 2>/dev/null || pwd)"     # Git Bash 에서는 -W 로 네이티브 경로
herdr plugin list
```

`herdr plugin link` 는 **절대 경로**를 요구한다. Git Bash 의 `/tmp/...` 같은 가상 경로는
`Working directory does not exist` 로 실패하므로 `pwd -W` 또는 `D:\...` 형식을 쓴다.

> **Windows 주의:** Herdr 는 `herdr agent start` 때 실행 파일 경로를 따옴표 없이 셸에 넘긴다.
> harness(`codex`, `opencode` 등)가 공백이 있는 경로(예: nvm 의 `Author Software`)에 있으면
> 기동이 실패한다. 공백 없는 경로(예: junction)를 PATH 앞에 두면 해결된다.
> `herdr-loadout launch <id>` 의 `launchable path` 검사가 이런 경로를 알려 준다.
> 자세한 내용은 [`docs/herdr-verified-facts.md`](./docs/herdr-verified-facts.md) §5.

## 사용

### 1. GUI/TUI 로 프로필 편집

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

또는 액션으로 (Director/사용자 키바인딩에서 호출 가능):

```bash
herdr plugin action invoke herdr-loadout.open-ui
herdr plugin action invoke herdr-loadout.open-ui-popup
```

단축키를 등록했다면 그 키로 열 수도 있다.

Herdr 앱에서는 앱 전용 편집기(앱 모드)를 쓴다. 소스 체크아웃에서 한 번 설치한다:

```bash
npm run install:app-mod                         # ~/.config/herdr-app/mods/herdr-loadout 에 설치
npm run install:app-mod -- --key ctrl-shift-a   # 단축키도 등록 (이미 쓰는 키면 거부)
herdr-app do mod.open --name herdr-loadout      # 단축키 없이 열기
```

- 포커스된 터미널의 프로젝트를 기준으로 전역/프로젝트 프로필을 보여 주고, 키와 조작은 TUI 와 같다
  (`Enter` 편집, `a` 추가, `c` 복사, `d` 삭제, `r` override 해제, `[`/`]` 순서 바꾸기, `j` harness 목록, `k` API 키, 편집 중 `g`/`p` 저장, `t` 실행 점검, `Esc` 뒤로/닫기). 마우스로도 누를 수 있다.
- 모든 읽기·쓰기는 `herdr-loadout editor <action>` (CLI 의 JSON 백엔드)를 거치므로 TUI 와 규칙이 같다.
- 앱 모드는 Node 를 쓸 수 없어서, 설치 스크립트가 node 와 CLI 의 경로를 `cli.js` 에 적어 둔다. 체크아웃을 옮기면 다시 설치한다.
- 앱의 명령 팔레트(Ctrl+Shift+P)는 모드 항목을 받지 않으므로 단축키나 `mod.open` 으로 연다.

### 단축키 등록 (선택)

Herdr 는 플러그인이 키바인딩을 스스로 등록하는 것을 허용하지 않는다. `config.toml` 에 직접 추가한다:

```toml
# herdr-loadout: open the agent profile registry
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr-loadout.open-ui"
description = "agent profiles"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "herdr-loadout.open-ui-popup"
description = "agent profiles (popup)"
```

`prefix+a` 는 기본 overlay 배치, `prefix+shift+a` 는 세션 모달 팝업이다.
`prefix+l`·`prefix+g`·`prefix+p` 같은 키는 Herdr 가 이미 쓰고 있으니 피한다.
반영은 `herdr server reload-config` 로 하며 재시작이 필요 없다.

TUI 조작:

| 키 | 동작 |
|---|---|
| `↑` `↓` | 프로필 이동 |
| `Enter` / `e` | 선택한 프로필 편집 |
| `a` | 새 프로필 |
| `c` | 복제 |
| `d` | 삭제 (전역 프로필이면 그 프로젝트 override 도 함께 삭제) |
| `r` | 프로젝트 override 해제 — 전역 프로필을 다시 따름 (override 가 있는 행에서만) |
| `[` `]` | 선택한 프로필을 위/아래로 옮김 (같은 그룹 안에서, 선택이 따라감) |
| `j` | 탐지 화면 (설치된 harness + 모델 카탈로그) |
| `q` | 종료 (pane 도 닫힘) |

목록은 두 구역으로 나뉜다.

- **Global profiles** — 전역 프로필. 이 프로젝트가 일부 필드를 덮어쓴 행에는 `≠ model, effort` 처럼 전역과 다른 항목이 표시된다.
- **Project profiles · (경로)** — 이 프로젝트에만 있는 프로필. 전역 원본이 없으므로 override 개념 없이 바로 수정한다.

편집 화면은 **모드가 분리**되어 있다. 같은 키가 상황마다 다른 뜻이 되지 않는다.

| 모드 | 키 | 동작 |
|---|---|---|
| 필드 이동 | `↑` `↓` | 프로필 항목 사이 이동 |
| | `Enter` | 그 항목 열기 (옵션 있으면 목록, 없으면 직접 입력) |
| | `g` `p` `t` | 전역에 저장 / 프로젝트에 저장 / Test Launch |
| | `r` | 포커스한 필드를 전역 값으로 되돌림 (전역과 다른 필드에서만) |
| | `Esc` | 목록으로 |
| 옵션 선택 | `↑` `↓` | 옵션 이동 |
| | `Enter` | 적용하고 필드로 복귀 |
| | `/` | 찾기 (입력하는 대로 걸러짐) |
| | `o` | 정렬 기준 순환 (catalog → name → provider → context) |
| | `Esc` | 필터 지우기, 한 번 더 누르면 필드로 |
| 직접 입력 | 문자 | 값 입력 |
| | `Enter` | 확정 |
| | `Esc` | 취소 |

찾기는 id·provider·이름 어디에나 걸리고 여러 단어는 AND로 좁힌다
(`ollama flash`). 목록 헤더에 `24 of 55`처럼 남은 개수를 표시해, 걸러진 목록을 짧은 목록으로
착각하지 않게 한다. 하단 단축키 안내는 모드에 따라 바뀐다.

모델 목록이 길면 커서를 따라 스크롤되며, 남은 개수는 `↑27 ↓45 (41/86)` 처럼 표시된다.

저장 키는 대상마다 따로 있어 모드를 전환하지 않는다. 편집 화면 상단에 지금 프로필이 어디에 속하는지와 각 키의 용도가 표시된다.

| 키 | 저장 위치 | 동작 |
|---|---|---|
| `g` | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 전역 프로필을 수정한다. 이번에 바꾼 필드만 반영하므로 프로젝트 override 값이 전역으로 새지 않는다 |
| `p` | `<project>/.herdr/loadout.toml` | **전역과 다른 필드만** 저장 (나머지는 전역을 따름). 프로젝트 전용 프로필은 전체를 저장 |

- 프로젝트 전용 프로필은 `p` 만 쓴다 (`g` 는 거부).
- 새 프로필·복제는 `g`(전역) 또는 `p`(프로젝트 전용) 중 골라 저장한다. 이미 있는 id 는 덮어쓰지 않고 거부한다.
- 전역과 다른 필드에는 `≠` 가 붙고 하단에 전역 값이 표시된다. 그 필드에서 `r` 을 누르면 전역 값으로 되돌아가며, 전부 되돌린 뒤 `p` 를 누르면 override 가 삭제된다.
- 목록에서 override 가 있는 행에 `r` 을 누르면 확인 후 override 전체를 지우고 전역 프로필을 다시 따른다.

프로젝트에는 변경분만 기록하므로, 전역 프로필의 모델·태그를 나중에 바꿔도 프로젝트가
그 값을 가리지 않는다.

팝업(`prefix+shift+a`)은 화면의 90%×80% 로 열린다. TUI 는 터미널 크기에 맞춰 레이아웃을
바꾸며, 창이 작으면 필드 목록을 줄여 모델 목록에 자리를 내준다.

### 2. CLI 로 조회 (Director 경로)

```bash
herdr-loadout list                  # 사람이 읽는 목록
herdr-loadout list --compact        # Director 용: id | cost | purpose
herdr-loadout show builder          # 단일 프로필 상세
herdr-loadout path                  # 설정/상태 경로 확인
herdr-loadout validate              # 설정 검증
herdr-loadout detect                # harness 설치 상태 + 모델 카탈로그
herdr-loadout catalog               # models.dev 스냅샷 (225 provider) 조회/갱신
herdr-loadout launch builder        # Test Launch (dry-run)
herdr-loadout command builder --name w1 --pane 3   # worker 시작 명령을 지금 프로필 값으로 출력
herdr-loadout task new api-auth --worker builder-auth --profile builder   # .herdr/runs/<날짜>-api-auth/ 에 brief.md·report.md 만들기
herdr-loadout worker-check builder-auth   # 실행 중인 worker 가 지금 프로필과 맞는지 (아니면 exit 1)
herdr-loadout agents-md             # 프로젝트 AGENTS.md 의 위임 블록 상태 (current | missing | outdated | declined)
herdr-loadout ui                    # TTY 밖이면 pane 을 열고 종료
```

launcher 설치 (PATH 를 수정하지 않는다):

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

PATH 없이 에이전트가 쓰는 경로:

```bash
"$(herdr plugin config-dir herdr-loadout)/herdr-loadout" list --compact
```

어느 셸에서나 `herdr-loadout` 로 부르려면 **이미 PATH 에 있는 폴더**에 설치한다:

```bash
node scripts/setup-shim.mjs --dir ~/.local/bin
```

플러그인이 재설치로 옮겨져도 이미 설치한 launcher 는 Herdr 시작 시 자동으로 경로가 갱신된다.

shim 없이도 항상 동작한다:

```bash
node bin/herdr-loadout.mjs list --compact
```

`list --compact` 출력은 헤더/색/장식이 없는 고정 형식이다. 오케스트레이터 파서가 의존한다.

```text
builder | expensive | implementation/refactor/design
junior | normal | implementation/light
qa | normal | qa/testing
reviewer | cheap | review/security
scout | cheap | research
```

### 3. 설정 파일

| 파일 | 용도 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 전역 프로필 |
| `<project>/.herdr/loadout.toml` | 프로젝트 오버라이드 (지정한 필드만 덮어씀) |

`herdr-loadout path` 로 실제 경로를 확인한다. 손으로 편집해도 된다. 저장(`set`, `add`, `remove`, `reset`, `import`, 편집기 저장)은 바꾸라는 키와 블록만 고치므로 주석, 알 수 없는 키, 다른 테이블, 빈 줄, 줄바꿈 문자는 그대로 남는다. 그렇게 고칠 수 없는 파일(인라인 배열로 쓴 프로필 등)은 아무것도 쓰지 않고 거부한다.

```toml
version = 1

[[profiles]]
id = "builder"
name = "Builder"
harness = "claude"
model = "deepseek-v4.1"
effort = "medium"
cost = "normal"
when_to_use = "General implementation, refactoring, and bug fixes."
avoid_when = "Pure research, trivial edits, or independent review."
```

프로젝트 오버라이드 예 (effort 와 추가 인수만 바꿈):

```toml
[[profiles]]
id = "builder"
effort = "high"
extra_args = ["--add-dir", "Assets"]
```

### 4. 프로젝트 AGENTS.md 의 위임 블록

스킬은 에이전트가 쓰기로 정한 뒤에야 로드된다. 그래서 "구현·QA·리뷰·탐색을 시작하기 전에 스킬을 로드하고 사용자의
작업 방식(workflow)을 따른다" 는 안내는 하네스가 시작할 때 항상 읽는 파일에 있어야 한다. 블록은 중립적이다. 누가 무엇을
직접 하고 무엇을 worker 에게 넘길지는 블록이 아니라 작업 방식이 정한다 (아래 "작업 방식"). 블록 원문은
`src/core/agents-md.md` 하나뿐이고, CLI 가 그대로 출력하고 설치한다.

```bash
herdr-loadout agents-md            # 상태: current | missing | outdated | declined (--json 도 됨)
herdr-loadout agents-md print      # 블록 원문
herdr-loadout agents-md install    # AGENTS.md 에 쓰거나 갱신하고, 필요한 @AGENTS.md import 를 더함
herdr-loadout agents-md decline    # 이 프로젝트에서는 다시 묻지 않게 기록
```

- `herdr-loadout` 스킬이 세션마다 상태를 보고, `missing`·`outdated` 면 블록을 사용자에게 보여 주고 한 번 묻는다.
  예면 `install`, 아니면 `decline` 이다. 묻지 않고 쓰지 않으며, `[Worker-...]` 프롬프트로 시작한 worker 는 이 단계를 건너뛴다.
- `install` 은 `<!-- herdr-loadout:start -->` 와 `<!-- herdr-loadout:end -->` 줄 사이만 쓴다. 파일이 없으면 만들고, 마커가
  없으면 끝에 붙이고, 있으면 그 사이만 바꾼다. 다시 실행해도 바뀌는 것이 없다. 마커가 깨져 있으면 아무 파일도 건드리지 않고 실패한다.
- 거절 기록은 저장소가 아니라 플러그인 상태 폴더의 `agents-md-declined.json` 에 프로젝트 루트별로 남는다. `install` 하면 지워진다.
- 프로젝트 루트는 `--project`, 없으면 위로 올라가며 가장 가까운 `.git`·`.herdr` 가 있는 폴더다.

하네스마다 프로젝트 루트에서 읽는 파일이 다르다. 문서로 확인했고, pi 를 뺀 다섯 하네스는 실제 실행(임시 프로젝트에서 각 하네스에 지시 파일 내용을 물음)으로도 확인했다. pi 는 소스 코드로 확인했다.

| harness | 읽는 파일 | `install` 이 하는 일 |
|---|---|---|
| claude | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` 중 하나라도 있으면 그것들만, 없으면 `AGENTS.md` (v2.1.277 이상) | 그 파일에 `@AGENTS.md` import (`.claude/CLAUDE.md` 는 `@../AGENTS.md`) |
| omp | 폴더마다 하나: `.omp/AGENTS.md` > `.claude/CLAUDE.md` > `.agent(s)/AGENTS.md` > `.gemini/GEMINI.md` > `.github/copilot-instructions.md` > `AGENTS.md` > `CLAUDE.md` | `AGENTS.md` 보다 앞선 파일이 있으면 거기에 import |
| codex | `AGENTS.override.md`, 없으면 `AGENTS.md` | `AGENTS.override.md` 는 `note:` 로 알리기만 한다 (import 를 읽지 않음) |
| opencode | `AGENTS.md` (없을 때만 `CLAUDE.md`) | 없음 |
| agy | `AGENTS.md` 와 `GEMINI.md` 둘 다 | 없음 |
| pi | `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` | codex 와 같음 |

Claude Code 가 `CLAUDE.md` 만 읽는 경우(구버전, 또는 Project instructions 가 `claude-md`)에는 `install --claude-md` 가
`CLAUDE.md` 를 만들어 import 한다. `~/.claude/settings.json` 에 `claude-md` 가 설정돼 있으면 옵션 없이도 그렇게 한다.

모델/하네스 교체는 프로필만 수정하면 된다. AGENTS.md 의 블록은 바뀌지 않는다.

### 5. 에이전트가 프로필을 만들기 (비대화형)

TUI는 사람 전용이므로, 에이전트는 CLI 쓰기 명령을 쓴다.

```bash
# 플래그로 직접
herdr-loadout add --id builder-unity --name "Unity Builder" \
  --harness claude --model deepseek-v4.1 --effort high --cost normal \
  --when "Unity/FishNet implementation with asmdef awareness." \
  --avoid "Pure research." --tag unity --tag implementation \
  -- --add-dir Assets

# JSON/TOML 페이로드 파일로
herdr-loadout add --from profile.json
cat profile.toml | herdr-loadout add --from -

# 존재하는 프로필 수정 (지정한 필드만)
herdr-loadout set builder --effort high

# 이 프로젝트에서만 다르게 (전역과 다른 필드만 저장)
herdr-loadout set builder --effort high --project .

# 프로젝트 override 해제 — 전역 프로필을 다시 따름
herdr-loadout reset builder

# 삭제 (전역이면 이 프로젝트의 override 도 함께)
herdr-loadout remove builder-unity

# 목록 순서 바꾸기 (같은 그룹 안에서만: 전역끼리, 프로젝트 전용끼리)
herdr-loadout move scout --up
herdr-loadout move scout --down
herdr-loadout move scout --before builder
herdr-loadout move scout --after builder

# 기존 설정 파일을 통째로 병합
herdr-loadout import ./team-profiles.toml
```

`--project <PATH>`를 붙이면 전역 대신 해당 프로젝트 파일(`.herdr/loadout.toml`)에 쓴다. TUI 와 규칙이 같다.

| 명령 | 전역(기본) | `--project` |
|---|---|---|
| `set` | 전역 프로필 자체를 수정한다. 프로젝트 override 값은 섞이지 않는다 (이 프로젝트가 여전히 덮어쓰는 필드면 알려 준다) | 전역과 다른 필드만 저장한다. 프로젝트 전용 프로필은 전체를 저장한다. 전역 값으로 돌아가면 override 를 삭제한다 |
| `reset` | — | 프로젝트 override 를 지운다 (`--project` 생략 시 현재 디렉터리의 프로젝트). 프로젝트 전용 프로필에는 쓸 수 없다 |
| `remove` | 전역 프로필과 이 프로젝트의 override 를 함께 삭제한다 | 프로젝트 항목(override 또는 프로젝트 전용 프로필)을 삭제한다 |
| `add` | 같은 id 가 있으면 거부 | 전역에 같은 id 가 있으면 거부한다 (`set --project` 로 override) |
| `import` | 그대로 병합 | 전역에 있는 id 는 차이만 override 로 저장하고, 같으면 건너뛴다 |

`move` 는 전역/`--project` 구분을 따르지 않는다. 전역 프로필(override 된 것 포함)은 전역 파일에서, 프로젝트 전용 프로필은 프로젝트 파일에서 순서를 바꾸고, override 의 위치는 순서에 영향이 없다. `--project` 는 프로젝트를 지정할 뿐 대상 파일은 프로필이 정한다.

`move` 는 `[[profiles]]` 블록만 텍스트로 옮기므로 주석, 다른 테이블, 줄바꿈 문자는 그대로 남는다. 블록으로 옮길 수 없는 파일(인라인 배열로 쓴 프로필 등)은 아무것도 쓰지 않고 거부한다.
`move --json` 은 `{ok, id, scope, index, moved, path, order, message}` 를 출력한다. `index` 는 옮긴 뒤 목록에서의 위치(0부터), `order` 는 그 그룹의 새 순서다. 이미 그 자리라서 바뀌지 않으면 `moved: false`, `path: null` 이고 `order` 는 없다.
종료 코드: 바뀌지 않아도 `0`, 없는 id·다른 그룹이나 자기 자신을 기준으로 한 이동·블록으로 옮길 수 없는 파일은 `1`(파일은 그대로), 위치 플래그가 없거나 둘 이상이면 `2`.

`list` 는 TUI 처럼 **Global profiles** 와 **Project profiles** 로 나눠 보여 주고, override 된 프로필에는 `Overridden: effort (global: medium)` 처럼 전역과 다른 필드와 전역 값을 표시한다. `list --json` 의 `differs` 도 같은 정보다. `list --compact` 는 그대로다.
`--json`을 붙이면 기계 판독용 결과(`{ok, id, scope, path, created}`, `move` 는 위 형식)를 출력한다.
종료 코드: `0` 성공, `1` 런타임 오류, `2` 사용법/검증 오류.

같은 id가 이미 있으면 `add`는 실패한다(덮어쓰려면 `--force`, 수정하려면 `set`).

액션으로 호출할 때는 인자를 넘길 수 없으므로 페이로드 파일을 먼저 쓴다:

```bash
# 에이전트가 profile.json 을 쓴 뒤
herdr plugin action invoke herdr-loadout.add-profile
```

## 에이전트 스킬

`skills/` 에 에이전트가 읽는 스킬 두 개가 있다.

| 스킬 | 용도 |
|---|---|
| `herdr-loadout` | 프로필로 worker 에게 작업 위임 (프로젝트 설정 → 작업 방식 읽기 → 조회 → `command` 가 출력한 `herdr agent start` 또는 `hc run` 실행) |
| `herdr-loadout-edit` | 프로필과 작업 방식 추가·수정·삭제·가져오기 |

`command <id>` 는 worker 를 시작하는 호스트 명령을 실행 시점의 프로필 값으로 출력한다. 에이전트가 예전에
쓴 모델·effort 를 기억으로 다시 적지 않게 하려는 것이다. `--host herdr|hc`, `--name`, `--pane`(TUI),
`--space`·`--tab`(앱), `--cwd`(기본: 현재 폴더)를 받고, 주지 않은 값은 `<pane_id>` 같은 자리 표시로 나온다.
앱에서 `--tab self` 는 자기를 보여 주는 탭을 `herdr-app ls` 에서 찾아 쓰고, `--space` 를 주지 않으면 그 탭의 space 도 쓴다.
다른 worker 를 이끄는 worker 가 팀원을 자기 탭에 둘 때 쓴다. 앱이 새 탭에 둔 worker 에는 `herdr.tab` 라벨이 없기 때문이다.
`--shell powershell` 이면 PowerShell 따옴표 규칙으로, 기본값은 sh(bash, Git Bash, zsh) 규칙으로 감싼다.
`#` 줄은 안내다. TUI 에서 프로필에 `env` 가 있으면 pane 을 열 때 줄 `--env` 플래그를 안내로 출력한다.

`launch <id> --json` 은 같은 값을 `ok`, `harness`, `args`, `env`, `argv` 로 돌려준다.

`env` 값은 API 키일 수 있어서 `list`, `show`, `launch`, `command` 출력과 편집기(TUI·앱)에서 모두
`***` 로 가린다. 편집기의 Env 칸에서 `KEY=***` 를 그대로 두면 기존 값이 유지되고, 새 값을 적으면 바뀐다.
`command` 가 출력하는 TUI `--env` 플래그는 `"KEY=$(… env-value <id> KEY)"` 꼴이라 셸이 실행할 때 값을
읽는다. 실제 값은 `herdr-loadout env-value <id> <KEY>` 로만 나온다. 앱(`hc`)에서는 `exec` 가 값을 직접 넣는다.

### 작업 방식 (workflow)

스킬에는 명령만 있고, 위임할 때의 선택은 작업 방식 파일에 있다: 어떤 프로필 계열에 어떤 일을 맡길지,
프롬프트·brief·보고 파일 형식, 탭 쓰는 법, worker 를 언제 닫고 언제 남길지, worker 끼리 협업하는 법.
프로필처럼 두 층이다.

기본값은 분담이다. 사용자와 대화하는 에이전트도 직접 일하고, 병렬로 돌릴 일·독립 QA·조사·다른 프로필이 더 맞는 일을
worker 에게 넘긴다. 그 에이전트가 계획과 위임만 하는 오케스트레이터로 일하게 하려면 작업 방식에 그 규칙을 쓴다
(`herdr-loadout-edit` 스킬에 예시가 있다). 대화에서 사용자가 한 말은 작업 방식보다 앞선다.

| 층 | 파일 | 용도 |
|---|---|---|
| 전역 | `<설정 폴더>/workflow.md` (없으면 내장 기본값) | 모든 프로젝트 공통 |
| 프로젝트 | `<project>/.herdr/workflow.md` | 이 프로젝트만의 규칙. 전역 뒤에 붙고, 어긋나면 이쪽을 따른다 |

```bash
herdr-loadout workflow                      # 이 프로젝트에 적용되는 작업 방식 (스킬이 위임 전에 읽음)
herdr-loadout workflow init --project .     # 프로젝트 규칙 파일 만들기 (다른 점만 쓴다)
herdr-loadout workflow init                 # 내장 기본값을 전역 파일로 복사해 고치기
```

전역 파일을 만들면 그 뒤로는 사용자 파일이라, 내장 기본값이 바뀌어도 반영되지 않는다.
`herdr-loadout path` 의 `globalWorkflow`, `projectWorkflow` 가 두 파일 위치다.

### 작업 폴더와 보고

위임한 작업마다 `.herdr/runs/<YYYY-MM-DD>-<slug>/` 폴더를 하나 쓴다. `task new` 가 그 안에 `brief.md` 와 `report.md` 를
만들고, 오케스트레이터 주소(앱 `$HC_TERMINAL_ID`, TUI `$HERDR_PANE_ID`, `--to` 로 바꿈)와 worker 가 보고할 명령을 채운다.
`runs/` 를 처음 만들 때 `runs/.gitignore`(`*`)도 써서, `.herdr/` 를 커밋하는 프로젝트에서도 작업 파일은 커밋되지 않는다.
같은 폴더가 이미 있으면 거부한다.

```bash
herdr-loadout task new api-auth --worker builder-auth --profile builder   # 마지막 줄이 worker 에게 보낼 프롬프트
herdr-loadout command builder --host hc --name builder-auth --task .herdr/runs/2026-11-21-api-auth --space <space_id>
herdr-loadout worker-check builder-auth                                      # 둔 worker 에게 다시 프롬프트하기 전에
```

- 작업 id 는 slug 를 대문자로 바꾼 것이다(`api-auth` → `API-AUTH`). 보고 파일 마지막 줄은 `API-AUTH-COMPLETE`,
  `API-AUTH-PARTIAL`, `API-AUTH-BLOCKED`, `REVIEW-READY <n>` 중 하나다.
- 완료 신호는 worker 가 보낸다. 보고 파일을 쓴 뒤 `[Report-<worker>] <MARKER> <report>` 한 줄을 오케스트레이터에게
  보낸다(앱 `hc send`, TUI `herdr agent prompt`). 판단 기준은 보고 파일이고, 이 줄은 신호일 뿐이다.
- 오케스트레이터는 완료를 폴링하지 않는다. 앱에서는 보고 없이 멈춘 worker 를 알아채려고 백그라운드
  `hc wait --children any` 하나를 두고, TUI 에서는 worker 마다 `herdr agent wait <worker> --until blocked` 를 하나씩 둔다.
  앱의 watch 는 `reason` 부터 본다. `message` 반환은 `children` 이 비어 있어도 worker 가 없다는 뜻이 아니고, `children`
  반환에 worker 가 하나도 없을 때만 watch 를 멈춘다.
- 큰 구현 다음 단계는 독립 QA 다. 구현자와 하네스나 모델이 다른 `qa` 프로필이 코드를 읽기 전에 brief 에서 시나리오를 쓰고,
  실제 CLI 와 호스트(TUI 는 격리된 `herdr --session <name> server`, 앱은 끝나면 닫는 임시 hc worker)에서 돌린다. 찾은 버그는
  모두 회귀 테스트로 남기고, 라운드마다 새 QA worker 가 `qa-<n>.md` 를 쓴다. 소스 수정은 구현자에게 돌려보낸다. 코드 리뷰
  (`review-<n>.md`)는 보안에 민감한 변경(셸 인용, 비밀값, 권한)이나 사용자가 요청할 때만 한다.
- 템플릿: `<project>/.herdr/templates/brief.md`·`report.md` 가 있으면 그것을, 없으면 내장 템플릿(`src/core/templates/`)을
  쓴다. `{{task}}`, `{{worker}}`, `{{notify}}` 같은 `{{key}}` 가 채워지고, 모르는 키는 그대로 남는다.
- `command --task <폴더>` 는 worker 의 프로필과 실행 지문(harness, 인자, env 이름. 값은 넣지 않는다)을 그 폴더의
  `workers.json` 에 기록한다. 앱(`--host hc`)에서는 같은 값을 `hc run` 라벨로도 붙인다. `worker-check` 는 이 기록을
  지금 프로필, 살아 있는 worker 와 비교해 프로필이 바뀌었거나, 다른 프로필이거나, 셸로 돌아갔거나, TUI 재시작 뒤 실행
  인자를 잃었으면 이유를 출력하고 exit 1 로 끝난다. 호스트에 물을 수 없으면(CLI 가 없거나 서버가 꺼짐)
  `host-unavailable` 로 exit 1 이다. 이때는 worker 에 대해 알 수 있는 것이 없으니 다시 띄우지 말고 다시 확인한다.

### Herdr 앱에서 쓰기

스킬은 `HERDR_ENV=1` 이면 TUI(`herdr`), `HC_TERMINAL_ID` 가 있으면 앱(`hc`, `herdr-app`)으로 판단해
해당 CLI 를 쓴다. 앱에서는 `launch <id> --json --host hc` 를 쓴다.

- `argv` 가 worker 명령 전체다: `hc run --bg --name <name> --cwd <dir> --label herdr.space=<space> -- <argv...>`.
- `hc run` 은 환경 변수를 넘길 수 없으므로, `env` 가 있는 프로필의 `argv` 는
  `herdr-loadout exec <id>` 를 거친다. `exec` 가 env 를 적용해 harness 를 띄우고 종료 코드를 그대로 돌려준다.
  인자에 큰따옴표가 있을 때(agy `--settings` JSON 등)도 같은 경로를 쓴다. Windows PowerShell 5.1 이
  네이티브 명령에 넘기는 인자에서 큰따옴표를 지우기 때문이다.
- Codex 는 `hc` 아래에서 `--no-daemon` 이 필요해 `--host hc` 일 때 자동으로 붙는다.
- 앱에는 플러그인 액션이 없다. launcher 가 없으면 소스 체크아웃에서 `node scripts/setup-shim.mjs` 로 만든다.

스킬 파일은 라이브러리로 복사되므로 줄바꿈을 LF 로 고정했다(`.gitattributes`).

## 프로필 필드

필수: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
선택: `avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`, `api`, `auth`

`api` 는 하네스가 자체 로그인 대신 저장된 API 키로 실행되게 한다. 값은 저장된 키의 id 이고, 비우면 하네스 자체
로그인(구독)을 쓴다. 지원하는 조합:

| 하네스 | 제공자 | 연결 방식 |
|---|---|---|
| claude | DeepSeek | DeepSeek 의 Anthropic 호환 엔드포인트 (`https://api.deepseek.com/anthropic`) |
| agy | Google AI Studio | Gemini API |

Codex 는 Responses API 만 받는다(0.170 기준 `wire_api = "chat"` 거부). DeepSeek·Google 은 Responses API 를 제공하지
않아 Codex 에는 붙일 수 없다.

키는 프로필이 아니라 전역 설정 폴더의 `keys.toml` 에 따로 저장된다. 프로젝트 파일에는 들어가지 않으므로 저장소에
커밋될 일이 없고, 모든 출력에서 끝 네 자리만 보인다(`sk-…1a2b`).

```bash
herdr-loadout keys add deepseek --provider deepseek   # 키는 stdin 으로 받는다 (터미널이면 가려진 입력)
herdr-loadout keys list                               # 저장된 키(가린 값)와 제공자
herdr-loadout keys test deepseek                      # 제공자에게 키가 통하는지 묻는다
herdr-loadout set <id> --api deepseek                 # 프로필이 그 키로 실행된다
```

앱 편집기에서는 `k`(API 키 화면)에서 키를 추가·테스트·삭제하고, claude/agy 프로필의 API 칸에서 고른다. 키를 고르면
모델 목록이 그 제공자의 목록(DeepSeek `/models`, Gemini API)으로 바뀐다.

실행할 때 넣는 것:

- claude + DeepSeek: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=<키>`, `ANTHROPIC_MODEL`·`ANTHROPIC_DEFAULT_OPUS_MODEL`·
  `ANTHROPIC_DEFAULT_SONNET_MODEL`=`<모델>[1m]`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, 그리고 상속된 `ANTHROPIC_API_KEY` 를 비운다. `--model` 도 `<모델>[1m]`(1M 컨텍스트 표시,
  요청 전에 Claude Code 가 떼어 낸다)로 넘긴다. DeepSeek 의 Claude Code 안내를 따른 값이다.
- agy + Google: `GEMINI_API_KEY=<키>` 와 `--settings <상태 폴더>/agy-api/…/settings.json`(`{"modelProvider":"gemini"}`).
- 프로필의 `env` 가 같은 이름을 정하면 그 값이 이긴다. 키가 없거나 하네스와 맞지 않으면 `launch` 의 `API key` 검사가 실패한다.

agy 의 `auth = "api-key"` 도 계속 동작한다. 이때 키는 프로필 `env.GEMINI_API_KEY` 나 worker 환경의 `GEMINI_API_KEY` 에서 읽는다.
agy 에 내장된 API 모델 목록은 agy 빌드 시점에 고정되어 새 모델이 빠진다. 그래서 목록을 읽을 때마다 키(환경의
`GEMINI_API_KEY`, 프로필의 키, 저장된 Google 키 순)로 Gemini API 의 모델 목록을 조회해, agy 에 없는 Gemini
모델을 같은 settings 파일의 `customModelsConfig` 에 custom model 로 등록한다. 새 모델은 편집기의 모델 목록과
`--model` 에 바로 쓰인다. 조회에 실패하면 지난번에 찾은 목록을 그대로 쓴다.

프로필별 권한은 TUI 또는 `set --sandbox ... --approval-policy ... --permission-mode ...`로
설정한다. 하네스별 지원 값, 프로젝트 덮어쓰기, 실행 환경변수 전달 방법은
[권한 설정 안내](./docs/permissions.md)를 참고한다.

`harness` 는 `claude`, `codex`, `opencode`, `omp`, `pi`, `agy`(Antigravity CLI), `custom` 중 하나다.
`custom` 이 아니면서 목록에 없는 값은 검증에서 거부된다.

## harness 별 인수 매핑

| harness | model | effort | 비고 |
|---|---|---|---|
| `claude` | `--model` | `--effort` | 목록 명령이 없어 **omp 의 Anthropic 카탈로그에서 파생**. omp 가 없으면 별칭(opus/sonnet/haiku/fable)으로 폴백 |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | `codex debug models` 로 카탈로그 조회 |
| `opencode` | v1: `-m` · v2: config `model` | v2: config `model` 의 `#variant` (v1 은 전달 안 됨) | `opencode models` 로 조회. 설치된 버전(`opencode --version`)을 보고 인수를 고른다. v2 TUI 에는 `-m` 이 없어 모델·effort·권한을 `OPENCODE_CONFIG_CONTENT` 로 넘기고, 이 env 를 읽도록 `--standalone` 을 붙인다(공유 백그라운드 서버는 워커 env 를 무시한다) |
| `omp` | `--model=` | `--thinking=` | `omp models --json` 으로 조회(thinking 레벨 포함) |
| `agy` | `--model` | `--effort` | Antigravity CLI. `agy models` 로 조회. Herdr `--kind agy` 와 같은 id. `gemini-3.8-flash-medium` 처럼 id 가 `-low`·`-medium`·`-high` 등으로 끝나면 effort 는 그 값으로 정해지고 `--effort` 는 붙지 않는다. 편집기는 이런 id 를 모델 하나(`gemini-3.8-flash`)로 묶어 보여 주고, 레벨은 Effort 에서 고른다(저장되는 값은 `gemini-3.8-flash-medium` 같은 전체 id) |
| `custom` | `--model` | `--effort` | 자유 입력 |

## 검증 방법

```bash
node --test          # 단위 테스트
```

실제 동작 확인(수동, Herdr 필요):

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
herdr pane read <pane_id> --source visible     # 렌더 확인
herdr pane send-keys <pane_id> down            # 키 입력 확인
herdr pane close <pane_id>
herdr plugin unlink herdr-loadout              # 정리
```

플러그인 pane 은 그 안의 프로세스가 종료되면 자동으로 닫힌다(실측).

## 설계 노트

- Herdr 는 플러그인에 CLI 서브커맨드를 추가할 수 없다. 그래서 `herdr-loadout` 은 별도 실행 파일이다.
- 플러그인 pane 은 **pane 의 cwd** 에서 명령이 실행된다. 따라서 매니페스트 명령은
  `bootstrap.mjs`(플러그인 루트 기준으로 모듈을 해석)를 거치며, 프로젝트 경로는
  pane cwd 가 아니라 Herdr 가 주입하는 `HERDR_PLUGIN_CONTEXT_JSON` 에서 읽는다.
- `herdr plugin action invoke` 는 인자를 받지 못하고 stdout 도 돌려주지 않는다(비동기 fire-and-forget).
  따라서 조회 경로는 CLI 이고, 액션은 UI 열기 전용이다.
- 프로필/모델 탐색이 실패해도 프로필 생성은 막히지 않는다. 카탈로그는 5분 TTL 로 캐시된다.
- `claude` 는 모델 목록 명령이 없어 **models.dev**(omp 가 쓰는 공개 카탈로그)에서 파생한다.
  우선순위: models.dev 스냅샷(24시간 TTL) → omp → 별칭. 셋 다 오프라인에서 동작한다.
- models.dev 스냅샷은 `herdr-loadout catalog --refresh` 로 갱신한다.

자세한 실측 근거는 [`docs/herdr-verified-facts.md`](./docs/herdr-verified-facts.md),
구현 계획은 [`docs/implementation-plan.md`](./docs/implementation-plan.md) 참고.

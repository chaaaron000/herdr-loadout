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
- Herdr ≥ 0.7.0
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
builder | normal | implementation/refactor
reviewer | cheap | review
scout | cheap | research
heavy | expensive | design
```

### 3. 설정 파일

| 파일 | 용도 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 전역 프로필 |
| `<project>/.herdr/loadout.toml` | 프로젝트 오버라이드 (지정한 필드만 덮어씀) |

`herdr-loadout path` 로 실제 경로를 확인한다. 손으로 편집해도 되며, 알 수 없는 키는 저장 시에도 보존된다.

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

### 4. Director 용 AGENTS.md 스니펫

```md
## Delegation

Use Herdr workers when delegation is beneficial.

Before delegating:
1. Query available agent profiles: `herdr-loadout list --compact`
2. Choose the profile whose usage description best matches the task: `herdr-loadout show <id>`
3. Prefer the cheaper suitable profile when multiple profiles are appropriate.
4. Use an independent reviewer for substantial code changes.
5. Do not delegate trivial work.

Use the Herdr skill for spawning, messaging, waiting, and reading worker results.
Launch workers with the profile's harness/model/effort via `herdr agent start`.
```

모델/하네스 교체는 프로필만 수정하면 된다. AGENTS.md 는 바뀌지 않는다.

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

`list` 는 TUI 처럼 **Global profiles** 와 **Project profiles** 로 나눠 보여 주고, override 된 프로필에는 `Overridden: effort (global: medium)` 처럼 전역과 다른 필드와 전역 값을 표시한다. `list --json` 의 `differs` 도 같은 정보다. `list --compact` 는 그대로다.
`--json`을 붙이면 기계 판독용 결과(`{ok, id, scope, path, created}`)를 출력한다.
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
| `herdr-loadout` | 프로필로 worker 에게 작업 위임 (조회 → `launch --json` → `herdr agent start`) |
| `herdr-loadout-edit` | 프로필 추가·수정·삭제·가져오기 |

`launch <id> --json` 은 `ok`, `harness`, `args`, `env` 를 돌려준다. `args` 는
`herdr agent start <name> --kind <harness> --pane <pane_id> -- <args...>` 뒤에 그대로 붙인다.
`env`의 각 항목은 pane 생성 시 `herdr pane split --env 'KEY=VALUE'`로 전달한다.
스킬 파일은 라이브러리로 복사되므로 줄바꿈을 LF 로 고정했다(`.gitattributes`).

## 프로필 필드

필수: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
선택: `avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`

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
| `opencode` | `-m` | `--variant` | `opencode models` 로 조회 |
| `omp` | `--model=` | `--thinking=` | `omp models --json` 으로 조회(thinking 레벨 포함) |
| `agy` | `--model` | `--effort` | Antigravity CLI. `agy models` 로 조회. Herdr `--kind agy` 와 같은 id |
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

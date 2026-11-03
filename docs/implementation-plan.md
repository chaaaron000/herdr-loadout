# 구현 계획 — Herdr Agent Profiles+

근거: `herdr_agent_profile_plugin_requirements.md`(요구사항) + `docs/herdr-verified-facts.md`(실측).
대상 Herdr 0.9.1(macOS/Linux는 `[INFERENCE]`), Node ≥ 22, Windows 1급.

---

## 0. 요구사항 대비 확정된 설계 변경 (실측 근거)

| 요구사항 | 실측 결과 | 확정안 |
|---|---|---|
| §4.1 `herdr profiles list` | Herdr는 플러그인 서브커맨드 추가를 지원하지 않음(`unknown command: profile`, `herdr api`는 `snapshot\|schema`뿐) | **독립 실행 파일 `herdr-loadout`** 제공. Director는 `herdr-loadout list --compact` 호출. `herdr`에 붙는 슈가만 상실 |
| 액션으로 CLI 제공 | `plugin action invoke`는 인자 전달 불가(`unknown option: --`), stdout 미반환(로그에만 기록), 즉시 반환(`status: running`) | 액션은 **UI 열기 전용**. 모든 조회는 `herdr-loadout` 실행 파일 경로 |
| §5 GUI | PTY·raw 입력·리사이즈·팝업 모두 동작. 팝업은 세션 모달 싱글턴(pane ID 없음, `ui_busy`) | Ink TUI. 기본 `overlay` 배치, `--placement popup` 오버라이드 허용 |
| §5.3 모델 자동 탐색 | codex=`codex debug models`, opencode=`opencode models`, omp=`omp models --json` 실측 성공. claude=카탈로그 없음 | 하네스별 어댑터 + 5분 TTL 캐시 + **실패해도 자유 입력 허용** |
| §6.2 프로젝트 오버라이드 | Herdr에 project-scoped plugin config 없음 | 프로젝트 내부 파일 `<project>/.herdr/loadout.toml` (cwd 상향 탐색) |
| §8 Test Launch | — | MVP는 **dry-run**(실행 파일 해석 + 모델/effort 검증). 실제 pane 실행은 후속 |

### 0.1 네이밍 (단일 이름 `herdr-loadout`)

`profiles`는 너무 흔한 단어라 PATH·설정 파일·프로젝트 디렉터리에서 충돌 위험이 크므로, 프로젝트 이름 그대로
**`herdr-loadout` 하나로 통일**한다.

| 대상 | 이름 |
|---|---|
| 저장소 / 제품명 | `herdr-loadout` |
| 플러그인 id (매니페스트) | `herdr-loadout` |
| CLI 실행 파일 (`bin/`) | `herdr-loadout` |
| PATH 심(shim) | `herdr-loadout.cmd` / `herdr-loadout.ps1` / `herdr-loadout`(sh) |
| global 설정 파일 | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` |
| project override 파일 | `<project>/.herdr/loadout.toml` |
| 환경변수(사용 시) | `HERDR_LOADOUT_*` |
| TOML 도메인 테이블 | `[[profiles]]` 유지 — "agent profile"은 제품이 아니라 개념명 |

요구사항 문서의 `herdr profiles …` 표기는 이 문서 §0의 대체 계약으로만 해석한다.

---

## 1. 범위

포함(MVP): 플러그인 매니페스트, Windows 지원, Profiles TUI(list/editor/CRUD/duplicate), global TOML 저장, project override, `list`/`list --compact`/`show`/`path`/`validate`, 하네스 탐지, 모델·effort 자동 탐색(실패 허용), Test Launch dry-run.
제외(요구사항 §12/§14와 동일): 자동 routing, Jev, worker spawn, worktree, DAG, scheduler, memory, 자체 daemon.

---

## 2. 아키텍처

```text
Director (AGENTS.md 규칙)
   │  herdr-loadout list --compact  /  herdr-loadout show <id>
   ▼
herdr-loadout 실행 파일 ── 읽기/쓰기 ─► loadout.toml            (global, HERDR_PLUGIN_CONFIG_DIR)
   │                        └─ 덮어쓰기 ─► <project>/.herdr/loadout.toml
   │
   ├── adapters: harness detect / model catalog / effort table   (5분 TTL 캐시: STATE_DIR)
   │
   └── TUI (Ink, plugin pane) ── 같은 core 모듈 사용
        └── Test Launch dry-run
Herdr Skill  ← Director가 프로필 선택 후 실행 담당 (플러그인은 관여하지 않음)
```

플러그인 경계: pane 생성·agent lifecycle·메시징은 **하지 않는다**. `open-ui` 액션이 자기 UI pane을 여는 것만 예외(요구사항 §5 GUI 자체 기능).

### 2.1 저장소 구조

```text
herdr-plugin.toml            # manifest: id "herdr-loadout", [[actions]] open-ui/open-ui-popup/install-shim, [[panes]] ui
package.json                 # ink@7, react@19, smol-toml / bin: herdr-loadout
bin/herdr-loadout.mjs        # CLI 진입점 (node:util parseArgs)
src/core/paths.mjs           # config/state/plugin root, 프로젝트 파일 탐색
src/core/store.mjs           # TOML load/save (unknown key 보존), 원자적 쓰기
src/core/schema.mjs          # Profile 검증, 기본 템플릿(Builder/Junior/Reviewer/Scout)
src/core/merge.mjs           # global + project override 병합
src/core/format.mjs          # list / list --compact / show 렌더러
src/core/detect.mjs          # 하네스 탐지 (PATHEXT, .exe/.cmd/.ps1)
src/core/adapters/*.mjs      # claude|codex|opencode|omp|generic: 모델 목록·effort 표·args 빌더
src/core/cache.mjs           # STATE_DIR JSON 캐시 (TTL)
src/core/launch.mjs          # Test Launch dry-run
src/tui/*.mjs                # Ink 화면: List, Editor, 필드 편집기, 상태줄
scripts/setup-shim.mjs       # config dir에 herdr-loadout.cmd / .ps1 / (sh) 생성
test/*.test.mjs              # node:test
docs/*                       # 본 계획, 실측 사실, 사용법
```

모든 코드는 ESM `.mjs`. 런타임 의존성 3개(ink, react, smol-toml)로 제한.

### 2.2 데이터 모델

`loadout.toml` (global, `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml`):

```toml
version = 1

[[profiles]]
id = "builder"
name = "Builder"
harness = "claude"
model = "deepseek-v4.1"
effort = "medium"
cost = "normal"
when_to_use = "..."
avoid_when = "..."
# 선택: provider, mode, extra_args[], env{}, tags[], skills[], notes
```

`<project>/.herdr/loadout.toml` (override): 동일 스키마, `id`만 필수. 지정된 필드만 덮어쓴다.
우선순위: `project.profiles[id]` 필드 → `global.profiles[id]` 필드 → 기본값.

검증 규칙: `id`는 `^[a-z0-9][a-z0-9._-]*$`이고 global 내 유일, `harness`는 허용 목록 또는 `custom`,
`cost ∈ {cheap, normal, expensive}`, `effort`는 하네스별 허용값(미지정 하네스는 자유 문자열),
`extra_args`/`env` 타입 검사. 검증 실패 시 파일 전체를 거부하지 않고 해당 프로필만 오류로 표시한다(§15 시나리오 E 보호).

`store.mjs` 규약: 파싱된 TOML 문서 객체를 그대로 보관하고 알려진 필드만 변조한 뒤 `stringify` → **미지 키·주석 없는 키 순서 보존**(smol-toml 왕복 멱등성 실측). 쓰기는 temp 파일 + rename(원자적). 파일이 없으면 기본 템플릿 4종으로 시드.

### 2.3 CLI 계약

```bash
herdr-loadout list [--compact] [--json] [--all] [--project PATH]
herdr-loadout show <id> [--json] [--project PATH]
herdr-loadout path [--project PATH]
herdr-loadout validate [--json]
herdr-loadout detect [--json]      # 하네스 설치 상태 + 모델 카탈로그 요약
```

- `list`: 요구사항 §4.1 형식.
- `list --compact`: **한 줄에 한 프로필** `id | cost | tags`. `tags`가 비면 `when_to_use` 첫 문장을 40자로 절단. 헤더·색·장식 없음.
  ```
  builder | normal | implementation/refactor
  reviewer | cheap | independent review
  ```
- `show <id>`: 요구사항 §4.2 형식(라벨 + 값).
- 종료 코드: `0` 성공, `1` 런타임 오류, `2` 사용법 오류. stderr에만 진단 출력.
- `--json`은 기계 판독용(향후 필요 대비, Director는 사용하지 않음).

실행 파일 해석 순서(모든 명령 공통, `paths.mjs`가 담당):

```text
1) CLI 자신의 위치        (shim → bin/herdr-loadout.mjs)
2) HERDR_PLUGIN_ROOT/bin  (Herdr가 주입한 env, 링크된 소스에서 직접 실행)
3) HERDR_PLUGIN_CONFIG_DIR/../..  → 링크/설치된 플러그인 루트 추정
4) PATH의 herdr-loadout   (shim이 설치된 경우)
```

`HERDR_PLUGIN_CONFIG_DIR`·`HERDR_PLUGIN_ROOT`가 없으면(= 일반 셸에서 직접 실행) 4) 및
`$XDG_CONFIG_HOME`/`%APPDATA%`의 herdr 플러그인 설정 경로로 폴백한다. 어느 경로로 실행되든
동일한 `loadout.toml`을 읽도록 `paths.mjs` 단위 테스트로 고정한다.

Director 경로(요구사항 §11 준수): `AGENTS.md` 한 조각 + `list --compact` 1회 호출. 프로필 전체 JSON 주입·worker 컨텍스트 주입 없음.

### 2.4 TUI 계약

- 화면: List(프로필 목록 + 요약줄) → Editor(필드 편집) → 저장/취소/복제/삭제/Test Launch.
- 드롭다운 값(harness/effort/cost)은 어댑터 결과 사용. 탐색 실패 시 자유 입력 폴백.
- List에 하네스 탐지 상태(`✓ detected` / `✗ not found`) 표시(요구사항 §5.4).
- 팝업 배치에서도 최소 60x16에서 동작(실측 크기) — 좁은 레이아웃 모드 필수.
- 프로세스 종료 = pane 자동 닫힘. 취소/뒤로가기는 pane을 닫지 않고 List로 복귀.
- 외부 프로세스 실행은 dry-run만. 실제 `herdr pane split`/`agent start` 호출 금지(MVP).

---

## 3. 단계별 계획

각 단계는 **실행 가능한 산출물 + 관찰 가능한 수용 기준**을 가진다. 단계 경계에서 커밋.

### Phase 1 — 코어 & 저장소 (기반)
작업: `paths`, `store`(원자적 쓰기·unknown key 보존·시드), `schema`(검증·기본 템플릿), `merge`, `format`.
테스트(node:test): 왕복 멱등성, 미지 키 보존, 시드 멱등성, 검증 실패 케이스(id 중복/잘못된 cost/잘못된 타입), override 병합(부분 override, project 전용 프로필, global 전용 유지).
수용: `node --test` 통과 + 손으로 만든 손상 TOML에 대해 파일을 덮어쓰지 않고 오류 보고.

### Phase 2 — CLI & 심
작업: `bin/herdr-loadout.mjs`, `list/show/path/validate`, 프로젝트 탐색(cwd 상향), `scripts/setup-shim.mjs`(cmd/ps1/sh), 매니페스트에 `install-shim` 액션.
수용(실측 절차): `herdr plugin link` → `node bin/herdr-loadout.mjs list --compact` 실제 출력 확인 → shim `herdr-loadout.cmd`를 PATH에 넣고 `herdr-loadout list --compact` 동일 출력 확인(스파이크에서 shim+인자 전달 실측 완료) → `--project` override로 값 변경 확인 → 종료 코드 1/2 케이스 확인.

### Phase 3 — 탐지 & 어댑터
작업: `detect`(PATHEXT/.exe/.cmd/.ps1), 어댑터 4종 + generic, 5분 TTL 캐시, 실패 시 자유 입력, effort 매핑표.
수용: `herdr-loadout detect`로 이 머신에서 `claude ✓ / codex ✓ / opencode ✓ / omp ✓ / pi ✗` 표시(실측값과 일치) → `codex debug models`·`opencode models`·`omp models --json` 파싱 결과가 `detect --json`에 반영 → 네트워크/미설치 상황에서 3초 내 실패하고 프로필 생성은 계속 가능.

### Phase 4 — TUI
작업: Ink 화면(목록/편집/CRUD/복제/dry-run), 좁은 레이아웃, 매니페스트 `ui` pane + `open-ui` 액션.
수용(실측 절차, 스파이크 방법 재사용): `herdr plugin pane open --entrypoint ui` → `pane read --source visible`로 목록 렌더 확인 → `pane send-keys down/down`으로 선택 이동 확인 → 편집 진입·저장 후 `herdr-loadout show`로 값 반영 확인 → popup 배치에서 60x16 렌더 확인 → 프로세스 종료로 pane 자동 정리 확인.

### Phase 5 — 프로젝트 오버라이드 완성 + Windows/문서 + 스모크
작업: override 전 경로 통합 테스트, Windows 경로·PATHEXT 마감, README(설치·PATH·사용법), `AGENTS.md` 스니펫 제공(§2.3 원문), 요구사항 대비 미구현 목록 명시, 최종 end-to-end 스모크.
수용: 시나리오 A~E 중 A(작성)·B(조회)·C(프로필 확정 후 herdr skill로 실행은 문서 절차로 안내)·E(모델 교체 시 AGENTS.md 불변) 확인. C의 worker 실행은 Director/Herdr Skill 몫이므로 문서 검증으로 대체하고, 플러그인은 "선택한 설정 문자열"까지만 책임진다.

---

## 4. 검증 전략

- 단위: `node --test` — store/schema/merge/format/detect(주입된 spawn), 캐시 TTL.
- 통합(수동 실행): Phase 2·4 수용 절차를 그대로 수행. 스파이크에서 이미 확립한 관찰법 사용:
  `herdr plugin link` → `plugin pane open` → `pane send-keys` → `pane read --source visible` → `plugin pane close`/`plugin unlink`.
- 판정 기준: 화면 텍스트에 프로필 이름·상태줄이 실제로 보이고, 키 입력 후 화면이 바뀌고, 저장 후 `herdr-loadout show`가 새 값을 출력하면 통과.
- 스모크 정리는 항상 `herdr pane close` + `herdr plugin unlink`까지. pane 프로세스가 살아 있으면 pane이 남는다(실측).

## 5. 리스크 & 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| Node 부재/버전 낮음 | 플러그인 실행 불가 | README에 Node ≥ 22 명시, `detect`/문서로 사전 확인. ink 7 실측했고, 필요 시 ink 6(Node ≥20)로 하향 |
| `plugin action invoke` 비동기·인자 불가 | Director 조회 경로 붕괴 | 확정안: `herdr-loadout` 실행 파일. 매니페스트 액션은 UI 전용 |
| 팝업 모달 충돌(`ui_busy`) | UI가 안 열림 | 기본 overlay, 팝업은 옵션. 오류 시 사용자에게 메시지 |
| 모델 카탈로그 명령이 미래 버전에서 변경 | 탐지 실패 | 어댑터별 try/catch + 자유 입력 폴백 + 캐시 |
| 미지 키 삭제로 사용자 파일 손상 | 데이터 손실 | 파싱 문서 객체 보존·부분 변조 방식(Phase 1 테스트로 고정) |
| Windows 경로(`/tmp`, `-W`) | 링크/실행 실패 | 모든 경로 `node:path` 처리, 스크립트에서 네이티브 경로 사용, 문서에 Git Bash `pwd -W` 주의 |

## 6. 완료 후 남는 선택 작업 (요구사항 §13)

`extends`, capability 태그, 상대 비용, import/export(Paseo/기존 herdr-agent-profiles), profile pack, Test Launch 실제 실행. 사용에서 반복 필요가 확인될 때만.

## 7. 저장소

- `git init -b main` 완료(로컬). 브랜치 전략: `main` + 단계별 커밋(Phase 1~5).
- GitHub 공개는 사용자 확인 후: `gh repo create <owner>/herdr-loadout --public --source . --push` + 저장소 토픽 `herdr-plugin`(마켓플레이스 등록 조건, §문서 marketplace).
- 커밋 메시지: `phase<N>: <scope> — <observable result>`.

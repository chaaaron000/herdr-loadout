# 사용법

`herdr-loadout` 는 Herdr 용 에이전트 프로필 레지스트리다. Director 와 사용자만 이 플러그인을
알면 되고, worker 에이전트에게는 프로필 목록을 주입하지 않는다.

## 설치

```bash
npm install
herdr plugin link "$(pwd -W 2>/dev/null || pwd)"
herdr plugin action invoke herdr-loadout.install-shim   # 선택: launcher 설치 (PATH 는 건드리지 않음)
```

## 프로필 만들기

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

TUI 에서 `a` 로 새 프로필, `e` 로 편집, `s` 로 저장, `j` 로 harness 탐지 화면, `q` 로 종료.

## Director 가 쓰는 명령

```bash
herdr-loadout list --compact     # id | cost | purpose (한 줄에 하나)
herdr-loadout show builder       # 선택한 프로필의 상세
```

`list --compact` 는 헤더가 없다. 각 줄은 정확히 세 필드이며 `|` 로 구분된다.

## 프로젝트 오버라이드

`<project>/.herdr/loadout.toml` 에 바꾸고 싶은 필드만 적는다. 나머지는 전역 프로필을 따른다.

```toml
[[profiles]]
id = "builder"
effort = "high"
extra_args = ["--add-dir", "Assets"]
```

## 검증

```bash
herdr-loadout validate           # 설정 검증
herdr-loadout detect             # 설치된 harness + 모델 카탈로그
herdr-loadout launch builder     # Test Launch (dry-run, 프로세스를 띄우지 않음)
node --test                      # 단위 테스트
```

## 파일 위치

```bash
herdr-loadout path
```

| 대상 | 경로 |
|---|---|
| 전역 설정 | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` |
| 프로젝트 설정 | `<project>/.herdr/loadout.toml` |
| 모델 캐시 | `<HERDR_PLUGIN_STATE_DIR>/models/*.json` (TTL 5분) |

전역 설정이 없으면 기본 템플릿(Builder / Junior / QA / Reviewer / Scout)으로 자동 생성된다.

# 프로필별 하네스 권한

편집 화면에는 선택한 하네스의 권한 항목만 표시된다. Codex는 `Sandbox (Codex)`와
`Approval (Codex)`, Claude·OMP·OpenCode·Antigravity(`agy`)는 `Permissions`를 선택한다.
각 목록에는 현재 하네스가 지원하는 값과 `inherit`가 표시된다.

| 하네스 | 프로필 필드 / CLI 옵션 | 값 | 실행 적용 |
|---|---|---|---|
| Codex | `sandbox` / `--sandbox` | `read-only`, `workspace-write`, `danger-full-access` | `--sandbox` |
| Codex | `approval_policy` / `--approval-policy` | `on-request`, `never` | `--ask-for-approval` |
| Claude | `permission_mode` / `--permission-mode` | `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions` | `--permission-mode` |
| OMP | `permission_mode` / `--permission-mode` | `always-ask`, `write`, `yolo` | `--approval-mode=` |
| OpenCode | `permission_mode` / `--permission-mode` | `ask`, `allow`, `deny` | `OPENCODE_CONFIG_CONTENT`의 `permission` |
| Antigravity (`agy`) | `permission_mode` / `--permission-mode` | `accept-edits`, `plan`, `dangerously-skip-permissions` | `accept-edits`·`plan`은 `--mode`, 나머지는 `--dangerously-skip-permissions` |
| Pi / custom | — | 전용 설정 없음 | 기존 `extra_args` / `env` 사용 |

```bash
herdr-loadout set builder --sandbox workspace-write --approval-policy on-request
herdr-loadout set reviewer --permission-mode plan
herdr-loadout set omp-builder --permission-mode write
herdr-loadout set opencode-scout --permission-mode ask
herdr-loadout launch builder --json
```

필드를 생략하면 기존 실행 동작을 유지한다. TUI의 `inherit`는 빈 문자열로 저장되어
프로젝트에서 전역 값을 해제할 때도 사용할 수 있다. CLI에서는 JSON/TOML 입력으로
빈 문자열을 넘길 수 있다. Claude·Antigravity의 기존 `mode`는 권한 모드, Codex의 기존 `mode`는
승인 정책으로 계속 동작하지만, 새 필드가 있으면 빈 문자열인 경우에도 새 필드가 우선한다.
Antigravity의 `--sandbox`(터미널 제한)는 값이 없는 스위치라 `extra_args`로 지정한다.
하네스를 TUI에서 변경하면 기존 권한 값은 해제된다. CLI에서 하네스를 바꿀 때는
해당 하네스에 맞는 권한 값을 함께 지정하거나 기존 값을 빈 문자열로 해제한다.

`launch --json`은 권한을 검증하고 `args`와 `env`를 반환한다. `ok`가 true인 경우
`args`를 `herdr agent start ... --` 뒤에 그대로 전달한다. `env`의 각 항목은 새 pane을
만들 때 `herdr pane split --env 'KEY=VALUE'`로 전달한다. JSON을 포함한 값 전체를
하나의 인자로 전달해야 한다. `launch`는 실행 명세를 반환하는 dry-run이다.

OpenCode는 프로필의 `env.OPENCODE_CONFIG_CONTENT` 또는 상속된 같은 환경변수에 있는
JSON 객체의 다른 키를 보존하고 `permission`을 지정한 값으로 교체한다. 이 환경변수에
잘못된 JSON이 있으면 실행 검사가 실패한다. 하네스의 관리 정책·에이전트별 설정은
하네스 자체 규칙을 따르며, `extra_args`는 기존과 같이 마지막에 전달된다.
권한을 `extra_args`에도 중복 지정하면 하네스의 옵션 처리 규칙이 적용된다.

Claude와 OpenCode의 동작은 [Claude 권한 문서](https://code.claude.com/docs/en/permissions),
[OpenCode 권한 문서](https://opencode.ai/docs/permissions/),
[OpenCode 설정 우선순위](https://opencode.ai/docs/config/#precedence-order)를 참고한다.
Codex, OMP, Antigravity의 선택 값은 설치된 CLI의 `--help`에서 확인했다.

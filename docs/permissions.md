# 프로필별 하네스 권한

편집 화면에는 선택한 하네스의 권한 항목만 표시된다. Codex는 `Sandbox (Codex)`와
`Approval (Codex)`, Claude·OMP·OpenCode·Antigravity(`agy`)는 `Permissions`를 선택한다.
각 목록에는 현재 하네스가 지원하는 값과 `inherit`가 표시된다.

| 하네스 | 프로필 필드 / CLI 옵션 | 값 | 실행 적용 |
|---|---|---|---|
| Codex | `sandbox` / `--sandbox` | `read-only`, `workspace-write`, `danger-full-access` | `--sandbox` |
| Codex | `approval_policy` / `--approval-policy` | `on-request`, `never`, `approve-for-me`, `bypass` | `on-request`·`never`는 `--ask-for-approval`, `approve-for-me`는 `--approve-for-me`, `bypass`는 `--dangerously-bypass-approvals-and-sandbox` |
| Claude | `permission_mode` / `--permission-mode` | `manual`, `acceptEdits`, `auto`, `dontAsk`, `plan`, `bypassPermissions` | `--permission-mode` |
| OMP | `permission_mode` / `--permission-mode` | `always-ask`, `always-ask-cached`, `write`, `yolo` | `--approval-mode=` |
| OpenCode | `permission_mode` / `--permission-mode` | `ask`, `allow`, `deny`, `auto` | `ask`·`allow`·`deny`는 `OPENCODE_CONFIG_CONTENT`의 `permission`, `auto`는 `--auto` |
| Antigravity (`agy`) | `permission_mode` / `--permission-mode` | `accept-edits`, `auto`, `plan`, `dangerously-skip-permissions` | `accept-edits`·`auto`·`plan`은 `--mode`, 나머지는 `--dangerously-skip-permissions` |
| Pi / custom | — | 전용 설정 없음 | 기존 `extra_args` / `env` 사용 |

자동 승인 모드:

- Codex `approve-for-me`는 승인 요청을 Codex의 자동 검토로 보내고 `workspace-write` 샌드박스를 쓴다.
  `bypass`는 확인과 샌드박스를 모두 끈다(외부에서 격리된 환경 전용). Codex가 두 스위치를
  `--sandbox`와 함께 받지 않으므로, 이 값을 쓸 때 `sandbox`를 지정하면 검증 오류가 난다.
- OpenCode `auto`는 명시적으로 금지하지 않은 권한을 자동 승인한다. 설정 JSON의 `permission`을
  바꾸지 않으므로 프로젝트나 사용자 설정의 `deny` 규칙은 그대로 지켜진다.
- OMP `always-ask-cached`는 OMP의 `tools.approvalMode` 값으로 그대로 넘긴다(`omp --help` 기준).

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

`launch --json`은 권한을 검증하고 `args`와 `env`를 반환한다. `env`는 이름만 그대로이고 값은
API 키일 수 있어 모두 `***`로 가린다. `ok`가 true인 경우 `args`를 `herdr agent start ... --`
뒤에 그대로 전달한다. `env`는 `herdr-loadout command <id>`가 출력하는 `--env` 플래그로 새 pane에
전달한다. 이 플래그는 실행될 때 `env-value`로 값을 읽으므로 출력에는 값이 나오지 않는다.
`launch`는 실행 명세를 반환하는 dry-run이다.

OpenCode는 프로필의 `env.OPENCODE_CONFIG_CONTENT` 또는 상속된 같은 환경변수에 있는
JSON 객체의 다른 키를 보존하고 `permission`을 지정한 값으로 교체한다. OpenCode v2에서는
같은 JSON에 `model`(`provider/model#effort`)도 넣고 `--standalone`을 붙인다. v2의 공유
백그라운드 서버는 워커의 환경변수를 읽지 않기 때문이다. 이 환경변수에
잘못된 JSON이 있으면 실행 검사가 실패한다. 하네스의 관리 정책·에이전트별 설정은
하네스 자체 규칙을 따르며, `extra_args`는 기존과 같이 마지막에 전달된다.
권한을 `extra_args`에도 중복 지정하면 하네스의 옵션 처리 규칙이 적용된다.

Claude와 OpenCode의 동작은 [Claude 권한 문서](https://code.claude.com/docs/en/permissions),
[OpenCode 권한 문서](https://opencode.ai/docs/permissions/),
[OpenCode 설정 우선순위](https://opencode.ai/docs/config/#precedence-order)를 참고한다.
Codex, OMP, Antigravity의 선택 값은 설치된 CLI의 `--help`에서 확인했다.

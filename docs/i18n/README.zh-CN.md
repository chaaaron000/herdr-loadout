# herdr-loadout

**语言:** [한국어](../../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md)

Herdr 的轻量级 agent profile registry 插件。

让 Director（或使用者）定义 **哪个 harness / model / effort 对应哪个角色**，
使编排器能以最小的上下文成本查询 profile，并通过 Herdr Skill 启动 worker。

```text
Profile Registry（本插件）
      "用谁来做？"
           ↓
       Director
           ↓
      Herdr Skill          "怎么启动？"
           ↓
      Herdr Runtime
```

本插件不是编排器。pane 创建、agent lifecycle、worktree、消息传递、task DAG、scheduler
都由现有的 Herdr + Herdr Skill 负责。

## 要求

- **Node.js ≥ 22**（插件命令与 CLI 均以 Node 运行）
- Herdr ≥ 0.7.0（TUI）。在 Herdr 桌面应用（herdr-core `hc`）中 CLI 与技能同样可用 — 参见 [在 Herdr 应用中使用](#在-herdr-应用中使用)
- `npm`（通过 GitHub 安装时会执行依赖安装步骤 `npm ci --omit=dev`）

## 安装

从 GitHub 安装（推荐）：

```bash
herdr plugin install chaaaron000/herdr-loadout
```

可用 `--ref <tag>` 固定版本。从源码检出开发时，改用链接方式：

```bash
# 从源码 checkout 开始
npm install

# 向 Herdr 注册插件（本地链接）
herdr plugin link "$(pwd -W 2>/dev/null || pwd)"     # Git Bash 中用 -W 取得原生路径
herdr plugin list
```

`herdr plugin link` 需要 **绝对路径**。Git Bash 的 `/tmp/...` 等虚拟路径会以
`Working directory does not exist` 失败，请使用 `pwd -W` 或 `D:\...` 形式。

> **Windows 注意：** Herdr 在执行 `herdr agent start` 时，会把可执行文件路径不加引号地交给 shell。
> 如果 harness（`codex`、`opencode` 等）位于含空格的路径（例如 nvm 的 `Author Software`），
> worker 将启动失败。把不含空格的路径（例如 junction）放到 PATH 最前面即可解决。
> `herdr-loadout launch <id>` 的 `launchable path` 检查会报告这类路径。
> 详见 [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md) §5。

## 用法

### 1. 用 GUI/TUI 编辑 profile

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

或通过 action（可由 Director 或用户快捷键调用）：

```bash
herdr plugin action invoke herdr-loadout.open-ui
herdr plugin action invoke herdr-loadout.open-ui-popup
```

如果注册了快捷键，也可以用该按键打开。

在 Herdr 应用中使用应用专用编辑器（应用 mod）。从源码检出中安装一次：

```bash
npm run install:app-mod                         # 安装到 ~/.config/herdr-app/mods/herdr-loadout
npm run install:app-mod -- --key ctrl-shift-a   # 同时注册快捷键（按键已被占用则拒绝）
herdr-app do mod.open --name herdr-loadout      # 不用快捷键直接打开
```

- 以当前聚焦终端的项目为基准显示全局/项目 profile，按键和操作与 TUI 相同
  （`Enter` 编辑、`a` 添加、`c` 复制、`d` 删除、`r` 解除 override、`[`/`]` 调整顺序、`j` harness 列表、`k` API 密钥、编辑中 `g`/`p` 保存、`t` 运行检查、`Esc` 返回/关闭）。也可以用鼠标点击。
- 所有读写都经由 `herdr-loadout editor <action>`（CLI 的 JSON 后端），因此规则与 TUI 相同。
- 应用 mod 无法使用 Node，所以安装脚本会把 node 和 CLI 的路径写入 `cli.js`。移动检出目录后需重新安装。
- 应用的命令面板（Ctrl+Shift+P）不接受 mod 条目，因此请用快捷键或 `mod.open` 打开。

### 注册快捷键（可选）

Herdr 不允许插件自行注册快捷键，因此直接写入 `config.toml`：

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

`prefix+a` 打开默认 overlay，`prefix+shift+a` 打开会话模态弹窗。
`prefix+l`、`prefix+g`、`prefix+p` 等已被 Herdr 占用。
用 `herdr server reload-config` 生效，无需重启。

TUI 操作：

| 按键 | 动作 |
|---|---|
| `↑` `↓` | 在 profile 之间移动 |
| `Enter` / `e` | 编辑选中的 profile |
| `a` | 新建 profile |
| `c` | 复制 |
| `d` | 删除（全局 profile 会连同该项目的 override 一起删除） |
| `r` | 解除项目 override，重新沿用全局 profile（仅在有 override 的行） |
| `[` `]` | 将选中的 profile 在组内上移/下移（选中项随之移动） |
| `j` | 检测页面（已安装的 harness + 模型目录） |
| `q` | 退出（pane 也会关闭） |

列表分为两个区域。

- **Global profiles** — 全局 profile。该项目覆盖了部分字段的行会显示与全局不同的项目，例如 `≠ model, effort`。
- **Project profiles · (路径)** — 只存在于该项目的 profile。没有全局原件，因此没有 override，直接编辑即可。

编辑界面把**模式分开**，同一个按键不会有两种含义。

| 模式 | 按键 | 动作 |
|---|---|---|
| 移动字段 | `↑` `↓` | 在 profile 字段间移动 |
| | `Enter` | 打开字段（有选项则列表，否则直接输入） |
| | `g` `p` `t` | 保存到全局 / 保存到项目 / Test Launch |
| | `r` | 把当前字段恢复为全局值（仅在与全局不同的字段） |
| | `Esc` | 返回列表 |
| 选择选项 | `↑` `↓` | 移动选项 |
| | `Enter` | 应用并返回字段 |
| | `/` | 查找（边输入边过滤） |
| | `o` | 切换排序（catalog → name → provider → context） |
| | `Esc` | 清除过滤，再按返回字段 |
| 直接输入 | 字符 | 输入值 |
| | `Enter` | 确认 |
| | `Esc` | 取消 |

查找会匹配 id、provider 或名称，多个词按 AND 收窄（`ollama flash`）。
标题显示剩余数量 `24 of 55`，避免把过滤后的列表误认为短列表。
底部的按键提示随当前模式变化。

选项列表较长时（模型目录可能有数百项）会滚动并跟随光标，剩余数量显示为 `↑27 ↓45 (41/86)`。

每个保存目标都有自己的按键，不需要切换模式。编辑页面顶部会显示当前 profile 的类型以及各按键的用途。

| 按键 | 写入位置 | 行为 |
|---|---|---|
| `g` | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 修改全局 profile。只应用本次改动的字段，因此项目 override 的值不会泄漏到全局 |
| `p` | `<project>/.herdr/loadout.toml` | **只保存与全局不同的字段**，其余沿用全局。项目专用 profile 保存完整内容 |

- 项目专用 profile 只能用 `p`（`g` 会被拒绝）。
- 新建或复制的 profile 用 `g`（全局）或 `p`（项目专用）保存。已存在的 id 不会被覆盖，而是被拒绝。
- 与全局不同的字段带有 `≠`，底部会显示全局值。在该字段按 `r` 恢复为全局值；全部恢复后按 `p` 会删除 override。
- 在列表中对有 override 的行按 `r`，确认后会删除整个 override，重新沿用全局 profile。

写入项目时只记录差异，因此之后修改全局的模型或标签仍会作用于该项目。

弹窗（`prefix+shift+a`）以屏幕的 90%×80% 打开。TUI 会根据终端尺寸调整布局，
窗口较小时会裁剪字段列表，以保证模型列表的行数。

### 2. 用 CLI 查询（Director 路径）

```bash
herdr-loadout list                  # 人类可读的列表
herdr-loadout list --compact        # Director 格式: id | cost | purpose
herdr-loadout show builder          # 单个 profile 的详情
herdr-loadout path                  # 查看配置与状态路径
herdr-loadout validate              # 校验配置
herdr-loadout detect                # harness 可用性 + 模型目录
herdr-loadout catalog               # 查看/刷新 models.dev 快照（225 个 provider）
herdr-loadout launch builder        # Test Launch（dry-run）
herdr-loadout command builder --name w1 --pane 3   # 用 profile 当前的值输出 worker 启动命令
herdr-loadout task new api-auth --worker builder-auth --profile builder   # 在 .herdr/runs/<日期>-api-auth/ 中创建 brief.md 和 report.md
herdr-loadout worker-check builder-auth   # 运行中的 worker 是否仍与当前 profile 一致（不一致则 exit 1）
herdr-loadout agents-md             # 项目 AGENTS.md 中委派块的状态（current | missing | outdated | declined）
herdr-loadout ui                    # 无 TTY 时打开 pane 后退出
```

安装启动器（不会修改 PATH）：

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

代理无需 PATH 的调用方式：

```bash
"$(herdr plugin config-dir herdr-loadout)/herdr-loadout" list --compact
```

若要在任意 shell 中直接用 `herdr-loadout`，请安装到**已在 PATH 中的文件夹**：

```bash
node scripts/setup-shim.mjs --dir ~/.local/bin
```

安装过的启动器会在 Herdr 启动时自动刷新，因此重装导致插件位置变化后仍可使用。

没有 shim 也始终可用：

```bash
node bin/herdr-loadout.mjs list --compact
```

`list --compact` 是无表头、无颜色、无装饰的固定格式。编排器的解析器依赖它。

```text
builder | expensive | implementation/refactor/design
junior | normal | implementation/light
qa | normal | qa/testing
reviewer | cheap | review/security
scout | cheap | research
```

### 3. 配置文件

| 文件 | 用途 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 全局 profile |
| `<project>/.herdr/loadout.toml` | 项目覆盖（只替换列出的字段） |

用 `herdr-loadout path` 查看实际位置。也可以手工编辑。保存（`set`、`add`、`remove`、`reset`、`import`、编辑器）只改动要求修改的键和块，注释、未知的键、其他表、空行和换行符都原样保留。无法这样编辑的文件（例如用内联数组写的 profile）会被拒绝，不写入任何内容。

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

项目覆盖示例（只修改 effort 与附加参数）：

```toml
[[profiles]]
id = "builder"
effort = "high"
extra_args = ["--add-dir", "Assets"]
```

### 4. 项目 AGENTS.md 中的委派块

技能只在 agent 已决定委派之后才会加载。因此“与用户对话的 agent 不亲自干活而是委派”“不使用 harness 内置 subagent”
这样的规则，必须放在 harness 启动时一定会读的文件里。块的原文只有 `src/core/agents-md.md` 一处，CLI 原样输出和安装。

```bash
herdr-loadout agents-md            # 状态: current | missing | outdated | declined（也支持 --json）
herdr-loadout agents-md print      # 块的原文
herdr-loadout agents-md install    # 写入或更新 AGENTS.md，并补上需要的 @AGENTS.md import
herdr-loadout agents-md decline    # 记录下来，在该项目中不再询问
```

- `herdr-loadout` 技能每个会话检查一次状态；为 `missing`、`outdated` 时把块给用户看并只问一次。
  同意则 `install`，拒绝则 `decline`。不问不写；以 `[Worker-...]` 提示启动的 worker 跳过这一步。
- `install` 只写 `<!-- herdr-loadout:start -->` 与 `<!-- herdr-loadout:end -->` 两行之间。文件不存在就创建，
  没有标记就追加到末尾，有标记就只替换其间内容。再次运行不会有任何变化。标记损坏时直接失败，不改动任何文件。
- 拒绝记录不在仓库里，而是按项目根目录存放在插件状态目录的 `agents-md-declined.json` 中。`install` 会清除它。
- 项目根目录为 `--project`，否则向上查找最近的含 `.git` 或 `.herdr` 的文件夹。

各 harness 在项目根目录读取的文件不同。已对照文档确认；除 pi 外的五个还实际运行验证过（在临时项目中让各 harness 说出其指令文件的内容）。pi 则对照了源码。

| harness | 读取的文件 | `install` 的处理 |
|---|---|---|
| claude | 只要存在 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 之一就只读它们，否则读 `AGENTS.md`（v2.1.277 及以上） | 在该文件中加入 `@AGENTS.md` import（`.claude/CLAUDE.md` 用 `@../AGENTS.md`） |
| omp | 每个文件夹只取一个: `.omp/AGENTS.md` > `.claude/CLAUDE.md` > `.agent(s)/AGENTS.md` > `.gemini/GEMINI.md` > `.github/copilot-instructions.md` > `AGENTS.md` > `CLAUDE.md` | 若有优先于 `AGENTS.md` 的文件，在其中加入 import |
| codex | `AGENTS.override.md`，没有则 `AGENTS.md` | 对 `AGENTS.override.md` 只给出 `note:` 提示（codex 不展开 import） |
| opencode | `AGENTS.md`（没有时才读 `CLAUDE.md`） | 无 |
| agy | `AGENTS.md` 和 `GEMINI.md` 都读 | 无 |
| pi | `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` | 同 codex |

Claude Code 只读 `CLAUDE.md` 时（旧版本，或 Project instructions 设为 `claude-md`），`install --claude-md` 会创建
导入 `AGENTS.md` 的 `CLAUDE.md`。若 `~/.claude/settings.json` 中设置了 `claude-md`，不加该选项也会这样做。

更换模型或 harness 只需修改 profile，AGENTS.md 中的块不需改动。

### 5. 让 agent 创建 profile（非交互）

TUI 面向人类，因此 agent 使用 CLI 写入命令。

```bash
# 直接用参数
herdr-loadout add --id builder-unity --name "Unity Builder" \
  --harness claude --model deepseek-v4.1 --effort high --cost normal \
  --when "Unity/FishNet implementation with asmdef awareness." \
  --avoid "Pure research." --tag unity --tag implementation \
  -- --add-dir Assets

# 从 JSON/TOML 载荷文件
herdr-loadout add --from profile.json
cat profile.toml | herdr-loadout add --from -

# 更新已有 profile（只改指定字段）
herdr-loadout set builder --effort high

# 只在该项目里不同（只保存差异）
herdr-loadout set builder --effort high --project .

# 解除项目 override，重新沿用全局 profile
herdr-loadout reset builder

# 删除（全局的会连同该项目的 override 一起删除）
herdr-loadout remove builder-unity

# 调整列表顺序（仅限同组内：全局之间、项目专用之间）
herdr-loadout move scout --up
herdr-loadout move scout --down
herdr-loadout move scout --before builder
herdr-loadout move scout --after builder

# 合并整个配置文件
herdr-loadout import ./team-profiles.toml
```

加 `--project <PATH>` 会写入项目文件（`.herdr/loadout.toml`）而非全局文件。规则与 TUI 一致。

| 命令 | 全局（默认） | `--project` |
|---|---|---|
| `set` | 修改全局 profile 本身，不会混入项目 override 的值（若你改的字段该项目仍在覆盖，会提示） | 只保存与全局不同的字段；项目专用 profile 保存完整内容；恢复为全局值时删除 override |
| `reset` | — | 删除项目 override（省略 `--project` 时用当前目录的项目）；不适用于项目专用 profile |
| `remove` | 删除全局 profile 及该项目对它的 override | 删除项目条目（override 或项目专用 profile） |
| `add` | 已有同名 id 则拒绝 | 全局已有同名 id 也拒绝（用 `set --project` 做 override） |
| `import` | 原样合并 | 全局已有的 id 只保存差异作为 override，相同则跳过 |

`move` 不区分全局/`--project`：全局 profile（无论是否被 override）在全局文件中调整顺序，项目专用 profile 在项目文件中调整顺序，override 的位置不影响顺序。`--project` 只指定项目，写入哪个文件由 profile 决定。

`move` 只把 `[[profiles]]` 块作为文本移动，注释、其他表和换行符都原样保留。无法按块调整顺序的文件（例如用内联数组写的 profile）会被拒绝，不写入任何内容。
`move --json` 输出 `{ok, id, scope, index, moved, path, order, message}`。`index` 是移动后在列表中的位置（从 0 开始），`order` 是该组的新顺序。已在该位置、没有变化时，`moved` 为 `false`，`path` 为 `null`，没有 `order`。
退出码：没有变化也是 `0`；未知 id、以其他组或自身为参照的移动、无法按块调整顺序的文件为 `1`（文件不变）；没有位置参数或多于一个时为 `2`。

`list` 与 TUI 一样分为 **Global profiles** 和 **Project profiles**，被覆盖的 profile 会显示 `Overridden: effort (global: medium)`。`list --json` 的 `differs` 提供同样的信息。`list --compact` 不变。
加 `--json` 输出机器可读结果（`{ok, id, scope, path, created}`；`move` 为上述格式）。
退出码：`0` 成功，`1` 运行时错误，`2` 用法/校验错误。

id 已存在时 `add` 会失败（用 `--force` 覆盖，或用 `set` 更新）。

action 无法接收参数，因此先写载荷文件：

```bash
# agent 写好 profile.json 之后
herdr plugin action invoke herdr-loadout.add-profile
```

## Agent 技能

`skills/` 中有两个供 agent 读取的技能。

| 技能 | 用途 |
|---|---|
| `herdr-loadout` | 通过 profile 把任务委派给 worker（项目设置 → 读取工作方式 → 查询 → 运行 `command` 输出的 `herdr agent start` 或 `hc run`） |
| `herdr-loadout-edit` | 添加、修改、删除、导入 profile 与工作方式 |

`command <id>` 用执行时 profile 的值输出启动 worker 的宿主命令，避免智能体凭记忆重新填写旧的模型或 effort。
它接受 `--host herdr|hc`、`--name`、`--pane`（TUI）、`--space`/`--tab`（应用）、`--cwd`（默认：当前目录），
未提供的值以 `<pane_id>` 这样的占位符输出。`--shell powershell` 时按 PowerShell 的引号规则包裹，默认按 sh（bash、Git Bash、zsh）的规则。
在应用中，`--tab self` 会在 `herdr-app ls` 中找到显示自己的标签页并使用它；未提供 `--space` 时也使用该标签页的 space。
带领其他 worker 的 worker 用它把成员放在自己的标签页中，因为应用放进新标签页的 worker 没有 `herdr.tab` 标签。
以 `#` 开头的行是提示。在 TUI 中，若 profile 带有 `env`，会以提示形式输出打开 pane 时要传入的 `--env` 参数。

`launch <id> --json` 以 `ok`、`harness`、`args`、`env`、`argv` 返回相同的值。

`env` 的值可能是 API 密钥，因此在 `list`、`show`、`launch`、`command` 的输出以及编辑器（TUI、应用）中都会显示为 `***`。
在编辑器的 Env 栏中保留 `KEY=***` 不变即可沿用原值，填写新值则会替换。
`command` 输出的 TUI `--env` 参数形如 `"KEY=$(… env-value <id> KEY)"`，由 shell 在执行时读取值。
真实值只能通过 `herdr-loadout env-value <id> <KEY>` 取得。在应用（`hc`）中由 `exec` 直接设置该值。

### 工作方式（workflow）

技能里只有命令，委派时的选择写在工作方式文件中：哪类 profile 负责哪种工作，
提示词、brief、报告文件的格式，标签页的用法，何时关闭 worker、何时保留，以及 worker 之间如何协作。
与 profile 一样分为两层。

| 层 | 文件 | 用途 |
|---|---|---|
| 全局 | `<配置目录>/workflow.md`（不存在时使用内置默认值） | 所有项目通用 |
| 项目 | `<project>/.herdr/workflow.md` | 仅限本项目的规则。接在全局之后，冲突时以此为准 |

```bash
herdr-loadout workflow                      # 适用于本项目的工作方式（技能在委派前读取）
herdr-loadout workflow init --project .     # 创建项目规则文件（只写不同之处）
herdr-loadout workflow init                 # 把内置默认值复制到全局文件后修改
```

创建全局文件后它就属于用户，内置默认值之后的变化不会再反映进来。
`herdr-loadout path` 中的 `globalWorkflow`、`projectWorkflow` 即两个文件的位置。

### 任务文件夹与报告

每个委派的任务使用一个文件夹 `.herdr/runs/<YYYY-MM-DD>-<slug>/`。`task new` 在其中创建 `brief.md` 和 `report.md`，
并填入编排者地址（应用为 `$HC_TERMINAL_ID`，TUI 为 `$HERDR_PANE_ID`，可用 `--to` 指定）以及 worker 用来报告的命令。
首次创建 `runs/` 时还会写入 `runs/.gitignore`（`*`），因此即使项目提交 `.herdr/`，任务文件也不会被提交。已存在同名文件夹时拒绝创建。

```bash
herdr-loadout task new api-auth --worker builder-auth --profile builder   # 最后一行是发给 worker 的提示
herdr-loadout command builder --host hc --name builder-auth --task .herdr/runs/2026-11-21-api-auth --space <space_id>
herdr-loadout worker-check builder-auth                                      # 向保留的 worker 再次发送提示之前
```

- 任务 id 是 slug 的大写形式（`api-auth` → `API-AUTH`）。报告文件最后一行是 `API-AUTH-COMPLETE`、`API-AUTH-PARTIAL`、
  `API-AUTH-BLOCKED` 或 `REVIEW-READY <n>` 之一。
- 完成信号由 worker 发出：写完报告后，向编排者发送一行 `[Report-<worker>] <MARKER> <report>`（应用用 `hc send`，TUI 用
  `herdr agent prompt`）。以报告文件为准，这一行只是信号。
- 编排者从不轮询完成状态。在应用中，它在后台保留一个 `hc wait --children any`，用来发现未报告就停下的 worker；在 TUI 中，
  每个 worker 一个 `herdr agent wait <worker> --until blocked`。应用的 watch 先看 `reason`：`message` 返回的 `children`
  为空并不表示没有 worker，只有 `children` 返回且不含任何 worker 时才停止 watch。
- 较大的实现完成后，下一步是独立 QA。与实现者在 harness 或模型上不同的 `qa` 配置在阅读代码之前先根据 brief 编写场景，并在真实的
  CLI 和宿主上运行（TUI 用隔离的 `herdr --session <name> server`，应用用结束后关闭的临时 hc worker）。发现的每个 bug 都写成回归
  测试，每一轮由新的 QA worker 写 `qa-<n>.md`。源码修复交回实现者。代码审查（`review-<n>.md`）只用于安全敏感的变更（shell 引用、
  密钥、权限）或用户要求时。
- 模板：存在 `<project>/.herdr/templates/brief.md`、`report.md` 时使用它们，否则使用内置模板（`src/core/templates/`）。
  `{{task}}`、`{{worker}}`、`{{notify}}` 等 `{{key}}` 会被填入，未知的键原样保留。
- `command --task <文件夹>` 把 worker 的 profile 和启动指纹（harness、参数、env 名称；不含值）记录到该文件夹的
  `workers.json`。在应用中（`--host hc`）还会把两者作为 `hc run` 标签加上。`worker-check` 把这条记录与当前 profile
  和运行中的 worker 比较，若 profile 已修改、运行的是另一个 profile、已退回 shell，或 TUI worker 在重启后丢失了启动参数，
  则输出原因并以 exit 1 结束。无法询问宿主（CLI 不存在、服务器未运行）时，以 `host-unavailable` 和 exit 1 返回：此时对该
  worker 一无所知，应重新检查而不是重新启动。

### 在 Herdr 应用中使用

技能在 `HERDR_ENV=1` 时判定为 TUI（`herdr`），存在 `HC_TERMINAL_ID` 时判定为应用（`hc`、`herdr-app`），
并使用对应的 CLI。在应用中使用 `launch <id> --json --host hc`。

- `argv` 即完整的 worker 命令：`hc run --bg --name <name> --cwd <dir> --label herdr.space=<space> -- <argv...>`。
- `hc run` 无法传递环境变量，因此带有 `env` 的 profile 的 `argv` 会经由
  `herdr-loadout exec <id>`。`exec` 应用 env 后启动 harness，并原样返回其退出码。
  参数中含有双引号时（如 agy 的 `--settings` JSON）也走同一路径，因为 Windows PowerShell 5.1
  会删除它传给原生命令的参数中的双引号。
- Codex 在 `hc` 下需要 `--no-daemon`，因此 `--host hc` 时会自动加上。
- 应用中没有插件 action。如果没有 launcher，请在源码 checkout 中运行 `node scripts/setup-shim.mjs` 创建。

技能文件会被复制到技能库，因此换行符固定为 LF（`.gitattributes`）。

## Profile 字段

必填：`id`, `name`, `harness`, `model`, `effort`, `when_to_use`
可选：`avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`, `api`, `auth`

`api` 让 harness 使用已保存的 API 密钥运行，而不是它自己的登录。值是已保存密钥的 id；留空则使用 harness
自身的登录（订阅）。支持的组合：

| Harness | 提供商 | 接入方式 |
|---|---|---|
| claude | DeepSeek | DeepSeek 的 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`） |
| agy | Google AI Studio | Gemini API |

Codex 只接受 Responses API（0.170 拒绝 `wire_api = "chat"`）。DeepSeek 和 Google 不提供 Responses API，
因此它们的密钥不能用于 Codex。

密钥与 profile 分开，保存在全局配置目录下的 `keys.toml` 中。它们不会写入项目文件，因此不会随仓库提交，
所有输出中只显示最后四个字符（`sk-…1a2b`）。

```bash
herdr-loadout keys add deepseek --provider deepseek   # 密钥从 stdin 读取（在终端中为隐藏输入）
herdr-loadout keys list                               # 已保存的密钥（遮盖）和提供商
herdr-loadout keys test deepseek                      # 询问提供商密钥是否可用
herdr-loadout set <id> --api deepseek                 # profile 使用该密钥运行
```

在应用编辑器中，`k`（API 密钥页面）用于添加、测试和删除密钥；claude 或 agy profile 在其 API 字段中选择密钥。
选择密钥后，模型列表会切换为该提供商的列表（DeepSeek `/models`、Gemini API）。

启动时设置的内容：

- claude + DeepSeek：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN=<密钥>`、`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、
  `ANTHROPIC_DEFAULT_SONNET_MODEL`=`<模型>[1m]`、`ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`、
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`，并清空继承的 `ANTHROPIC_API_KEY`。`--model` 也传 `<模型>[1m]`
  （1M 上下文标记，Claude Code 会在请求前去掉）。这些值遵循 DeepSeek 的 Claude Code 指南。
- agy + Google：`GEMINI_API_KEY=<密钥>` 和 `--settings <状态目录>/agy-api/…/settings.json`（`{"modelProvider":"gemini"}`）。
- profile 的 `env` 若设置了同名变量，以 profile 的值为准。密钥不存在或与 harness 不匹配时，`launch` 的 `API key` 检查会失败。

agy 的 `auth = "api-key"` 仍然可用，此时密钥从 profile 的 `env.GEMINI_API_KEY` 或 worker 环境的 `GEMINI_API_KEY` 读取。
agy 内置的 API 模型列表在 agy 构建时就已固定，不包含新模型。因此每次读取列表时，都会用密钥（依次为环境中的
`GEMINI_API_KEY`、profile 的密钥、已保存的 Google 密钥）查询 Gemini API 的模型列表，并把 agy 缺少的 Gemini
模型作为 custom model 注册到同一 settings 文件的 `customModelsConfig` 中。新模型会立即出现在编辑器的模型列表中，
也可直接用于 `--model`。查询失败时沿用上次找到的列表。

`harness` 取 `claude`、`codex`、`opencode`、`omp`、`pi`、`agy`（Antigravity CLI）、`custom` 之一。
非 `custom` 且不在列表中的值会在校验时被拒绝。

## 各 harness 的参数映射

| harness | model | effort | 备注 |
|---|---|---|---|
| `claude` | `--model` | `--effort` | 没有列表命令，因此**从 omp 的 Anthropic 目录派生**；没有 omp 时回退到别名（opus/sonnet/haiku/fable） |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | 通过 `codex debug models` 获取目录 |
| `opencode` | v1: `-m` · v2: config 的 `model` | v2: config `model` 上的 `#variant`（v1 不传递） | 通过 `opencode models` 获取。按已安装版本（`opencode --version`）选择参数。v2 的 TUI 没有 `-m`，因此模型、effort 和权限通过 `OPENCODE_CONFIG_CONTENT` 传递，并加上 `--standalone` 让 worker 自己的服务器读取它（共享的后台服务会忽略 worker 的 env） |
| `omp` | `--model=` | `--thinking=` | 通过 `omp models --json` 获取（含 thinking 级别） |
| `agy` | `--model` | `--effort` | Antigravity CLI。通过 `agy models` 获取；与 Herdr 的 `--kind agy` 同名。若 id 以 `-low`、`-medium`、`-high` 等结尾（如 `gemini-3.8-flash-medium`），effort 即为该级别，不再传 `--effort`。编辑器把这类 id 合并显示为一个模型（`gemini-3.8-flash`），级别在 Effort 中选择（保存的仍是 `gemini-3.8-flash-medium` 这样的完整 id） |
| `custom` | `--model` | `--effort` | 自由输入 |

## 验证方法

```bash
node --test          # 单元测试
```

手动验证（需要 Herdr）：

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
herdr pane read <pane_id> --source visible     # 检查渲染
herdr pane send-keys <pane_id> down            # 检查按键输入
herdr pane close <pane_id>
herdr plugin unlink herdr-loadout              # 清理
```

插件 pane 内的进程退出时，pane 会自动关闭（实测）。

## 设计说明

- Herdr 无法为插件添加 CLI 子命令，因此 `herdr-loadout` 是独立可执行文件。
- 插件 pane 的命令在 **pane 的 cwd** 下执行，因此清单命令都经过 `bootstrap.mjs`
  （从插件根目录解析模块），项目路径也从 Herdr 注入的 `HERDR_PLUGIN_CONTEXT_JSON`
  读取，而不是 pane 的 cwd。
- `herdr plugin action invoke` 不接受参数，也不返回 stdout（异步 fire-and-forget）。
  因此查询路径是 CLI，action 只用于打开 UI。
- profile 与模型探测失败不会阻塞 profile 创建。目录以 5 分钟 TTL 缓存。
- `claude` 没有列表命令，因此从 **models.dev**（omp 读取的公开目录）派生。
  顺序：models.dev 快照（24 小时 TTL）→ omp → 别名；全部可离线工作。
- 用 `herdr-loadout catalog --refresh` 刷新快照。

实测依据见 [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md)，
实现计划见 [`docs/implementation-plan.md`](../implementation-plan.md)。

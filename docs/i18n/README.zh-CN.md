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
- Herdr ≥ 0.7.0
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
builder | normal | implementation/refactor
reviewer | cheap | review
scout | cheap | research
heavy | expensive | design
```

### 3. 配置文件

| 文件 | 用途 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | 全局 profile |
| `<project>/.herdr/loadout.toml` | 项目覆盖（只替换列出的字段） |

用 `herdr-loadout path` 查看实际位置。也可以手工编辑；未知的键在保存时会被保留。

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

### 4. 给 Director 的 AGENTS.md 片段

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

更换模型或 harness 只需修改 profile，AGENTS.md 不需改动。

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

`list` 与 TUI 一样分为 **Global profiles** 和 **Project profiles**，被覆盖的 profile 会显示 `Overridden: effort (global: medium)`。`list --json` 的 `differs` 提供同样的信息。`list --compact` 不变。
加 `--json` 输出机器可读结果（`{ok, id, scope, path, created}`）。
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
| `herdr-loadout` | 通过 profile 把任务委派给 worker（查询 → `launch --json` → `herdr agent start`） |
| `herdr-loadout-edit` | 添加、修改、删除、导入 profile |

`launch <id> --json` 返回 `ok`、`harness` 和 `args`。把 `args` 原样接在
`herdr agent start <name> --kind <harness> --` 之后即可。
技能文件会被复制到技能库，因此换行符固定为 LF（`.gitattributes`）。

## Profile 字段

必填：`id`, `name`, `harness`, `model`, `effort`, `when_to_use`
可选：`avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`

`harness` 取 `claude`、`codex`、`opencode`、`omp`、`pi`、`agy`（Antigravity CLI）、`custom` 之一。
非 `custom` 且不在列表中的值会在校验时被拒绝。

## 各 harness 的参数映射

| harness | model | effort | 备注 |
|---|---|---|---|
| `claude` | `--model` | `--effort` | 没有列表命令，因此**从 omp 的 Anthropic 目录派生**；没有 omp 时回退到别名（opus/sonnet/haiku/fable） |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | 通过 `codex debug models` 获取目录 |
| `opencode` | `-m` | `--variant` | 通过 `opencode models` 获取 |
| `omp` | `--model=` | `--thinking=` | 通过 `omp models --json` 获取（含 thinking 级别） |
| `agy` | `--model` | `--effort` | Antigravity CLI。通过 `agy models` 获取；与 Herdr 的 `--kind agy` 同名 |
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

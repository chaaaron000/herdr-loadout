# herdr-loadout

**言語:** [한국어](../../README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [简体中文](./README.zh-CN.md)

Herdr 用の lightweight な agent profile registry プラグインです。

Director（またはユーザー）が **どの harness / model / effort をどの役割に使うか** を定義し、
オーケストレーターが最小のコンテキストコストでプロファイルを照会して Herdr Skill 経由で
worker を起動できるようにします。

```text
Profile Registry (このプラグイン)
      "誰を使うか?"
           ↓
       Director
           ↓
      Herdr Skill          "どう起動するか?"
           ↓
      Herdr Runtime
```

このプラグインはオーケストレーターではありません。pane の作成、agent lifecycle、worktree、
メッセージング、task DAG、scheduler は既存の Herdr + Herdr Skill が担当します。

## 要件

- **Node.js ≥ 22**（プラグインコマンドと CLI は Node で動作します）
- Herdr ≥ 0.7.0
- `npm`（GitHub からのインストールでは依存関係の導入 `npm ci --omit=dev` が実行されます）

## インストール

GitHub から（推奨）:

```bash
herdr plugin install chaaaron000/herdr-loadout
```

特定バージョンは `--ref <tag>` で固定できます。ソースのチェックアウトで開発する場合は次のようにリンクします。

```bash
# ソースチェックアウトから
npm install

# Herdr にプラグインを登録（ローカルリンク）
herdr plugin link "$(pwd -W 2>/dev/null || pwd)"     # Git Bash では -W でネイティブパス
herdr plugin list
```

`herdr plugin link` は **絶対パス** を要求します。Git Bash の `/tmp/...` のような仮想パスは
`Working directory does not exist` で失敗するため、`pwd -W` または `D:\...` 形式を使用してください。

> **Windows の注意:** Herdr は `herdr agent start` の際、実行ファイルのパスを引用符なしでシェルに渡します。
> harness（`codex`、`opencode` など）がスペースを含むパス（例: nvm の `Author Software`）にあると、
> 起動に失敗します。スペースのないパス（例: junction）を PATH の先頭に置くと解決します。
> `herdr-loadout launch <id>` の `launchable path` チェックがこのようなパスを報告します。
> 詳細は [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md) §5 を参照してください。

## 使い方

### 1. GUI/TUI でプロファイルを編集

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
```

またはアクション経由（Director やユーザーのキーバインドから呼び出し可能）:

```bash
herdr plugin action invoke herdr-loadout.open-ui
herdr plugin action invoke herdr-loadout.open-ui-popup
```

キーバインドを登録していれば、そのキーでも開けます。

### キーバインドの登録（任意）

Herdr はプラグイン自身によるキーバインド登録を許可していないため、`config.toml` に直接追加します:

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

`prefix+a` は既定の overlay、`prefix+shift+a` はセッションモーダルのポップアップです。
`prefix+l`・`prefix+g`・`prefix+p` などは Herdr が既に使用しています。
`herdr server reload-config` で反映され、再起動は不要です。

TUI の操作:

| キー | 動作 |
|---|---|
| `↑` `↓` | プロファイル間を移動 |
| `Enter` / `e` | 選択したプロファイルを編集 |
| `a` | 新規プロファイル |
| `c` | 複製 |
| `d` | 削除（グローバルのプロファイルなら、そのプロジェクトの override も一緒に削除） |
| `r` | プロジェクトの override を解除し、グローバルに再び従う（override のある行のみ） |
| `j` | 検出画面（インストール済み harness + モデルカタログ） |
| `q` | 終了（pane も閉じる） |

一覧は 2 つの区画に分かれます。

- **Global profiles** — グローバルのプロファイル。このプロジェクトが一部を上書きしている行には `≠ model, effort` のようにグローバルと異なる項目が表示されます。
- **Project profiles · (パス)** — このプロジェクトにしかないプロファイル。グローバルの元がないため override はなく、直接編集します。

編集画面は**モードが分離**されており、同じキーが別の意味になることはありません。

| モード | キー | 動作 |
|---|---|---|
| フィールド移動 | `↑` `↓` | プロファイル項目間を移動 |
| | `Enter` | 項目を開く（オプションがあれば一覧、なければ直接入力） |
| | `g` `p` `t` | グローバルに保存 / プロジェクトに保存 / Test Launch |
| | `r` | フォーカス中のフィールドをグローバルの値に戻す（グローバルと異なるフィールドのみ） |
| | `Esc` | 一覧へ戻る |
| オプション選択 | `↑` `↓` | オプション移動 |
| | `Enter` | 適用してフィールドへ戻る |
| | `/` | 検索（入力に応じて絞り込み） |
| | `o` | 並び順の切替（catalog → name → provider → context） |
| | `Esc` | フィルタを消去、もう一度でフィールドへ |
| 直接入力 | 文字 | 値を入力 |
| | `Enter` | 確定 |
| | `Esc` | キャンセル |

検索は id・provider・名前のいずれにも一致し、複数語は AND で絞り込みます（`ollama flash`）。
ヘッダーに `24 of 55` と残数を表示するため、絞り込まれた一覧を短い一覧と誤認しません。
下部のキーヒントは現在のモードに追従します。

オプション一覧が長い場合（モデルカタログは数百件になることがあります）はスクロールして
カーソルを追従させ、残数を `↑27 ↓45 (41/86)` のように表示します。

保存先ごとに専用のキーがあり、モードを切り替える必要はありません。編集画面の上部に、プロファイルの種類と各キーの用途が表示されます。

| キー | 書き込み先 | 動作 |
|---|---|---|
| `g` | `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | グローバルのプロファイルを編集。今回変更したフィールドのみ反映するため、プロジェクトの override 値がグローバルへ漏れません |
| `p` | `<project>/.herdr/loadout.toml` | **グローバルと異なるフィールドのみ**保存（他はグローバルに従う）。プロジェクト専用プロファイルは全体を保存 |

- プロジェクト専用プロファイルは `p` のみ使えます（`g` は拒否されます）。
- 新規・複製は `g`（グローバル）か `p`（プロジェクト専用）で保存します。既存の id は上書きせず拒否します。
- グローバルと異なるフィールドには `≠` が付き、下部にグローバルの値が表示されます。そこで `r` を押すとグローバルの値に戻り、すべて戻したあとに `p` を押すと override が削除されます。
- 一覧で override のある行に `r` を押すと、確認後に override 全体を削除し、グローバルに再び従います。

プロジェクトへ保存すると差分だけが記録されるため、後からグローバル側のモデルやタグを
変更してもプロジェクトがそれを覆い隠しません。

ポップアップ（`prefix+shift+a`）は画面の 90%×80% で開きます。TUI は端末サイズに合わせて
レイアウトを変え、ウィンドウが小さいときはフィールド一覧を削ってモデル一覧の行を確保します。

### 2. CLI で照会（Director の経路）

```bash
herdr-loadout list                  # 人が読む一覧
herdr-loadout list --compact        # Director 用: id | cost | purpose
herdr-loadout show builder          # 単一プロファイルの詳細
herdr-loadout path                  # 設定と状態のパスを確認
herdr-loadout validate              # 設定の検証
herdr-loadout detect                # harness の有無 + モデルカタログ
herdr-loadout catalog               # models.dev スナップショット（225 provider）の確認/更新
herdr-loadout launch builder        # Test Launch（dry-run）
herdr-loadout ui                    # TTY がない場合は pane を開いて終了
```

ランチャーをインストール（PATH は変更しません）:

```bash
herdr plugin action invoke herdr-loadout.install-shim
```

PATH なしでエージェントが呼ぶ方法:

```bash
"$(herdr plugin config-dir herdr-loadout)/herdr-loadout" list --compact
```

どのシェルからでも `herdr-loadout` で呼ぶには、**すでに PATH にあるフォルダ**にインストールします:

```bash
node scripts/setup-shim.mjs --dir ~/.local/bin
```

一度インストールしたランチャーは Herdr 起動時に更新されるため、再インストールでプラグインの場所が変わっても動作します。

shim がなくても常に動作します:

```bash
node bin/herdr-loadout.mjs list --compact
```

`list --compact` はヘッダー・色・装飾のない固定形式です。オーケストレーターのパーサーが依存します。

```text
builder | normal | implementation/refactor
reviewer | cheap | review
scout | cheap | research
heavy | expensive | design
```

### 3. 設定ファイル

| ファイル | 用途 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | グローバルプロファイル |
| `<project>/.herdr/loadout.toml` | プロジェクトオーバーライド（記載したフィールドのみ置換） |

`herdr-loadout path` で実際の場所を確認できます。手で編集しても構いません。
未知のキーは保存時にも保持されます。

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

プロジェクトオーバーライドの例（effort と追加引数のみ変更）:

```toml
[[profiles]]
id = "builder"
effort = "high"
extra_args = ["--add-dir", "Assets"]
```

### 4. Director 用 AGENTS.md スニペット

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

モデルや harness の入れ替えはプロファイルの修正だけで済みます。AGENTS.md は変わりません。

### 5. エージェントにプロファイルを作らせる（非対話）

TUI は人間向けなので、エージェントは CLI の書き込みコマンドを使います。

```bash
# フラグで直接
herdr-loadout add --id builder-unity --name "Unity Builder" \
  --harness claude --model deepseek-v4.1 --effort high --cost normal \
  --when "Unity/FishNet implementation with asmdef awareness." \
  --avoid "Pure research." --tag unity --tag implementation \
  -- --add-dir Assets

# JSON/TOML ペイロードファイルから
herdr-loadout add --from profile.json
cat profile.toml | herdr-loadout add --from -

# 既存プロファイルの更新（指定したフィールドのみ）
herdr-loadout set builder --effort high

# このプロジェクトだけ変える（差分のみ保存）
herdr-loadout set builder --effort high --project .

# プロジェクトの override を解除し、グローバルに再び従う
herdr-loadout reset builder

# 削除（グローバルならこのプロジェクトの override も一緒に）
herdr-loadout remove builder-unity

# 設定ファイルをまとめてマージ
herdr-loadout import ./team-profiles.toml
```

`--project <PATH>` を付けると、グローバルではなくプロジェクトのファイル（`.herdr/loadout.toml`）に書き込みます。ルールは TUI と同じです。

| コマンド | グローバル（既定） | `--project` |
|---|---|---|
| `set` | グローバルのプロファイル自体を編集します。プロジェクトの override 値は混ざりません（変更したフィールドをこのプロジェクトがまだ上書きしている場合は知らせます） | グローバルと異なるフィールドのみ保存します。プロジェクト専用は全体を保存し、グローバルの値に戻ると override を削除します |
| `reset` | — | プロジェクトの override を削除します（`--project` 省略時はカレントディレクトリのプロジェクト）。プロジェクト専用には使えません |
| `remove` | グローバルのプロファイルとこのプロジェクトの override を一緒に削除します | プロジェクトの項目（override またはプロジェクト専用）を削除します |
| `add` | 既存の id は拒否 | グローバルに同じ id があっても拒否します（`set --project` で override） |
| `import` | そのままマージ | グローバルにある id は差分のみ override として保存し、同一ならスキップします |

`list` は TUI と同じく **Global profiles** と **Project profiles** に分けて表示し、override されたプロファイルには `Overridden: effort (global: medium)` のように差分とグローバルの値を示します。`list --json` の `differs` も同じ情報です。`list --compact` は変わりません。
`--json` は機械可読な結果（`{ok, id, scope, path, created}`）を出力します。
終了コード: `0` 成功、`1` ランタイムエラー、`2` 使用法/検証エラー。

同じ id が既にある場合 `add` は失敗します（`--force` で上書き、`set` で更新）。

アクションは引数を取れないため、先にペイロードファイルを書きます:

```bash
# エージェントが profile.json を書いた後
herdr plugin action invoke herdr-loadout.add-profile
```

## エージェントスキル

`skills/` にはエージェントが読むスキルが 2 つあります。

| スキル | 用途 |
|---|---|
| `herdr-loadout` | プロファイルを使って worker に作業を委任（照会 → `launch --json` → `herdr agent start`） |
| `herdr-loadout-edit` | プロファイルの追加・変更・削除・インポート |

`launch <id> --json` は `ok`、`harness`、`args` を返します。`args` は
`herdr agent start <name> --kind <harness> --` の後ろにそのまま付けます。
スキルファイルはライブラリへコピーされるため、改行は LF に固定しています（`.gitattributes`）。

## プロファイルのフィールド

必須: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
任意: `avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`

`harness` は `claude`, `codex`, `opencode`, `omp`, `pi`, `agy`（Antigravity CLI）, `custom` のいずれかです。
`custom` 以外で一覧にない値は検証で拒否されます。

## harness ごとの引数マッピング

| harness | model | effort | 備考 |
|---|---|---|---|
| `claude` | `--model` | `--effort` | 一覧コマンドがないため **omp の Anthropic カタログから導出**。omp がなければエイリアス（opus/sonnet/haiku/fable）にフォールバック |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | `codex debug models` でカタログ取得 |
| `opencode` | `-m` | `--variant` | `opencode models` で取得 |
| `omp` | `--model=` | `--thinking=` | `omp models --json` で取得（thinking レベル含む） |
| `agy` | `--model` | `--effort` | Antigravity CLI。`agy models` で取得。Herdr の `--kind agy` と同じ id。`gemini-3.8-flash-medium` のように id が `-low`・`-medium`・`-high` などで終わる場合、effort はその値になり `--effort` は付かない（TUI では Effort 項目を隠す） |
| `custom` | `--model` | `--effort` | 自由入力 |

## 検証方法

```bash
node --test          # ユニットテスト
```

手動での動作確認（Herdr が必要）:

```bash
herdr plugin pane open --plugin herdr-loadout --entrypoint ui
herdr pane read <pane_id> --source visible     # レンダリング確認
herdr pane send-keys <pane_id> down            # キー入力確認
herdr pane close <pane_id>
herdr plugin unlink herdr-loadout              # クリーンアップ
```

プラグイン pane は中のプロセスが終了すると自動的に閉じます（実測）。

## 設計ノート

- Herdr はプラグインに CLI サブコマンドを追加できません。そのため `herdr-loadout` は
  独立した実行ファイルです。
- プラグイン pane のコマンドは **pane の cwd** で実行されます。そのためマニフェストの
  コマンドは `bootstrap.mjs`（プラグインルートからモジュールを解決）を経由し、プロジェクト
  パスは pane の cwd ではなく Herdr が注入する `HERDR_PLUGIN_CONTEXT_JSON` から読みます。
- `herdr plugin action invoke` は引数を受け取らず stdout も返しません（非同期
  fire-and-forget）。したがって照会経路は CLI で、アクションは UI を開く専用です。
- プロファイルやモデルの検出に失敗してもプロファイル作成は妨げられません。
  カタログは 5 分 TTL でキャッシュされます。
- `claude` は一覧コマンドがないため **models.dev**（omp が読む公開カタログ）から導出します。
  順序: models.dev スナップショット（24 時間 TTL）→ omp → エイリアス。すべてオフラインで動作します。
- スナップショットは `herdr-loadout catalog --refresh` で更新します。

実測の根拠は [`docs/herdr-verified-facts.md`](../herdr-verified-facts.md)、
実装計画は [`docs/implementation-plan.md`](../implementation-plan.md) を参照してください。

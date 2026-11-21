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
- Herdr ≥ 0.7.0（TUI）。Herdr デスクトップアプリ（herdr-core `hc`）でも CLI とスキルが動作します — [Herdr アプリで使う](#herdr-アプリで使う) を参照
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

Herdr アプリではアプリ専用エディタ（アプリ mod）を使います。ソースのチェックアウトから一度インストールします:

```bash
npm run install:app-mod                         # ~/.config/herdr-app/mods/herdr-loadout にインストール
npm run install:app-mod -- --key ctrl-shift-a   # キーバインドも登録（使用中のキーなら拒否）
herdr-app do mod.open --name herdr-loadout      # キーバインドなしで開く
```

- フォーカス中のターミナルのプロジェクトを基準にグローバル/プロジェクトのプロファイルを表示し、キーと操作は TUI と同じです
  （`Enter` 編集、`a` 追加、`c` コピー、`d` 削除、`r` override 解除、`[`/`]` 並べ替え、`j` harness 一覧、`k` API キー、編集中 `g`/`p` 保存、`t` 実行チェック、`Esc` 戻る/閉じる）。マウスでもクリックできます。
- すべての読み書きは `herdr-loadout editor <action>`（CLI の JSON バックエンド）を経由するため、TUI とルールが同じです。
- アプリ mod は Node を使えないため、インストールスクリプトが node と CLI のパスを `cli.js` に書き込みます。チェックアウトを移動したら再インストールします。
- アプリのコマンドパレット（Ctrl+Shift+P）は mod の項目を受け付けないため、キーバインドか `mod.open` で開きます。

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
| `[` `]` | 選択中のプロファイルをグループ内で上/下へ移動（選択も追従） |
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
herdr-loadout command builder --name w1 --pane 3   # worker の起動コマンドを現在のプロファイル値で出力
herdr-loadout task new api-auth --worker builder-auth --profile builder   # .herdr/runs/<日付>-api-auth/ に brief.md と report.md を作る
herdr-loadout worker-check builder-auth   # 実行中の worker が今のプロファイルと合っているか（違えば exit 1）
herdr-loadout agents-md             # プロジェクトの AGENTS.md にある委任ブロックの状態（current | missing | outdated | declined）
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
builder | expensive | implementation/refactor/design
junior | normal | implementation/light
qa | normal | qa/testing
reviewer | cheap | review/security
scout | cheap | research
```

### 3. 設定ファイル

| ファイル | 用途 |
|---|---|
| `<HERDR_PLUGIN_CONFIG_DIR>/loadout.toml` | グローバルプロファイル |
| `<project>/.herdr/loadout.toml` | プロジェクトオーバーライド（記載したフィールドのみ置換） |

`herdr-loadout path` で実際の場所を確認できます。手で編集しても構いません。
保存（`set`、`add`、`remove`、`reset`、`import`、エディタ）は変更を求められたキーとブロックだけを書き換えるので、コメント、未知のキー、ほかのテーブル、空行、改行コードはそのまま残ります。そのように編集できないファイル（インライン配列で書いたプロファイルなど）は何も書き込まずに拒否します。

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

### 4. プロジェクトの AGENTS.md の委任ブロック

スキルはエージェントが委任すると決めた後にしか読み込まれません。そのため「ユーザーと話すエージェントは自分で作業せず委任する」
「harness 内蔵の subagent を使わない」というルールは、harness が起動時に必ず読むファイルに置く必要があります。ブロックの原文は
`src/core/agents-md.md` だけで、CLI がそのまま出力・インストールします。

```bash
herdr-loadout agents-md            # 状態: current | missing | outdated | declined（--json も可）
herdr-loadout agents-md print      # ブロックの原文
herdr-loadout agents-md install    # AGENTS.md に書く・更新する。必要な @AGENTS.md import も足す
herdr-loadout agents-md decline    # このプロジェクトでは二度と尋ねないよう記録
```

- `herdr-loadout` スキルがセッションごとに状態を確認し、`missing`・`outdated` ならブロックをユーザーに見せて一度だけ尋ねます。
  はいなら `install`、いいえなら `decline` です。尋ねずに書くことはなく、`[Worker-...]` プロンプトで始まった worker はこの手順を飛ばします。
- `install` は `<!-- herdr-loadout:start -->` と `<!-- herdr-loadout:end -->` の行の間だけを書きます。ファイルがなければ作り、
  マーカーがなければ末尾に足し、あればその間だけを置き換えます。再実行しても何も変わりません。マーカーが壊れていれば、どのファイルにも触れずに失敗します。
- 断った記録はリポジトリではなく、プラグインの状態フォルダの `agents-md-declined.json` にプロジェクトルートごとに残ります。`install` で消えます。
- プロジェクトルートは `--project`、なければ上にたどって最も近い `.git`・`.herdr` のあるフォルダです。

harness ごとにプロジェクトルートで読むファイルが違います。ドキュメントで確認し、pi 以外の五つは実際の実行（一時プロジェクトで各 harness に指示ファイルの内容を尋ねる）でも確認しました。pi はソースコードで確認しました。

| harness | 読むファイル | `install` がすること |
|---|---|---|
| claude | `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` のどれかがあればそれらだけ、なければ `AGENTS.md`（v2.1.277 以降） | そのファイルに `@AGENTS.md` import（`.claude/CLAUDE.md` は `@../AGENTS.md`） |
| omp | フォルダごとに一つ: `.omp/AGENTS.md` > `.claude/CLAUDE.md` > `.agent(s)/AGENTS.md` > `.gemini/GEMINI.md` > `.github/copilot-instructions.md` > `AGENTS.md` > `CLAUDE.md` | `AGENTS.md` より優先されるファイルがあればそこに import |
| codex | `AGENTS.override.md`、なければ `AGENTS.md` | `AGENTS.override.md` は `note:` で知らせるだけ（import を展開しない） |
| opencode | `AGENTS.md`（ないときだけ `CLAUDE.md`） | なし |
| agy | `AGENTS.md` と `GEMINI.md` の両方 | なし |
| pi | `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` | codex と同じ |

Claude Code が `CLAUDE.md` しか読まない場合（古いバージョン、または Project instructions が `claude-md`）は、`install --claude-md` が
`CLAUDE.md` を作って import します。`~/.claude/settings.json` に `claude-md` が設定されていれば、オプションなしでもそうします。

モデルや harness の入れ替えはプロファイルの修正だけで済みます。AGENTS.md のブロックは変わりません。

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

# 一覧の順序を変える（同じグループ内のみ：グローバル同士、プロジェクト専用同士）
herdr-loadout move scout --up
herdr-loadout move scout --down
herdr-loadout move scout --before builder
herdr-loadout move scout --after builder

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

`move` はグローバル/`--project` の区別に従いません。グローバルのプロファイル（override の有無を問わず）はグローバルファイル内で、プロジェクト専用はプロジェクトファイル内で並べ替え、override の位置は順序に影響しません。`--project` はプロジェクトを指定するだけで、書き込むファイルはプロファイルで決まります。

`move` は `[[profiles]]` のブロックだけをテキストとして移すので、コメント、ほかのテーブル、改行コードはそのまま残ります。ブロック単位で並べ替えられないファイル（インライン配列で書いたプロファイルなど）は何も書き込まずに拒否します。
`move --json` は `{ok, id, scope, index, moved, path, order, message}` を出力します。`index` は移動後の一覧での位置（0 始まり）、`order` はそのグループの新しい順序です。すでにその位置で何も変わらないときは `moved: false`、`path: null` で、`order` はありません。
終了コード: 何も変わらなくても `0`、存在しない id・別グループや自分自身を基準にした移動・ブロック単位で並べ替えられないファイルは `1`（ファイルはそのまま）、位置フラグがない、または複数あるときは `2`。

`list` は TUI と同じく **Global profiles** と **Project profiles** に分けて表示し、override されたプロファイルには `Overridden: effort (global: medium)` のように差分とグローバルの値を示します。`list --json` の `differs` も同じ情報です。`list --compact` は変わりません。
`--json` は機械可読な結果（`{ok, id, scope, path, created}`、`move` は上記の形）を出力します。
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
| `herdr-loadout` | プロファイルを使って worker に作業を委任（プロジェクト設定 → 作業方針の読み込み → 照会 → `command` が出力した `herdr agent start` または `hc run` を実行） |
| `herdr-loadout-edit` | プロファイルと作業方針の追加・変更・削除・インポート |

`command <id>` は worker を起動するホストコマンドを、実行時点のプロファイル値で出力します。エージェントが以前に
使ったモデルや effort を記憶から書き直さないようにするためです。`--host herdr|hc`、`--name`、`--pane`（TUI）、
`--space`・`--tab`（アプリ）、`--cwd`（既定: 現在のフォルダ）を受け取り、指定しなかった値は `<pane_id>` のようなプレースホルダーで出力されます。
アプリでは `--tab self` が自分を表示しているタブを `herdr-app ls` から探して使い、`--space` を指定しなければそのタブの space も使います。
ほかの worker を率いる worker が、メンバーを自分のタブに置くときに使います。アプリが新しいタブに置いた worker には `herdr.tab` ラベルがないためです。
`--shell powershell` なら PowerShell の引用規則で、既定では sh（bash、Git Bash、zsh）の規則で囲みます。
`#` で始まる行は案内です。TUI でプロファイルに `env` がある場合、pane を開くときに渡す `--env` フラグを案内として出力します。

`launch <id> --json` は同じ値を `ok`、`harness`、`args`、`env`、`argv` として返します。

`env` の値は API キーである場合があるため、`list`、`show`、`launch`、`command` の出力と編集画面（TUI・アプリ）ではすべて
`***` で伏せます。編集画面の Env 欄で `KEY=***` をそのままにすると既存の値が保たれ、新しい値を入力すると置き換わります。
`command` が出力する TUI の `--env` フラグは `"KEY=$(… env-value <id> KEY)"` の形なので、シェルが実行するときに値を
読み込みます。実際の値は `herdr-loadout env-value <id> <KEY>` でしか出力されません。アプリ（`hc`）では `exec` が値を直接設定します。

### 作業方針（workflow）

スキルにはコマンドだけがあり、委任するときの選択は作業方針ファイルにあります: どのプロファイル系統にどの仕事を任せるか、
プロンプト・brief・報告ファイルの形式、タブの使い方、worker をいつ閉じていつ残すか、worker 同士の協業のしかた。
プロファイルと同じく 2 層です。

| 層 | ファイル | 用途 |
|---|---|---|
| グローバル | `<設定フォルダ>/workflow.md`（なければ組み込みのデフォルト） | すべてのプロジェクトに共通 |
| プロジェクト | `<project>/.herdr/workflow.md` | このプロジェクトだけのルール。グローバルの後ろに付き、食い違う場合はこちらに従う |

```bash
herdr-loadout workflow                      # このプロジェクトに適用される作業方針（スキルが委任前に読む）
herdr-loadout workflow init --project .     # プロジェクトのルールファイルを作る（違う点だけ書く）
herdr-loadout workflow init                 # 組み込みのデフォルトをグローバルファイルにコピーして編集する
```

グローバルファイルを作ると以後はユーザーのファイルになるため、組み込みのデフォルトが変わっても反映されません。
`herdr-loadout path` の `globalWorkflow`、`projectWorkflow` が 2 つのファイルの場所です。

### タスクフォルダと報告

委任するタスクごとに `.herdr/runs/<YYYY-MM-DD>-<slug>/` フォルダを 1 つ使います。`task new` がその中に `brief.md` と
`report.md` を作り、オーケストレーターのアドレス（アプリは `$HC_TERMINAL_ID`、TUI は `$HERDR_PANE_ID`、`--to` で変更）と
worker が報告に使うコマンドを埋めます。`runs/` を新しく作るときは `runs/.gitignore`（`*`）も書くので、`.herdr/` を
コミットするプロジェクトでもタスクファイルはコミットされません。同じフォルダがすでにあれば拒否します。

```bash
herdr-loadout task new api-auth --worker builder-auth --profile builder   # 最後の行が worker に送るプロンプト
herdr-loadout command builder --host hc --name builder-auth --task .herdr/runs/2026-11-21-api-auth --space <space_id>
herdr-loadout worker-check builder-auth                                      # 残した worker に再びプロンプトする前に
```

- タスク id は slug を大文字にしたものです（`api-auth` → `API-AUTH`）。報告ファイルの最後の行は `API-AUTH-COMPLETE`、
  `API-AUTH-PARTIAL`、`API-AUTH-BLOCKED`、`REVIEW-READY <n>` のいずれかです。
- 完了の合図は worker が送ります。報告ファイルを書いたあと、`[Report-<worker>] <MARKER> <report>` の 1 行を
  オーケストレーターに送ります（アプリは `hc send`、TUI は `herdr agent prompt`）。判断の基準は報告ファイルで、この行は合図にすぎません。
- オーケストレーターは完了をポーリングしません。アプリでは報告せずに止まった worker に気づくため、バックグラウンドで
  `hc wait --children any` を 1 つ動かし、TUI では worker ごとに `herdr agent wait <worker> --until blocked` を 1 つ動かします。
  アプリの watch はまず `reason` を見ます。`message` の戻りは `children` が空でも worker がいないという意味ではなく、
  `children` の戻りで worker が 1 つもないときだけ watch を止めます。
- まとまった実装の次の段階は独立した QA です。実装者とハーネスかモデルが異なる `qa` プロファイルが、コードを読む前に brief から
  シナリオを書き、実際の CLI とホスト（TUI は隔離した `herdr --session <name> server`、アプリは終わったら閉じる一時的な hc worker）で
  実行します。見つけたバグはすべて回帰テストにし、ラウンドごとに新しい QA worker が `qa-<n>.md` を書きます。ソースの修正は実装者に
  戻します。コードレビュー（`review-<n>.md`）は、セキュリティに関わる変更（シェルのクォート、秘密値、権限）かユーザーの依頼があるときだけです。
- テンプレート: `<project>/.herdr/templates/brief.md`・`report.md` があればそれを、なければ組み込みのもの（`src/core/templates/`）を
  使います。`{{task}}`、`{{worker}}`、`{{notify}}` などの `{{key}}` が埋められ、知らないキーはそのまま残ります。
- `command --task <フォルダ>` は worker のプロファイルと起動の指紋（harness、引数、env の名前。値は含めない）をそのフォルダの
  `workers.json` に記録します。アプリ（`--host hc`）では同じ値を `hc run` のラベルとしても付けます。`worker-check` はこの記録を
  今のプロファイルと実行中の worker と比べ、プロファイルが変わった、別のプロファイルで動いている、シェルに戻った、TUI の再起動で
  起動引数を失った、のいずれかなら理由を出力して exit 1 で終わります。ホストに問い合わせられない（CLI がない、サーバーが
  停止している）ときは `host-unavailable` で exit 1 になります。worker の状態は不明なので、起動し直さずに再確認します。

### Herdr アプリで使う

スキルは `HERDR_ENV=1` なら TUI（`herdr`）、`HC_TERMINAL_ID` があればアプリ（`hc`、`herdr-app`）と判断し、
対応する CLI を使います。アプリでは `launch <id> --json --host hc` を使います。

- `argv` が worker コマンド全体です: `hc run --bg --name <name> --cwd <dir> --label herdr.space=<space> -- <argv...>`。
- `hc run` は環境変数を渡せないため、`env` があるプロファイルの `argv` は
  `herdr-loadout exec <id>` を経由します。`exec` が env を適用して harness を起動し、終了コードをそのまま返します。
  引数に二重引用符が含まれる場合（agy の `--settings` JSON など）も同じ経路を使います。Windows PowerShell 5.1 が
  ネイティブコマンドに渡す引数から二重引用符を取り除いてしまうためです。
- Codex は `hc` 配下で `--no-daemon` が必要なため、`--host hc` のときは自動で付きます。
- アプリにはプラグインアクションがありません。launcher がなければ、ソースチェックアウトで `node scripts/setup-shim.mjs` を実行して作成します。

スキルファイルはライブラリへコピーされるため、改行は LF に固定しています（`.gitattributes`）。

## プロファイルのフィールド

必須: `id`, `name`, `harness`, `model`, `effort`, `when_to_use`
任意: `avoid_when`, `cost`(cheap|normal|expensive), `provider`, `mode`, `extra_args`, `env`, `tags`, `skills`, `notes`, `sandbox`, `approval_policy`, `permission_mode`, `api`, `auth`

`api` はハーネスを自前のログインではなく保存済みの API キーで起動させます。値は保存済みキーの id で、空なら
ハーネス自身のログイン（サブスクリプション）を使います。対応する組み合わせ:

| ハーネス | プロバイダー | 接続方法 |
|---|---|---|
| claude | DeepSeek | DeepSeek の Anthropic 互換エンドポイント（`https://api.deepseek.com/anthropic`） |
| agy | Google AI Studio | Gemini API |

Codex は Responses API しか受け付けません（0.170 では `wire_api = "chat"` を拒否）。DeepSeek と Google は Responses API を
提供していないため、Codex には使えません。

キーはプロフィールとは別に、グローバル設定フォルダーの `keys.toml` に保存されます。プロジェクトファイルには入らない
ためリポジトリにコミットされることはなく、すべての出力で末尾 4 文字だけが表示されます（`sk-…1a2b`）。

```bash
herdr-loadout keys add deepseek --provider deepseek   # キーは stdin から読む（端末では非表示入力）
herdr-loadout keys list                               # 保存済みキー（マスク）とプロバイダー
herdr-loadout keys test deepseek                      # キーが使えるかプロバイダーに問い合わせる
herdr-loadout set <id> --api deepseek                 # プロフィールがそのキーで起動する
```

アプリのエディターでは `k`（API キー画面）でキーを追加・テスト・削除し、claude / agy プロフィールの API 欄で選びます。
キーを選ぶとモデル一覧がそのプロバイダーの一覧（DeepSeek `/models`、Gemini API）に切り替わります。

起動時に設定するもの:

- claude + DeepSeek: `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN=<キー>`、`ANTHROPIC_MODEL`・`ANTHROPIC_DEFAULT_OPUS_MODEL`・
  `ANTHROPIC_DEFAULT_SONNET_MODEL`=`<モデル>[1m]`、`ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash`、
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、そして継承された `ANTHROPIC_API_KEY` を空にします。`--model` も `<モデル>[1m]`
  （1M コンテキストの印。リクエスト前に Claude Code が外します）で渡します。DeepSeek の Claude Code ガイドに従った値です。
- agy + Google: `GEMINI_API_KEY=<キー>` と `--settings <状態フォルダー>/agy-api/…/settings.json`（`{"modelProvider":"gemini"}`）。
- プロフィールの `env` が同じ名前を設定していればそちらが優先されます。キーがない、またはハーネスに合わない場合は
  `launch` の `API key` チェックが失敗します。

agy の `auth = "api-key"` も引き続き動作します。この場合キーはプロフィールの `env.GEMINI_API_KEY` か worker の環境の
`GEMINI_API_KEY` から読みます。agy に組み込まれた API モデル一覧は agy のビルド時点で固定され、新しいモデルが含まれません。
そのため一覧を読むたびにキー（環境の `GEMINI_API_KEY`、プロフィールのキー、保存済み Google キーの順）で Gemini API の
モデル一覧を照会し、agy にない Gemini モデルを同じ settings ファイルの `customModelsConfig` に custom model として登録します。
新しいモデルはエディタのモデル一覧と `--model` ですぐに使えます。照会に失敗した場合は前回見つけた一覧をそのまま使います。

`harness` は `claude`, `codex`, `opencode`, `omp`, `pi`, `agy`（Antigravity CLI）, `custom` のいずれかです。
`custom` 以外で一覧にない値は検証で拒否されます。

## harness ごとの引数マッピング

| harness | model | effort | 備考 |
|---|---|---|---|
| `claude` | `--model` | `--effort` | 一覧コマンドがないため **omp の Anthropic カタログから導出**。omp がなければエイリアス（opus/sonnet/haiku/fable）にフォールバック |
| `codex` | `-m` | `-c model_reasoning_effort=<lvl>` | `codex debug models` でカタログ取得 |
| `opencode` | v1: `-m` · v2: config の `model` | v2: config `model` の `#variant`（v1 では渡らない） | `opencode models` で取得。インストール済みのバージョン（`opencode --version`）で引数を選ぶ。v2 の TUI には `-m` がないため、モデル・effort・権限を `OPENCODE_CONFIG_CONTENT` で渡し、その env を読ませるため `--standalone` を付ける（共有バックグラウンドサーバーはワーカーの env を無視する） |
| `omp` | `--model=` | `--thinking=` | `omp models --json` で取得（thinking レベル含む） |
| `agy` | `--model` | `--effort` | Antigravity CLI。`agy models` で取得。Herdr の `--kind agy` と同じ id。`gemini-3.8-flash-medium` のように id が `-low`・`-medium`・`-high` などで終わる場合、effort はその値になり `--effort` は付かない。エディターはこうした id を 1 つのモデル（`gemini-3.8-flash`）にまとめて表示し、レベルは Effort で選ぶ（保存される値は `gemini-3.8-flash-medium` のような完全な id） |
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

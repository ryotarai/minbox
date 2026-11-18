# minbox 再設計 2: 会話と仕事の単位を切り離す

> **改訂 (2026-11-18)**: 実データで使ってみた結果を受けて、「タグ」という概念は廃止した。メッセージは単に
> ちょうど 1 つのタスク**についての**もの（に属す）であり、画面には「in: <タスク>」というリンクと「Move to another task…」
> の操作だけを出す（改訂 7 で「Not about a task」は無くなった: どのメッセージも必ずタスクに属す。改訂 8 で「Also about…」も
> 無くなった: メッセージとタスクは N:1）。以下の本文で「タグ」「タグ付け」とあるのは、この
> 「メッセージがどのタスクについてのものか」の意味で読むこと（データは `message_tasks`、API は
> `/api/v3/messages/{id}/tasks`・`/move`）。詳細は §13 の改訂と `api.md`。


前回（`redesign.md`）への指摘: 「それはスレッドをタスクに改名しただけでは？」。その通りで、「1 つの入れ物 = 1 つの会話 = 1 つの仕事」という構造は変わっていなかった。
この案は**会話を入れ物で刻むのをやめる**。会話はエージェント（セッション）ごとの 1 本の流れ、仕事（タスク）はその流れの上に貼るタグ。
モックアップ: `redesign2.html`（デスクトップ 2 画面 + スマホ 2 画面、ライト/ダーク）。以前のファイルはそのまま残してある。

---

## 0. 結論

- **会話 = ストリーム**。セッション（エージェント）ごとに 1 本の途切れない会話で、同僚とのチャットに近い。スレッドを選んでから話す必要はなく、その相手に話しかけるだけ。
- **仕事 = タスク**。注意を向ける単位で、状態・チェックリスト・人待ち・PR/Linear を持つ。メッセージとタスクは**多対多**: 1 通が 2 つの話題に触れれば 2 つのタグ、雑談ならタグ無し。
- **タスク画面 = タスクの項目 + そのタグが付いたメッセージ（複数のストリームを横断した切り出し）+ イベント**。前後の文脈はその場で展開できる。
- **質問はメッセージに属す**。付いているタグのタスクに表示され、全体の NEEDS YOU にも出る。どこで答えても同じ質問に答えたことになる。
- **ホーム = タスクの Board**（NEEDS YOU / WORKING / BLOCKED / DONE）+ 左に **Agents**（チャットアプリのサイドバーのようなストリーム一覧）。
- **推奨は A（ストリーム + タグ付きタスク）**。B（項目の受信箱）の「NEEDS YOU は質問カード」という良さを Board に取り込む。
- これが改名と違う決定的な理由は、**エージェントの実態（1 セッション = 1 本の文脈）と人の見え方が一致する**こと。今のスレッドは「人の画面では別々の会話、エージェントの頭の中では 1 本」というずれを抱えていた。
- 実はデータの芽は既にある。今の topic の `message_ids` は「タスク ↔ メッセージの多対多」そのもの。この案はそれを主役にして、スレッドという入れ物を外す。

---

## 1. 3 つの案

### A. ストリーム + タグ付きタスク（推奨）
会話はエージェントごとの 1 本の流れ。タスクはメッセージに貼るタグ（多対多）と、状態・チェックリスト等の項目。ホームはタスクの Board と Agents 一覧。

### B. 項目の受信箱
会話はエージェントごとの 1 本の流れ（A と同じ）。注意の単位は**メッセージから生まれる項目**（質問・アクション・報告・完了通知をそれぞれ 1 枚のカードにする）。カードを処理（回答・確認・却下）すると消える。タスクは無いか、ごく軽い。

### C. タスク = 入れ物（前回案）
スレッドの行 = タスク（1:1）。メッセージは必ず 1 つのタスクに属す。分割・統合・移動の操作で整理する。

### 比較

| 観点 | A ストリーム + タグ | B 項目の受信箱 | C タスク = 入れ物 |
| --- | --- | --- | --- |
| 人の頭の中 | 「エージェントと話す」と「仕事を追う」が別の面。チャット + プロジェクト管理 | 「エージェントと話す」+「やることカードを片付ける」。チャット + 通知センター | 「仕事ごとの会話」。今のスレッドと同じ（名前が変わるだけ） |
| 話しかける場所 | エージェントのストリーム、またはタスク画面（宛先のセッションに届き、タグが自動で付く） | エージェントのストリーム（カードから返信も可） | タスク（= スレッド） |
| 2 話題が混ざった 1 通 | タグを 2 つ付ける。自然 | カードは 1 枚（質問単位）。話題は区別しない | どちらか 1 つに入れ、片方は参照。不自然 |
| 仕事の進み具合の一望 | ◎ Board（状態・進捗・PR） | × 無い（カードは点で、線にならない） | ◎ Board |
| 「人待ち」の見え方 | 質問カード + 付いたタスク。タグ無しの質問も「未分類」として出る | ◎ カードそのもの。一番速い | タスク単位（質問は入れ物に従う） |
| 経緯の追いやすさ | タスク画面で切り出し + 文脈展開。セッションをまたいでも 1 本 | ストリームを遡るしかない | 入れ物の中だけ。セッションをまたぐと分割リンクを辿る |
| エージェントの実態との一致 | ◎ セッション = 1 本の文脈 = 1 ストリーム | ◎ 同じ | × 人には別会話、エージェントには 1 文脈 |
| エージェントの負担 | `thread_id` / `thread_title` が不要になり、`task_ids` は任意（自動で付く）。**今より軽い** | 最小（タスク無し） | 今と同じ（`task_id` を毎回選ぶ） |
| 壊れるもの・移行の重さ | 大: thread_id 前提の部分（配信、Slack、Linear、fork、既読）を作り直す。ただし内部では「セッションごとに 1 本の内部スレッド」で吸収できる（§5） | 中: ストリーム化は A と同じ。タスク/Board は捨てる | 小: ほぼ改名 |
| 弱点 | タグの精度。タグ無しの発言が溜まる。既読が 2 軸になる | 進捗が見えない。モックで愛された Board と真逆 | 指摘の通り、何も変わらない |

**推奨: A**。B の長所（質問がそのまま処理できるカード）は A の NEEDS YOU の表示に取り込む。C は今の延長で、新しい価値がない。

---

## 2. モデル（A）

```
Project
 ├─ Agent (= session)            名前, agent 種別, host, cwd, ターン中/待機, terminal/shell/files
 │    └─ Stream                  そのエージェントとの 1 本の会話（人 ↔ エージェント）
 │         └─ Message            author, body, attachments, questions/actions, read_at
 │               └─ tags ──┐     0..n タスク（多対多, source: agent|auto|person|suggested）
 └─ Task  <────────────────┘     title, summary, status, checklist(入れ子 1 段), report,
                                  links(PR, Linear), agents(0..n: 担当/関与), parent?, events
```

- **ストリームはセッションと 1:1**。セッションの再起動・フォルダ移動でも同じストリームが続き、区切り線が入る。セッションを削除すると流れは読み取り専用で残る（アーカイブ）。
- **タスクの担当 (`agents`)**: 明示の担当（作ったセッション、人が割り当てたセッション）+ 関与（タグ付きメッセージを書いたセッション）。1 タスクに複数のエージェントが付ける（引き継ぎ、並列のサブエージェント）。
- **タスクの状態**: `working / needs_you / blocked / done`。`needs_you` は**明示**（エージェントか人が設定）か**導出**（タグ付きメッセージに未回答の質問/アクションがある）のどちらか。導出の方は、質問に答えると自動で外れる。
- **質問**: メッセージに属す（今と同じ）。回答は質問の持ち主のストリームに、人のメッセージとして届く（今の回答の仕組みのまま）。
- **「minbox」ストリーム**: プロジェクトのメインセッションを Agents 一覧の先頭に「api（main）」として置き、「とりあえず話しかける相手」にする。全プロジェクト横断のコンシェルジュ（受けた依頼をタスクにしてセッションに振る orchestrator）は §9 の決定事項。

---

## 3. 難所 1: タグ付け

タグの精度がこの案の生命線。**エージェントが何もしなくても大半が正しく付く**ことを目標に、層を重ねる。

| 層 | 規則 | 付く印 |
| --- | --- | --- |
| 1. 明示 | `send_message {task_ids: [...]}`。`create_task` / `update_task` の返り値の id を使う | agent |
| 2. ターンの文脈 | 今のターンが答えている人のメッセージのタグを継承し、さらに**同じターンで create/update されたタスク**を加える | auto |
| 3. 1 つだけ | このセッションに未完了の担当タスクが 1 つだけならそれ | auto |
| 4. 返信の継承（人） | 人がストリームで特定のメッセージに返信（引用）したら、そのタグを継承する。タスク画面から書いたらそのタスク | auto |
| 5. 提案（任意・既定オフ） | タグ無しのエージェントメッセージに、補助モデルが候補を破線のチップで示し、人がワンクリックで確定 | suggested → person |
| 6. 人の手 | どのメッセージでもチップの追加・削除。`#` でタスクを補完 | person |

- タグ無しはエラーではない（雑談、確認、相談）。ストリームで読めば足りる。
- 層 5 について: 少し前に補助モデルによる Tasks 抽出をやめた経緯があるので、**自動では付けず「提案」に留め**、既定オフにする。
- エージェント自身の付け替え: `update_task {task_id, message_ids}`（既存の関連メッセージ追加と同じ）で過去のメッセージにタグを足せる。
- 誤タグの影響は小さい: タスク画面に余計な 1 通が出るだけで、会話そのものは壊れない（入れ物方式では誤った振り分け = 会話の断絶だった）。

---

## 4. 難所 2: 既読・返信・配信

### 既読
- **メッセージ単位の `read_at`**（エージェントのメッセージ）。ストリームで画面に出たら既読、タスク画面で出ても既読。2 つの面のどちらで読んでも 1 回読めば済む。
- 未読の数え方: Agents 一覧はストリームの未読数、Board のタスクはタグ付きメッセージの未読の点。
- 「既読にする」(`E`) は、ストリームでは全件、タスクでは**そのタスクのタグが付いたメッセージ**を既読にする。
- 今の「Mark read で静かにする」は「タスクを Done / スヌーズ」とストリームの既読に分かれる。

### タスク画面からの返信
- 宛先: そのタスクの**直近に活動したエージェント**（最新のタグ付きエージェントメッセージのセッション）。返信欄に「to: api-main ▾」として出し、担当の別セッション、新しいセッション（引き継ぎ）、メインセッションに切り替えられる。担当がいないタスクは宛先を選ぶ（既定はメインセッション）。
- タグ: そのタスクを自動で付ける。エージェントには今の `[Task: <title>]` 見出しと同じ形でタスク id/題が届く。
- 届く先はそのセッションのストリームなので、ストリームを見ても同じ発言が（タスクのチップ付きで）並ぶ。

### エージェントへの配信
- 人のメッセージは `<minbox_message id="…" tasks="T12 Fix gauge; T15 Canary">…</minbox_message>` で包む。タグ無しなら `tasks` は付かない。
- 1 セッション 1 ストリームなので、今の「複数スレッドの未配信をまとめて渡す」処理が単純になる。

---

### 4.5 人は送るだけ、タスクにするかはエージェントが決める（決定済み）

人の入力欄は 1 つだけ: 宛先（既定はメインセッション）と本文。「タスクとして送る」切替は置かない。エージェントがそのターンで次のどれかを判断する:

1. **既存のタスクの話** → 人のメッセージとエージェントの返信の両方にそのタスクのタグが付く。必要ならタスクを更新する（ステップ、状態、終わっていれば再開）。
2. **新しい仕事** → `create_task` を呼ぶ。人のメッセージと返信に新しいタスクのタグが付く。
3. **雑談・ちょっとした質問** → タグ無し。ストリームで完結する。

**契約（いちばん単純な形）**: 人のメッセージにタグを付けるための専用ツールや引数は作らない。
- エージェントの `send_message {task_ids}` は、**そのターンで配信された人のメッセージのうち、まだタグが無いもの**にも同じタグを付ける（サーバが付ける）。
- 同じターンで `create_task` を呼ぶと、新しいタスクは自動でそのターンの返信と人のメッセージに付く（`task_ids` を書かなくてよい）。
- 後から付け直すときは `update_task {task_id, message_ids}`（既存の関連メッセージ追加）を使う。
- **エージェントが判断しなかったとき**（`task_ids` 無し、`create_task` も無し）: 人のメッセージはタグ無しのまま。ストリームには必ず出るので困らず、人が後でタグを付けられる。サーバは推測でタグを付けない。

**タスク画面から送った場合**: 人がもう文脈を選んでいるので、そのタスクのタグは送った時点で付く。エージェントは、本文が別のタスクにも触れていればタグを**追加**できる（外すのは人だけ）。

**判断を見せる**: エージェントの返信の下に小さな注記を出す。`→ tagged #<タスク> (existing task)` / `→ created #<タスク>` / `→ no task (just a reply)`。そこに「wrong task?」（タグ無しなら「tag it?」）があり、ワンクリックで `#` ピッカーが開く。選び直すと、人のメッセージと返信の**両方のタグが移る**。間違って作られたタスクにメッセージが 1 つも残らなければ、そのタスクは消える。

system prompt に足すのは 1 文: 「人のメッセージには、既存タスクの話なら `task_ids` を付けて返信し、新しい仕事なら `create_task` してから返信する。雑談ならタグは要らない。」

プロトタイプ（`proto.html`）はこの挙動を再現している。偽のエージェントは、タスクのキーワード（gauge / threshold / tenant / #7598 など）との一致で既存タスクを選び、作業の動詞（fix / add / 直して など）や長文なら新しいタスクを作り、それ以外はタグ無しで返す。

## 5. 難所 3: 内部の thread_id はどうなるか

**内部ではセッションごとに 1 本の「ストリーム用スレッド」を使う**（`threads` 行を 1 つ、`kind = 'stream'`）。こうすると、`thread_id` を鍵にしている次の仕組みが**そのまま動く**:
メッセージ、質問、回答、添付、注釈、ガイド付きレビュー、`!` コマンド、配信キュー（`/api/agent/pending`）、handoff の注入。

| 今 thread_id に依存するもの | A での扱い |
| --- | --- |
| 配信キュー・既読・質問・添付・コマンド | ストリーム用スレッドに載る（変更小） |
| スレッドの状態（working / need_action …） | 廃止。状態はタスクへ。ストリームには「ターン中/待機」（セッションの状態）だけ |
| スレッドの題 (`thread_title`) | 廃止（受け付けて無視する）。セッションの題（`set_session_title`）が「今していること」 |
| Linear リンク（`thread_links`） | タスクのリンクに移す（`task_links`）。Linear のコメントは、そのタスクの直近のエージェントのストリームに、タスクのタグ付きで注入 |
| Slack（スレッド ↔ Slack スレッド） | **タスク ↔ Slack スレッド**（人待ちや完了の通知をタスクごとの Slack スレッドに）。Slack での返信は、タスク画面からの返信と同じ規則で配信。タグ無しの質問の通知は、エージェントごとの Slack スレッドに |
| fork（スレッドから新しいスレッド） | 「**タスクを別のエージェントに引き継ぐ**」に置き換える。引き継ぎ文（今の fork の凍結 handoff）を新しいセッションのストリームの最初のメッセージの前に付け、タスクのタグ付きで送る。タスクの担当が 2 つになる |
| アーカイブ / スヌーズ / ピン | タスクが持つ（Done で Board から消える。スヌーズ・ピンもタスク）。ストリームはアーカイブ（セッション単位）だけ |

---

## 6. 画面

### 6.1 デスクトップ
`[プロジェクトレール] [サイドバー 240: Board(件数) / Agents 一覧] [中央: Board | タスク画面 | ストリーム] [右: タスクの項目 or エージェントの担当タスク / ターミナル]`

- **サイドバー**: 上に「Board」（NEEDS YOU 件数）、その下に Agents（チャットアプリの相手一覧）。各行は状態の点（ターン中は脈動）、名前、今していること（セッションの題）、未読数。先頭はメインセッション。
- **Board**:
  - **NEEDS YOU** は**質問カード**（B から取り込み）。見出しは `you: <質問>`、下にその質問が属すタスク（複数可）とエージェント名、単一選択なら選択肢ボタン。タスクに明示の `needs_you` があって質問が無い場合はタスク行（質問のあるタスクは行を重ねて出さない）。タスクに属さない質問はエージェント名だけを出し、「未分類」の印は出さない。
  - WORKING / BLOCKED / DONE はタスクの行: 題、関与エージェントのチップ、進捗バー、PR、経過。
- **タスク画面**:
  - 中央: 見出し（状態、題、関与エージェント、PR、Linear）。その下に**そのタスクについてのメッセージを時系列で**、複数のストリームを混ぜて表示し、各発言にストリーム名を出す。メッセージ間の飛びは「api-main で 3 件 ⋯」の区切りで表し、クリックすると前後の他のメッセージ（文脈）が薄く展開される。イベント（ステップ、状態、PR/CI、引き継ぎ）は小さな行で挟む。下に返信欄（宛先と「about: <タスク>」を表示）。
  - 右: CHECKLIST、LAST REPORT、FACTS、関連タスク。
- **ストリーム画面**:
  - チャット。各メッセージの下にタスクのチップ（色付き。破線は提案）。チップをクリックするとそのタスクへ。
  - 右パネルは「このエージェントの担当タスク」（状態とバー）と、ターミナル・shell・ファイルの切替。
  - ストリームの返信欄は既定でタスク無し（エージェントが決める）。`#` か、直前の引用でタスクを指定できる。

### 6.2 検索（`⌘K`）
タスク（題・要約・ステップ）、エージェント（`@`）、メッセージ全文（`/`、結果にストリーム名とタスク、選ぶとストリームの該当位置へ。タスクに属すメッセージなら「タスクで開く」も）、プロジェクト（`!`）、操作（`>`）。

### 6.3 通知
- 単位は**質問**（needs-you）と**タスクの状態変化**（done / blocked は任意）。タスクに属さない質問はエージェント名で通知する。
- 長い報告そのものは通知しない（未読数にだけ数える）。
- タブのバッジは NEEDS YOU の件数。

### 6.4 キーボード
| キー | |
| --- | --- |
| `G B` / `G A` | Board / Agents（`⌘1`〜`⌘9` でエージェント切替） |
| `J` / `K` | 次・前（Board の行、ストリームのメッセージ） |
| `N` | 次の NEEDS YOU。`1`〜`9` で答える |
| `Enter` | タスクを開く / ストリームでメッセージのタスクを開く |
| `R`, `⌘↵` | 返信、送信 |
| `#` | 返信欄でタスクを指定。メッセージ選択中の `#` は「Move to task…」 |
| `X` / `M` | タスクの完了・再開 / 状態移動 |
| `E` | 既読（ストリームなら全件、タスクならそのタスクのメッセージ） |
| `C` | タスク画面で前後の文脈を展開 |
| `⇧N` | 新しいメッセージ（宛先は既定でメインセッション）。タスクにするかはエージェントが決める（§4.5） |
| `T` / ``Ctrl+` `` / `F` | ターミナル / shell / ファイル |

### 6.5 スマホ
- 下のタブは **Board / Agents**。
- Board: NEEDS YOU は質問カード（1 タップで回答）、他はタスク行。
- タスク画面: 上に状態とチェックリストの帯（折り畳み）、本文はそのタスクのメッセージ（ストリーム名付き、文脈の区切りをタップで展開）、下に返信欄（to: エージェント）。
- Agents: 相手一覧 → ストリーム（チャット、タスクのチップ）。メッセージを長押しすると「タスクに付ける / 外す」。

---

## 7. エージェント側の契約（Claude Code mod / Pi 拡張 / OpenCode プラグイン共通）

| ツール | A での形 | 今との差 |
| --- | --- | --- |
| `send_message` | `{body, task_ids?: string[], attachments?, review?}` | `thread_id` / `thread_title` が**不要**（受け付けるが、`thread_id` は無視）。`status` は**拒否**（エラーで何も保存しない。タスクの状態は update_task で設定する。以前は付いたタスクへ適用していたが、done のタスクを誤って再オープンしたため廃止）。宛先を選ぶ手間が消える。**`task_ids` は、このターンが答えている人のメッセージ（まだタグが無いもの）にも付く**（§4.5） |
| `create_task` | `{title, summary?, steps?, status?, parent_id?}` → `task_id`。作ったセッションが担当になり、同じターンのメッセージに自動でタグが付く | スレッドへの所属が無くなる |
| `update_task` | `{task_id, title?, summary?, steps?(入れ子), check_steps?, status?, report?, links?, message_ids?}` | `message_ids` = 過去メッセージへのタグ追加 |
| `list_tasks` | 担当または関与しているタスク（未完了 + 直近の完了） | スレッド別ではなく一覧 |
| `set_session_title` | 変更なし（Agents 一覧の「今していること」） | — |

system prompt の `# minbox` 節は今より短くなる:
- 「人とはあなたのストリームで話す。仕事を始めるときは `create_task`、進めたら `update_task`。」
- 「メッセージがタスクの話なら `task_ids` を付ける（ターン中に触ったタスクには自動で付くので、別のタスクの話をするときだけ必要）。」
- 「人を待つときは質問ブロックを使う（タスクが自動で needs-you になる）。」

忘れたときの頑丈さ: タグが付かなくてもメッセージはストリームに必ず届き、人は読める。質問は NEEDS YOU に「未分類」として必ず出る。失われるのは「タスク画面に出るかどうか」だけで、これは人が後からワンクリックで直せる。

---

## 8. 既存データの移行

1. **ストリーム**: 各セッションの全スレッドのメッセージを時刻順に 1 本へ（物理的にはストリーム用スレッドを作り、旧スレッドは `kind = 'segment'` として残す）。ストリーム表示では旧スレッドの境目に「— <旧スレッドの題> —」の区切りを入れる（文脈の手がかり）。
2. **タスク**:
   - 既存の topic → タスク（状態、ステップ、`detail`、`manual_*`）。`message_ids` は**そのままタグ**になる（多対多の芽がそのまま生きる）。
   - topic が無く未完了（need_action / working / blocked）のスレッド → タスクを 1 つ作り（題 = スレッドの題）、そのスレッドの全メッセージにタグを付ける。
   - topic が無い finished / archived のスレッド → タスクは作らない（ストリームの区切りとして残り、検索で引ける）。Board が古いもので溢れないため。
3. **質問・回答・添付・コマンド・レビュー**: メッセージに付いたまま。
4. **Linear リンク** → そのスレッドから生まれたタスクへ。タスクが無ければ、リンクだけのタスクを Done で作る。
5. **Slack 対応** → タスクがあればタスクへ、無ければエージェントの Slack スレッドへ。
6. **fork** → タスクの「引き継ぎ元」イベント。
7. 既読: 旧 `marked_read_at` 以前のエージェントメッセージは `read_at` を埋める。

変わる・消える機能: スレッド一覧、スレッドの状態と section、スレッドの題、Tasks カンバン、Tasks ペイン、fork（→ 引き継ぎ）、スレッド単位のアーカイブ / スヌーズ / ピン（→ タスク単位）、「Group by session」（→ Agents そのもの）。
残るもの: 質問カード、アクション、添付・注釈・レビュー、`!` コマンド、メンション、図、ターミナル / shell / ファイル、リモートホスト、デバイス、Linear / Slack 連携（鍵がタスクに変わる）。

---

## 9. リスクとトレードオフ（A）

- **ストリームの長さ**: 何日も続くと長くなる。セッションの再起動・日付で区切り線を入れ、検索と「タスクで開く」を主な行き先にする。古い部分は仮想スクロール。
- **タグが付かない**: 層 2・3 と system prompt で大半は付く見込み。それでも「未分類の質問」は必ず NEEDS YOU に出るので、取りこぼしは「タスク画面に出ない」で済む。タグ付け率を観測できるようにする（ログ、設定画面に表示）。
- **既読が 2 つの面にまたがる**: メッセージ単位の既読にして 1 本化。どちらの面で読んでも同じ。
- **エージェントが 1 ストリームで複数タスクを混ぜる**: むしろ自然に表現できるようになる（タグ 2 つ）。人の画面での切り出しはタスク画面が担う。
- **作業量**: スレッド前提の UI（一覧、ヘッダ、メニュー、e2e）の作り直しは大きい。内部のストリーム用スレッドで配信まわりを守り、UI から段階的に入れ替える。

---

## 10. 段階的な移行

1. **Phase 1: タスクを主役に（スレッドはまだ見える）**
   - 既存の topic と `message_ids` で Board をホームに。タスク画面 = タグ付きメッセージの切り出し（今はスレッドをまたいで）。NEEDS YOU は質問カード。
   - 人のタグ編集（チップ）。ここで「切り出し」の使い心地を確かめる。
2. **Phase 2: ストリーム表示**
   - セッションごとに全スレッドを時刻順に混ぜた**表示**を足す（Agents 一覧 → ストリーム）。データはまだスレッドのまま。旧スレッドの境目は区切り線。
   - メッセージ単位の既読。
3. **Phase 3: 書き込みの切り替え**
   - ストリーム用スレッドを導入し、新しいメッセージはそこへ。`send_message` は `thread_id` 不要・`task_ids`、自動タグの層 2〜4、3 エージェントのインテグレーションを同時に更新。
   - Slack / Linear / fork をタスク基準へ。スレッド一覧を退役。
4. **Phase 4: 磨き込み**
   - タグ提案（任意）、PR/CI、全プロジェクト横断の「minbox」コンシェルジュ（決定次第）、スマホの仕上げ、旧データの移行（区切りとタスク化）。

Phase 1〜2 は戻せる。Phase 3 が後戻りしにくい分岐点。

---

## 11. 決めてほしいこと

1. **全体の方向**
   - (a) A: ストリーム + タグ付きタスク。NEEDS YOU は質問カード（**推奨**）
   - (b) B: 項目の受信箱（タスク/Board なし）
   - (c) C: タスク = 入れ物（前回案）
2. **「minbox」の相手**
   - (a) プロジェクトのメインセッションを各プロジェクトの「最初の相手」にする（**推奨**: 今の仕組みのまま）
   - (b) 全プロジェクト横断のコンシェルジュを 1 つ置き、依頼をタスクにして各セッションに振らせる
   - (c) 両方
3. **タグの自動化の範囲**
   - (a) 規則だけ（明示 → ターンの文脈 → 唯一のタスク → 返信の継承）+ 人の手（**推奨**: 予測可能。以前の補助モデル抽出をやめた経緯とも合う）
   - (b) (a) + 補助モデルの提案（破線のチップ、確定は人）
   - (c) 補助モデルが自動で付ける
4. **タスクの無いスレッドの移行**
   - (a) 未完了のものだけタスク化し、完了済みはストリームの区切りとして残す（**推奨**）
   - (b) すべてタスク化する（Done として）
   - (c) タスク化しない（topic だけ移す）
5. **タスク画面からの返信の宛先**
   - (a) 直近に活動したエージェント。返信欄で切替可（**推奨**）
   - (b) 毎回選ばせる
   - (c) タスクの「主担当」を 1 人決め、常にそこへ

---

## 12. Goals (v3 addition)

### What Claude Code's `/goal` is
`/goal <condition>` (docs: code.claude.com/docs/en/goal) sets one standing condition per session. It is
a session-scoped, prompt-based Stop hook: after every turn a small fast model reads the condition and
the conversation and answers *not yet met* (its reason steers the next turn, which starts by itself),
*met* or *impossible* (both clear the goal). Only the condition text is stored; limits are written into
the condition ("or stop after 20 turns"). `/goal` shows it, `/goal clear` clears it, `--resume` restores
it. There is no hook event, setting or API to read or set a running session's goal from outside; it can
only be typed (or sent as a prompt).

### Options weighed
| | Goal above tasks (chosen) | Goal = a property of a task | Goal per agent session |
| --- | --- | --- | --- |
| What it answers | "what outcome is all this for, and is it reached?" | "keep this one task going" | "what is this agent for" |
| Several tasks / agents toward one outcome | ◎ tasks serve the goal (parent) | × one task | × one agent |
| Board | goals group their tasks, progress = criteria + tasks | same as tasks | per agent, not per work |
| Autonomous run | owned by one agent, continues it | same | same |
| Agent burden | `create_task {kind: "goal", criteria}` | a flag | a second title |

**Chosen: a goal is a task of kind `goal` that sits above tasks.** It has the outcome (title, summary),
**done when** criteria (a checklist), the tasks that serve it (`parent_id`), an owner agent (its assigned
session), and an optional **autonomous run**. A task may exist without a goal. It is the same object as a
task (one table, one tag system, one view), so a goal's messages, timeline and reply box work like a
task's; the Board shows goals first as the grouping of their tasks.

### The autonomous run (emulated for every agent)
minbox runs it itself rather than mapping to Claude Code's native `/goal`: the native state cannot be
read or controlled from outside, Pi and OpenCode have no equivalent, and the person must be able to
start / pause / stop it from the Board or the goal's view. While a run is **on**, whenever its agent is
idle with nothing queued, minbox sends the agent a continuation message (tagged with the goal) that
restates the goal, the unmet criteria and the rules. The run **waits** (does not continue) while a
question tagged with the goal or its tasks is open (it needs the person), and **stops** when every
criterion is met or the agent sets the goal done (*met*), when the turn budget (default 20) or the time
limit (default 4 h) runs out, or when the person stops it. "Met" is the agent's own judgement through
`update_task` (no helper model, as decided for tagging).

### Contract
- `create_task {kind: "goal", title, summary?, criteria?: [{text}], autonomous?: bool}`. The agent
  decides, as for tasks (§4.5): a message that asks for an outcome to keep pursuing ("keep going until CI
  is green") becomes a goal; `autonomous: true` only when the person asked to keep going on its own.
- `create_task {goal_id}` / `update_task {goal_id}`: the task serves that goal.
- `update_task {task_id: <goal>, check_criteria: [n], criteria?, status?}`; all criteria checked or
  `status: done` ends the goal (and its run).
- The person: Start / Pause / Stop on the goal (Board row and goal view), and edits the criteria.

---

## 13. Decisions taken, and what v3 implements

1. Direction **A** (streams + tagged tasks), NEEDS YOU as question cards.
2. "minbox" = the project's **main session** (the composer's default recipient).
3. Tagging = **rules + agent + person** (no helper-model suggestions): the agent's `task_ids` /
   `create_task` in the turn (also tagging the person's untagged messages of the turn), tags inherited
   by the reply from the person's task-view messages and by answers from their questions, and the
   person's chips, `#` picker, "wrong task?" / "tag it?". The server never guesses (layer 3 is not
   used).
4. Migration: unfinished threads without topics become tasks; finished ones stay as segments.
5. A reply from a task goes to the **most recently active agent** on it, switchable (a new agent on
   the task is a hand-off: the task's state rides along with the message).

Implemented: §2 model, §3 layers 1, 2, 4, 6, §4 read state / task replies / delivery with tasks,
§4.5, §5 (one stream thread per session; older threads untouched as segments), §6.1 screens, §6.2
search (as a screen, `/`), §6.4 keys (J/K, Space, Enter, 1–9, X, R, ⇧N, /, ?, g b, g a, T, Ctrl+`),
§6.5 phone, §7 contract (all three integrations), §8.1–3, 4 (Linear links copied to the task), 7,
§12 goals. Not yet: §8.5 Slack and Linear comment routing by task (they still follow the stream
thread), §6.3 notifications per task (they still follow the session), task snooze / pin, tag
suggestions (decided against), the cross-project concierge.

### 改訂 (2026-11-18): 実データでの見直し
実データ（157 スレッド、35 topic）で移行した v3 は「使い物にならない」「タスクが妙に多い」と評価された。直したこと:
1. **「タグ」の廃止**。メッセージは 1 つ以上のタスクに属す（について）だけ。UI の語彙は Board / task / agent / message / question。メッセージの下は「in: <タスク>」のリンク、操作は `⋯` の「Move to task… / Also about…」（「Not about a task」は 7. で無くなった）。返信の下の判断の注記は、エージェントがタスクを作ったときと人が移したときだけ出す（「no task」の注記は出さない）。データは `message_tags` → `message_tasks`、API は `/messages/{id}/tasks`・`/messages/{id}/move`（旧 retag）、V3Message の `tags` → `tasks`。エージェントの `task_ids` / `message_ids` はそのまま。
2. **タスクを増やしすぎない**。タスク = 人が頼んだ 1 つのまとまった仕事。ツール説明と system prompt で「開いているタスクを使い回す、細部はステップに、確認・小さな質問はそれが関わるタスクに」と伝える（どのタスクにも合わない雑談だけは小さな done のタスク: 7.）。`create_task` は似た題の開いたタスクがあると `similar_tasks` と `note` を返す。
3. **移行の訂正 `v3_migrated_2`**（冪等）: 最初の移行が作ったタスクのうち、その後誰も触っていないもの — 7 日以上動きの無いスレッドから作ったもの、done / finished の topic から作ったもの — を消す（threads / topics の表と、ストリーム・検索のメッセージは残る）。残すスレッドのタスクは題をスレッドの名前・件名の 1 行目（80 字まで）にし、そのスレッドの全メッセージをそのタスクに属させ、「Task created (from the earlier inbox)」のイベントを消す。人やエージェントが作ったタスク、最初の移行の後に変わったタスク（人の付け替え、イベント、後のメッセージ）には触らない。
4. **Board**: NEEDS YOU（質問カード。タスクの質問はそのカード 1 枚だけ、長い選択肢はリスト、自由記述はその場で回答）、GOALS、WORKING（直近 3 日に動きのあるもの。行の右はエージェントの状態・PR/リンク・経過）、IDLE（折り畳み: 3 日以上静かな開いたタスク）、BLOCKED（ある時だけ）、DONE（折り畳み、直近 48 時間）。
5. **旧 `send_message` の引数**: `thread_title` は無視（ストリームの題を書き換えない）。旧スレッドの `thread_id` は、そのスレッドから移行したタスクがあればそのタスクに属させ、メッセージ自体はストリームへ。
6. **添付**: ストリーム・タスク画面の返信欄と New message で、貼り付け・ドロップ・添付ボタン（スマホは写真/カメラ）。
7. **タスクに属さないメッセージは無い**（人の決定: "There must be no message that isn't linked to a task"）。人・エージェント・回答・コマンドとその出力・添付だけのメッセージ・ゴールの継続、すべてのメッセージが 1 つ以上のタスクに属す。
   - **置くのはエージェント**。ターンの判断は「既存のタスク（send_message task_ids）か新しい仕事（create_task）」の 2 つだけで、「タスク無し」は無い。どのタスクにも合わない雑談・小さな質問は、短い題の小さなタスクを作り、答えたら done にする（create_task status done）: Board の開いたリストには出ない。system prompt・ツール説明・wake の文言でそう伝える。task_ids の無い send_message の応答には `note`（このメッセージとそのターンの人のメッセージがまだタスクに無いこと、置き方）が付く。
   - **minbox はタスクを選ばない**（実行時の自動割り当ては一切しない）。ターンの終わり（エージェントが working → idle）にセッションにタスクの無いメッセージが残っていれば、minbox はエージェントに「これらをタスクに置いて」と頼む（`kind: "place"` のメッセージ。人のメッセージと同じく pending で届くので、古い mod でも plugin turn になる）。本文はサーバが書く: 置かれていないメッセージの id と抜粋、エージェントの開いたタスク、update_task message_ids / create_task message_ids の使い方。ターンのたびに、残っている限り頼む（回数の上限は無い）。同じメッセージについて続けて頼むときは間隔を空ける（30 秒から倍々、最大 10 分。`MINBOX_PLACE_WAIT_S`）。エージェントがターン中、届いていない人のメッセージがある、エージェントの質問が人の答えを待っている間は頼まない。止まった・消えたセッションのメッセージはそのまま（次に idle になったときに頼む）。この頼みのメッセージ自体は、頼んだメッセージがすべてタスクに置かれた時点でそのタスクに属す（Board の件数には数えない）。
   - **まだ届いていない人のメッセージ**、エージェントがまだ置いていないメッセージは「仮」: メッセージの下に「waiting for <agent> to place it in a task」と出る。
   - エージェント返信を update_task / create_task の message_ids でタスクに置くと、その返信が答えた人のメッセージ（turn_of）のうちタスクの無いものも一緒に置かれる。
   - **人は外せない**: `⋯` は「Move to another task… / Also about another task…」だけ。最後の 1 つのタスクから外す `DELETE /api/v3/messages/{id}/tasks/{task}` は 409（移すのは可。移動は先に新しいタスクに置いてから外す）。「Take out of this task」は 2 つ以上のタスクに属すときだけ。
   - **移行 `v3_migrated_3`**（冪等、1 トランザクション、何も消さない）: タスクの無いメッセージをすべて置く。旧スレッドのメッセージはそのスレッドのタスク（そこから作ったタスク、無ければメッセージの多くが属すタスク）へ。無ければスレッドごとに done のタスクを作る（題はスレッドの名前・件名の 1 行目、80 字まで。done はスレッドの最終更新時刻なので、Board の DONE には最近のものしか出ない）。ストリームのメッセージはターンで（返信 → それが答えた人のメッセージのタスク、人のメッセージ → それに答えた返信のタスク、回答 → 答えた質問のタスク）、残りは同じセッションで時刻が最も近い、タスクのあるメッセージのタスクへ。タスクが 1 つも無いセッションはストリームごとに done のタスクを 1 つ（題は最初の人のメッセージ）。
   - 当初の案（エージェントが決めないときにサーバが割り当てる・自動で閉じる）は採らなかった。実行時にタスクを作るのはエージェントと人だけなので、「自動で作ったタスクを閉じる」規則も無い（雑談のタスクはエージェントが done で作る）。
8. **メッセージはちょうど 1 つのタスクに属す（N:1）**（人の決定、2026-11-18）。きっかけ: コーディネーターが create_task で B を作ったターンで send_message task_ids=[A] と返信したら、ターンの文脈の継承で返信が A と B の両方に付いた。「Also about…」も「Take out of this task」も無くなり、操作は `⋯` の「Move to another task…」だけ。
   - **データ**: `message_tasks` はメッセージごとに 1 行まで（`message_tasks_one`: message_id の一意インデックス）。移す（`LinkMessages`）は元の行を消してから入れる。規則による置き方（`PlaceMessages`: 継承・回答・place の頼み）はタスクの無いメッセージにしか効かない。
   - **ターンの規則**: 返信が明示したタスク（send_message `task_id`）が勝つ。明示が無いときだけターンの文脈から継承し、それも 1 つに決まるときだけ: このターンで作ったタスクがちょうど 1 つならそれ、作っていなければ人のメッセージ（ターンの）のタスクが 1 つならそれ。決まらなければ置かない（ターン後に place の頼み）。タスクの無い人のメッセージは返信のタスクへ。ターン最初の create_task は、そのターンのタスクの無い人のメッセージを仮にそのタスクへ置く（返信を待たずに Board に出るように）。返信が別のタスクを明示したら、まだそこにあるそれらを返信のタスクへ移す。create_task / update_task の `message_ids` はそのメッセージを移す。
   - **契約**: send_message は `task_id`（文字列）。`task_ids` は旧名として受け付ける（要素 1 つ。2 つ以上は 400 で「1 つ選べ、別のタスクには別のメッセージを」という文）。wake の行は `Task: <id> "<title>"`（1 つ）。ツール説明・system prompt もそう言う。tools_version はマニフェストのハッシュなので変わり、動いている thin mod は登録し直す。protocol 0 の古い mod も同じエンドポイントで動く（task_ids 1 つ）。
   - **API**: `PUT /api/v3/messages/{id}/task {task_id}` が移動（`POST …/tasks` は同じものの旧名）。`DELETE …/tasks/{task}` はそのメッセージのタスクなら常に 409。`/move` は返信と、返信と同じタスク（かタスク無し）にあった turn_of の人のメッセージを移す。
   - **移行 `v3_one_task`**（冪等、1 トランザクション、余分な行以外は何も消さない）: 複数のタスクに属すメッセージは 1 つだけ残す。規則: (1) エージェントが send_message で明示したタスク（agent の行で、そのメッセージのターンが始まる前からあったタスク。旧サーバはターン中に作ったタスクも agent の行で付けたが、それらはターン中に作られている）、(2) 人の行（person）、(3) その他の agent の行（ターン中に作ったタスク）、(4) auto。同じ順位ならタスクの作成が新しいもの（より具体的）、リンクが新しいもの、task id の大きいもの（決定的にするだけ）。落とした行は `message_tasks_dropped`（message_id, task_id, source, created_at, kept_task_id, dropped_at）に記録する。

# minbox

Claude Code のセッションを、ターミナルと Inbox を並べて扱う Web アプリです。何を作るかは [WHAT.md](WHAT.md) にあります。

```
┌──────────┬──────────────────────────┬───────────────┐
│ Sessions │ Terminal (Claude Code)   │ Inbox         │
└──────────┴──────────────────────────┴───────────────┘
```

## 使い方

```sh
make build                     # web/dist をビルドし、bin/minbox に埋め込む
./bin/minbox start             # バックグラウンドで起動し、http://127.0.0.1:4848 を開く
./bin/minbox status            # 動いているか、URL、ログの場所(止まっていれば終了コード 3)
./bin/minbox stop              # サーバーを止める(セッションは terminal host で動き続ける)
./bin/minbox restart           # 止めて、前回の start と同じフラグで起動し直す
./bin/minbox start --foreground  # フォアグラウンドで動かす(ログは標準エラー)
```

`start` はサーバーをデーモンとして起動し、応答するのを待ってから戻ります。ログは `<data-dir>/minbox.log` に追記されます。

左の **+ New** でディレクトリを選ぶと、そのディレクトリで `claude` が起動します。Claude が質問や作業報告を送ると右の Inbox に届き、返信すると Claude が手の空いたときに新しいメッセージとして受け取ります。

| フラグ | 既定値 | 内容 |
| --- | --- | --- |
| `--addr` | `127.0.0.1:4848` | 待ち受けるアドレス(ループバックのみ) |
| `--data-dir` | `~/.minbox`(`MINBOX_DATA_DIR`) | データベース、mod、貼り付けた画像の置き場所 |
| `--claude` | `claude`(`MINBOX_CLAUDE`) | Claude Code を起動するコマンド。例: `"claude --model sonnet"` |
| `--no-open` | | ブラウザを開かない |
| `--foreground` | | デーモンにせず、フォアグラウンドで動かす |

画面:

- **左**: セッション一覧。人を待っている順(Stopped on you → Holding up work → Waiting on you → Sent → New → Quiet → Archived)に並びます。`⌘B` で畳んでレールにできます。
- **中央**: ターミナル。添付ファイルを開くと、ここに表示して注釈を付けられます(注釈は返信と一緒に届きます)。
- **右**: Inbox。スレッドの一覧と、質問カード・アクション項目・添付つきのスレッドです。
- **ほかの画面**: 検索(`⌘K` か `/`)、Guided review(全画面)、Settings、Board(Settings → Capabilities でオン)、Decision mode(同じく。待っている質問を 1 問ずつ番号キーで答える)。
- **スマホ(幅 768px 未満)**: 「セッション一覧 → セッション(Inbox / Terminal タブ)」の順にたどります。ターミナルは PTY のサイズを変えずに表示し、補助キーと画像アップロードがあります。

キーボード操作(`?` で一覧を表示):

- `⌘K` / `/`: 検索。`?`: ショートカット一覧。`⌘B`: サイドバーを畳む。`Esc`: 閉じる・一覧に戻る
- `↑` `↓` / `J` `K`: 移動。`↵`: 開く。`N`: 最初の新着。`Q`: 開いている質問へ
- `R`: 返信欄に移る。`⌘↵`: 送信。`E`: Mark read。`⇧E`: アーカイブ。`Z`: 直前の操作を取り消す
- `]` / `[`: 次 / 前の添付。`O`: 最新の添付。`F`: 添付を全画面
- `⌘V`: ターミナルにフォーカスがあり、クリップボードに画像が入っているとき、その画像をアップロードしてパスを入力する

ターミナルにフォーカスがあるときは `⌘K` 以外のショートカットは効きません。1 文字のショートカットは Settings で切れます。

## 仕組み

- **サーバー** `minbox start`(Go)は、Web アプリの配信、ブラウザ向け API と SSE、ターミナルの WebSocket 中継、mod 向け API を受け持ちます。データは SQLite3(`modernc.org/sqlite`)に保存します。
- **terminal host** `minbox host start` は PTY を持つ別プロセスです。サーバーが起動時に、なければ立ち上げます。`minbox host stop` で止められます(動いていた `claude` は終了し、次に `minbox` を起動すると開いていたセッションが `--resume` で再開します)。サーバーを再起動(アップデート)しても、動いているセッションは終了しません。接続時にお互いのプロトコルバージョンを確かめ、どちらかが相手の required version に満たないときは host を再起動します(`internal/termhost`)。
- **自動レジューム**: host がいない状態で起動すると(OS の再起動後など)、開いていたセッションを `claude --resume <id>` で再開します。人が止めたセッションや Claude が自分で終了したセッションは再開しません。
- **Claude Code mod**(`plugin/minbox`)はバイナリに埋め込まれ、`claude --plugin-dir` で読み込まれます。mod は次のことをします。
  - `send_message` と `read_thread` の 2 つのツールを登録する
  - 人の返信をロングポーリングで受け取る
  - Claude が idle になってから claim → `$.prompt.submit` → delivered の順で、1 回だけ配信する
  - 質問は `:::question` / `:::question-multi` / `:::question-text` ブロックで書く。回答は "## Answers to your questions" として Claude に届く

## 開発

```sh
make test-go        # Go のユニットテスト
make test-mod       # mod のテスト (claude plugin test)
make test-e2e       # Playwright (偽の claude を使う。モデルは呼ばない)
cd web && MINBOX_REAL_CLAUDE=1 npx playwright test real-claude   # 本物の Claude Code (Haiku) で確認
```

フロントエンドを開発するときは、Go サーバーを 4848 番で起動し、`cd web && npm run dev` を実行します(Vite が `/api` を 4848 番に中継します)。

# kumodana（雲棚）

Cloudflare 上に置く、自分専用の「共有用の棚」。画像、1 枚完結の HTML、Markdown 文書を置き、推測できないリンクで人に見せる・渡す。
原本は手元に残し、棚には共有用のコピーだけを置く。

- 既定は非公開。共有はリンク単位で、取り消すと配信側のキャッシュも消える
- 画像の位置情報や、SVG の作者名・手元のパスなどのメタデータは、置く前に自動で取り除く（`--keep-exif` で残せる）
- 共有した HTML と SVG は隔離（CSP sandbox）して表示する
- Markdown 文書とテキストは、CLI が 1 枚完結の HTML に変換して置く（生の HTML とスクリプトは通さない）
- 保存量は 8GB まで（超えると理由付きで拒否）。Workers は無料プランで運用する
- 整理はタグだけ（複数タグでの絞り込みと、件数付きのタグ一覧）

方針は [憲法](.specify/memory/constitution.md)、仕様と設計は [specs/001-share-shelf-mvp](specs/001-share-shelf-mvp/)、
[specs/002-markdown-share](specs/002-markdown-share/)、[specs/003-cli-login](specs/003-cli-login/) にある。

## 構成

| パス | 内容 |
|---|---|
| `apps/admin` | 管理用 Worker `kumodana-admin`（Hono。Cloudflare Access と JWT 検証で保護） |
| `apps/files` | 配信用 Worker `kumo`（Workers Cache の後ろで、リンクからファイルを返す） |
| `apps/cli` | kumo CLI（Node.js。ビルドせず型除去で実行） |
| `packages/shared` | 型、上限値、ID とタグの規則 |
| `docs/runbook.md` | 初期設定、デプロイ、Access、予算アラート、緊急停止 |

## 開発

```sh
npm ci
npm run typecheck
npm test
```

Node.js 22.18 以上が必要。依存は公開から 7 日以上経った版に固定している（`.npmrc`）。

## 使い方（kumo CLI）

Cloudflare 側の初期設定は [docs/runbook.md](docs/runbook.md) を参照。CLI は、入れたらブラウザでログインするだけで使える
（runbook §7）。

```sh
npm install -g ./apps/cli                # kumo コマンドを登録
kumo login https://kumodana-admin.<subdomain>.workers.dev   # ブラウザで所有者としてログイン（2 回目からは URL を省略できる）
kumo login --status                      # 使われる資格情報とログインの状態（通信しない）
kumo logout                              # この PC の許可を取り消し、保存したトークンを消す
```

ログインは Access の許可の期間のあいだ続き、アクセストークンは自動で更新される。期限が切れたら、案内に従って `kumo login` し直す。
ブラウザのない環境や、Managed OAuth が使えないときは、CLI 用サービストークンを環境変数に一時的に設定して使える。シークレットは
どこにも保存せず、使うたびに再発行する（runbook §3・§7）。

```sh
kumo put photo.jpg --tag 旅行 --link     # 置いてリンクを発行
kumo put note.md --link                  # Markdown 文書を HTML に変換して置く（note.md.html）
kumo put app.log --as text               # Markdown として解釈せず、そのままの形で見せる
kumo preview note.md                     # 置く前にブラウザで確かめる（管理 API は使わない）
kumo ls --tag 旅行 --tag 2026            # すべてのタグを持つファイルを一覧
kumo tags                                # タグと件数
kumo tag <id> +家族 -draft               # タグを付ける・外す
kumo link create <id> --label "Aさん"    # リンクを追加で発行
kumo link ls <id> --all                  # リンクの一覧（取り消し済みも）
kumo link revoke <url>                   # 取り消し
kumo get <id>                            # 手元に保存
kumo rm <id>                             # 削除（リンクもすべて使えなくなる）
kumo usage                               # 使用量
```

`--json` を付けると結果を JSON で出力する。検証手順は
[quickstart.md](specs/001-share-shelf-mvp/quickstart.md)、[002 の quickstart.md](specs/002-markdown-share/quickstart.md)、
[003 の quickstart.md](specs/003-cli-login/quickstart.md) を参照。

## Markdown 文書

- 形式は拡張子ではなく中身で判定する。画像・SVG・HTML のどれでもない UTF-8 のテキストは、Markdown 文書として
  HTML に変換して置く。棚に置く名前は元の名前に `.html` を足したもの（`note.md` → `note.md.html`）
- 対応する記法は CommonMark と、表・タスクリスト・取り消し線・ URL の自動リンク。生の HTML は文字として表示する
- UTF-8 で保存する。Windows PowerShell 5.1 の `>` や `Out-File` は UTF-16 で書くので、拒否される
- 単独の改行は改行にならない（CommonMark どおり）。改行するには行末に空白を 2 つ置くか `\` を置く。
  行ごとに見せたいテキストは `--as text` を使う
- 画像は外部の `https:` のものだけが表示される。相対パスの画像は表示されない
- 判定した形式と警告（拡張子との食い違い、生の HTML、表示されない画像など）は、置くたびに表示される。
  秘密鍵を含むテキストは置けないが、それ以外の秘密を含むテキストは置けてしまうので、置くファイルに注意する

検討の経緯は [docs/markdown-support.md](docs/markdown-support.md) にある。

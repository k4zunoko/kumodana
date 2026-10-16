# kumodana（雲棚）

Cloudflare 上に置く、自分専用の「共有用の棚」。画像と 1 枚完結の HTML を置き、推測できないリンクで人に見せる・渡す。
原本は手元に残し、棚には共有用のコピーだけを置く。

- 既定は非公開。共有はリンク単位で、取り消すと配信側のキャッシュも消える
- 画像の位置情報などのメタデータは、置く前に自動で取り除く
- 共有した HTML と SVG は隔離（CSP sandbox）して表示する
- 保存量は 8GB まで（超えると理由付きで拒否）。Workers は無料プランで運用する
- 整理はタグだけ（複数タグでの絞り込みと、件数付きのタグ一覧）

方針は [憲法](.specify/memory/constitution.md)、仕様と設計は [specs/001-share-shelf-mvp](specs/001-share-shelf-mvp/) にある。

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

初期設定は [docs/runbook.md](docs/runbook.md) を参照。

```sh
kumo put photo.jpg --tag 旅行 --link     # 置いてリンクを発行
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
[quickstart.md](specs/001-share-shelf-mvp/quickstart.md) を参照。

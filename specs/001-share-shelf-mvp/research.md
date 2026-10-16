# Research: 共有棚 MVP

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Date**: 2026-10-15

技術選定の多くは、仕様作成前の調査（2026-10-15 時点の公式ドキュメントと、この PC での試作）で決めた。
ここではその結論と、計画で新たに決めた点をまとめる。

## R1. デプロイとリソース操作のツール

- **Decision**: `cf`（Cloudflare CLI、オープンベータ）を使う。版は完全に固定する（調査時点で npm の
  `min-release-age=7` を満たす最新は `1.0.0-beta.13`）。`cf` にないライブログは `npx wrangler tail` で補う。
- **Rationale**: Wrangler の後継として 2026-09-28 に公開され、Wrangler はベータ終了後 18 か月で保守終了になる。
  Cloudflare API のほぼ全体（Access、通知など）を同じ CLI で扱える。設定は型付きの `cloudflare.config.ts`。
- **Alternatives considered**: Wrangler（保守終了が決まっている）、Terraform（1 人の MVP には過剰）。
- **確認済み**: この PC（Windows、Node 22.23、社内プロキシ経由）で、`cf` beta.13 と Vite 8、
  `@cloudflare/vite-plugin` 2.0 beta、TypeScript 7 の組み合わせでビルドできた。

## R2. Worker の構成（2 つに分ける）

- **Decision**: 管理用 Worker `kumodana-admin` と配信用 Worker `kumo` に分ける。配信用だけ Workers Cache を
  有効にする。取り消し時のキャッシュ削除は、管理用から配信用の RPC メソッド `purge(tags)` を呼んで行う。
- **Rationale**:
  - Workers Cache は Worker の手前にあり、ヒット時は Worker が動かず CPU 時間もかからない。
  - キャッシュの削除は、キャッシュを持つ Worker（のエントリポイント）の中からしかできない。
  - キャッシュのキーにはホスト名が含まれないため、1 つの Worker で両方を扱うと、入口役の Worker を毎回
    動かす必要があり、閲覧 1 回がリクエスト 2 回分に数えられる。
  - 配信用 Worker に書き込みの処理を持たせない（憲法 III）。
- **Alternatives considered**: 1 つの Worker ＋入口用エントリポイント（リクエストが 2 倍になる）、
  Cache API（`caches.default`、全地域で削除できず、同時アクセスがまとめられない）。

## R3. 公開先と認証（workers.dev と Access）

- **Decision**:
  - 両 Worker とも `workersDev: true`、`previewUrls: false`。URL は
    `https://kumodana-admin.meshnode.workers.dev` と `https://kumo.meshnode.workers.dev`。
  - 管理用 Worker には **Worker 単位の Access アプリケーション**（destination type `worker`）をかけ、
    ポリシーは「所有者のメールアドレスを許可」と「CLI 用サービストークン（Service Auth）」の 2 つ。
  - Worker は `Cf-Access-Jwt-Assertion` を `jose` で検証する（RS256、`iss` はチームドメイン、`aud` は
    アプリの AUD）。主体は `email` が所有者、または `common_name` が CLI のクライアント ID のときだけ許可する。
- **Rationale**: Worker 単位の Access は、workers.dev とプレビュー URL をまとめて保護できる（2025-10 以降）。
  `ctx.access.getIdentity()` は人のログイン向けで、サービストークンの識別には JWT の `common_name` を使う。
- **Alternatives considered**: ホスト名単位の Access アプリ（Worker 単位の方が漏れがない）、`ctx.access` だけで
  判定（サービストークンを識別できず、ローカルでのテストも難しい）。
- **注意**: Public Suffix List には `workers.dev` が登録されているため、`meshnode.workers.dev` 全体が 1 つの
  サイトになる。管理用と配信用は同一サイトで、SameSite Cookie による防御は効かない（R6 で対処）。

## R4. 個人を特定できる設定値の扱い

- **Decision**: 所有者のメールアドレス、CLI のクライアント ID、Access のチームドメインと AUD は、
  `bindings.secret()` として宣言し、`cf deploy --secrets-file <gitignore 済みファイル>` で毎回渡す。
- **Rationale**: いずれも厳密には秘密ではないが、リポジトリが公開される可能性を考え、個人の識別子を
  コミットしない。`cf` は単一のシークレット設定に未対応だが、`--secrets-file` で版ごとに渡せる。
- **Alternatives considered**: `bindings.text()` で設定ファイルに直書き（リポジトリに残る）、
  `npx wrangler secret put`（`cf` の外で状態が変わり、再現性が下がる）。

## R5. 配信時のヘッダーとキャッシュ

- **Decision**: 配信用 Worker のすべての応答に次を付ける。
  - `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`
    （`allow-same-origin` なし。画像にも付けるので、形式の判定ミスがあっても安全側に倒れる）
  - `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex, nofollow, noarchive`
- 200 応答だけ、`Cache-Control: public, max-age=60`（ブラウザ）、
  `Cloudflare-CDN-Cache-Control: public, max-age=3600, stale-if-error=0`（エッジ）、
  `Cache-Tag: l:<token>,f:<fileId>` を付ける。それ以外（404、301、405）は `Cache-Control: no-store`。
- **Rationale**: ブラウザ側の保持を 60 秒に抑え、取り消しが 1 分以内に効くようにする（FR-019）。エッジでは
  取り消し・削除時にタグで消すが、削除に失敗しても最長 1 時間で切れるように保持を 1 時間にする
  （FR-019、FR-028 の最悪値）。階層型キャッシュなので、1 時間ごとの取り直しはリンクあたりごく少数で済む。
  `stale-if-error=0` は、Worker のエラー時に Cloudflare が期限切れの内容を返し続ける既定の動作を止め、
  取り消し済みの内容が見え続ける経路を忽ぐ。Workers Cache はクエリ文字列もキーに含めるため、クエリ付きの
  要求は内容を返さず正規の URL へ 301 で転送する（FR-022、憲法 V）。
- **Alternatives considered**: クエリ付きの要求を拒否（SNS などが付ける追跡用パラメータでリンクが壊れる）、
  エッジで 24 時間保持（削除に失敗すると取り消しが最大 24 時間効かない）。

## R6. 管理 API の CSRF 対策

- **Decision**: すべての `/api/*` に独自ヘッダー `X-Kumodana-Client: cli` を必須にする。`Origin` ヘッダーがある
  要求と、`Sec-Fetch-Site` が `same-origin`・`none` 以外の要求を拒否する。
- **Rationale**: 独自ヘッダー付きの他オリジンからの要求はブラウザの事前確認（preflight）が必要になり、管理用 Worker は
  CORS を許可しないため、ブラウザからは送れない。Node.js の fetch は `Origin` も `Sec-Fetch-Site` も送らない。

## R7. 保存量の上限と整合性

- **Decision**:
  - 上限は `STORAGE_LIMIT_BYTES`（本番 8000000000）で設定する。テストでは小さい値にする。
  - アップロード時に、処理中と削除中を含む全ファイルのサイズの合計を条件にした
    `INSERT ... SELECT ... WHERE` を 1 文で実行し、`meta.changes = 0` なら上限超過とする。
  - `files.sha256` に部分一意インデックス（`WHERE status != 'deleting'`）を付け、同じ内容の同時アップロードを
    制約違反で検出する。削除中のものと同じ内容は置き直せる。
  - R2 への保存時に `sha256` を渡し、R2 側で内容を検証させる。
  - 状態は `pending`・`ready`・`deleting` の 3 つ。R2 の実体を消すのは `pending` か `deleting` のときだけにし、
    「`ready` なら R2 に実体がある」を常に保つ（憲法 III）。削除は先に `deleting` にして一覧と配信から外し、
    キャッシュを消してから R2 と行を消す。キャッシュの削除に失敗しても R2 と行は消す（エッジのキャッシュは
    R2 の実体と関係なく最長 1 時間で切れるため）。
  - 15 分ごとの定期実行で、更新から 30 分を超えた `pending`（最長 45 分で解放）と、15 分を超えた `deleting`
    （処理が途中で止まった削除）を片付ける。
  - 通信の中断で残った `pending` は、同じ内容の置き直しがあれば、更新から 10 分を過ぎた時点で置き換える。
    100MB を上り 2Mbps で送ると約 7 分かかるため、10 分未満は正常な処理中とみなす。
- **Rationale**: 合計を別の列に持たないので、記録上の使用量と実際がずれない。D1 は書き込みを直列に処理するので、
  1 文の判定は同時実行でも上限を超えない。ファイル数 1 万件でも、読み取り行数は D1 の無料枠に十分収まる。
- **Alternatives considered**: 使用量カウンター列（ずれる可能性がある）、R2 の使用量 API で判定（反映が遅い）。

## R8. Workers の CPU 制限と処理の配置

- **Decision**: EXIF の削除、SHA-256 の計算、形式の判定は CLI で行う。アップロードは multipart ではなく本体を
  そのまま `PUT` し、Worker は R2 へ流し込むだけにする。CLI はファイルをメモリに読み込んで送る（100MB 未満なので
  `Content-Length` が確定する）。
- **Rationale**: 無料プランの Worker は 1 回 10ms の CPU 制限がある。R2 へのストリーミングは CPU をほとんど
  使わない。R2 の `put` は長さの分かるストリームを必要とする。

## R9. EXIF の削除

- **Decision**: CLI で一時コピーを作り、`exiftool-vendored` の `deleteAllTags` を、向き（Orientation）と
  カラープロファイル（ICC_Profile）を残す指定で実行する。`--keep-exif` 指定時は何もしない。
- **Rationale**: exiftool はメタデータを可逆に（再圧縮せず）削除でき、Windows 用の実行ファイルが同梱される。
  向きの情報まで消すと画像が横倒しで表示される。
- **Alternatives considered**: `sharp` で再エンコード（画質が変わる）、自前の JPEG セグメント処理（形式ごとの
  実装が必要）。
- **実装時の確認事項**: `retain` 指定で Orientation と ICC_Profile が残ることを、テスト用の画像で確認する。

## R10. ファイル形式の判定

- **Decision**: 依存を増やさず、CLI に小さな判定関数を持つ。
  - 画像はマジックバイトで判定する: JPEG（`FF D8 FF`）、PNG（`89 50 4E 47 0D 0A 1A 0A`）、GIF（`GIF87a`/`GIF89a`）、
    WebP（`RIFF....WEBP`）、AVIF（`ftyp` のブランドが `avif`/`avis`）。HEIC（`ftyp` の `heic`/`heix`/`mif1` など）は、
    専用のメッセージで拒否する。
  - テキストは UTF-8 の BOM と空白、XML 宣言、コメントを読み飛ばし、`<svg` で始まれば SVG、`<!doctype html` か
    `<html` で始まれば HTML とする。
  - HTML の `Content-Type` は、`<meta charset>` があれば `text/html`、なければ UTF-8 として妥当な場合に
    `text/html; charset=utf-8` とする。
- **Rationale**: 対象の形式が少なく、判定は数十行で書ける（憲法 VII）。配信側はすべての応答に sandbox を
  付けるため、判定を誤っても危険にならない。
- **Alternatives considered**: `file-type`（HTML と SVG を判定できない）。

## R11. ID とトークン

- **Decision**:
  - ファイルの ID は 10 文字の Crockford Base32（小文字、50 ビット）。衝突時は作り直す。
  - リンクのトークンは 16 バイトの乱数を Base64URL にした 22 文字（128 ビット）。
  - どちらも `crypto.getRandomValues` で作る。
- **Rationale**: ID は CLI で入力しやすい長さにし、一意性は主キーで保証する。トークンは推測できない長さが必要（FR-014）。

## R12. タグ（整理の唯一の手段）

- **Decision**:
  - 整理はタグだけで行い、アルバムは作らない（憲法 v2.0.0）。
  - タグは NFC 正規化と前後の空白除去のうえ小文字化して保存する。1〜64 文字で、制御文字とカンマは使えない。
  - 一覧は 0〜10 個のタグで絞り込め、複数指定は AND（すべてのタグを持つファイル）とする。SQL は
    `file_tags` を指定タグで絞り、`GROUP BY file_id HAVING COUNT(DISTINCT tag) = <指定数>` で求める。
  - タグの一覧（件数付き）を `GET /api/tags` と `kumo tags` で提供し、表記ゆれを防ぐ。
- **Rationale**: アルバムの機能（まとめて絞り込む、1 つのファイルを複数のまとまりに入れる）はタグで
  賄える。並び順を使うギャラリーは作らない。概念が 1 つになり、CLI の操作、API、テーブルが減る（憲法 VII）。
  複数タグの AND は、アルバムではできない絞り込みも可能にする。
- **Alternatives considered**: アルバムを残す（概念と実装が増える、並び順の使い道がない）、タグの OR 検索
  （絞り込みという目的に合わない）、タグ単位での公開（後からタグを付けたファイルが意図せず公開される）。

## R13. CLI と API の型の共有

- **Decision**: `packages/shared` に API の型、エラーコード、上限値、ID とタグの検証関数を置き、管理用 Worker と
  CLI の両方から使う。CLI は通常の `fetch` で API を呼ぶ。
- **Rationale**: Hono の RPC クライアント（`hc`）は CLI を管理用 Worker の実装に結び付ける。共有する型だけで
  十分であり、依存を減らせる。

## R14. テスト

- **Decision**:
  - Worker は Vitest と `@cloudflare/vitest-plugin`（`experimental.newConfig: true` で `cloudflare.config.ts` を
    読む）で、workerd 上でローカルの D1 と R2 を使ってテストする。
  - JWT の検証は鍵の取得部分を差し替え可能にし、テストでは生成した鍵で署名した JWT を使う。
  - 配信用 Worker の RPC は、管理用 Worker のテストでは差し替え可能な薄いモジュールを通して呼ぶ。
  - CLI は Node.js 上の Vitest でテストし、API はローカルの HTTP サーバーで代用する。
- **確認済み**: この PC で、`@cloudflare/vitest-plugin` の `newConfig` と D1・R2 を使うテストが通った。
  ローカルでは `ctx.cache` が `undefined` になるため、`purge` はその場合に失敗を返すようにする。
- **Alternatives considered**: `@cloudflare/vitest-pool-workers`（後継の vitest-plugin に置き換わった）。

## R15. 緊急停止と予算アラート

- **Decision**:
  - 緊急停止は、配信用 Worker の `cloudflare.config.ts` に停止用のモード（`workersDev: false` を返す）を用意し、
    `cf workers triggers deploy --mode stopped` で workers.dev の公開を止める。予備の手段はダッシュボードでの
    workers.dev の無効化。
  - 予算アラートは、ダッシュボードの Budget alerts で $1 に設定し、R2 の使用量通知（Usage Based Billing）も
    追加する。
- **Rationale**: どちらも Cloudflare の API・ダッシュボードで完結し、Workers の 1 日の上限に達していても実行できる。
  `cf cli search` では workers.dev を単独で切り替えるコマンドが見つからず、予算アラートの API も見つからなかった。
- **実装時の確認事項**: `cf workers triggers deploy --mode stopped` で workers.dev の公開が止まることを確認する。

## R16. CLI の実行方法

- **Decision**: CLI はビルドせず、Node.js 22.18 以上の型除去（type stripping）で TypeScript を直接実行する。
  `apps/cli/bin/kumo.js` から `../src/main.ts` を読み込み、`npm install -g ./apps/cli` でコマンドを登録する。
  型除去で扱えない構文（`enum`、`namespace`、コンストラクター引数のプロパティなど）は使わず、
  `tsconfig` で `erasableSyntaxOnly` を有効にする。
- **Rationale**: 自分の PC だけで使うため配布用のビルドは不要で、依存とビルド手順を減らせる（憲法 VII）。
- **Alternatives considered**: tsdown などでのバンドル（ビルド手順が増える）。
- **実装時の確認事項**: Node.js は `node_modules` 配下の `.ts` を型除去しない。グローバル登録したコマンドと、
  ワークスペースの `@kumodana/shared` の読み込みが、実体のパス（`node_modules` の外）で解決されて動くことを
  Windows で確認する。

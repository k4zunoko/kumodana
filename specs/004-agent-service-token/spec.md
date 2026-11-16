# Feature Specification: ブラウザのない環境の常駐エージェントが、専用のサービストークンで管理 API を使う

**Feature Branch**: `004-agent-service-token`

**Created**: 2026-11-16

**Status**: Draft

**Input**: Issue #16 の所有者の決定（2026-11-16）: "ブラウザのない環境に常駐する所有者の個人エージェント（Muse / Jolly）が kumodana を常用できるように、
エージェント専用の Cloudflare Access サービストークンを発行し、管理用 Worker がその client_id も受け付けるようにする。kumo CLI は変えない"

**関連**: Issue #16（[決定のコメント](https://github.com/k4zunoko/kumodana/issues/16#issuecomment-6910052481)）、#10（CLI 用サービストークンを退路として残す）、
[003 の spec](../003-cli-login/spec.md)（`kumo login`）、[docs/runbook.md](../../docs/runbook.md) §3・§4・§6・§7・§10、憲法 v2.1.0。
この仕様は、001 の [contracts/admin-api.md](../001-share-shelf-mvp/contracts/admin-api.md) の「認証（2 段）」の 2 段目で受け付ける主体に、
エージェント用のサービストークンを加える。001 の FR-031（所有者が発行した資格情報だけを受け付け、入口と処理の本体の 2 か所で確かめる）の範囲に収まる。
003 の仕様（`kumo login` / `kumo logout`）と、退路用の CLI 用サービストークンの扱い（#10）は変えない。003 の FR-022（管理用 Worker での
資格情報の確かめ方を変えない）は 003 の範囲の制約である。この仕様は、JWT の検証と所有者の判定は変えず、受け付ける client_id を 1 つ足すだけである。

## 背景

- 所有者の個人エージェント Muse（Jolly）は、ブラウザのない Linux の VM に常駐している。成果物の HTML や文書を棚に置き、リンクで共有することを
  主な用途として、kumodana を常用する（`put`・`ls`・`link`・`rm` を含む）。
- 今の kumodana には、ブラウザのない環境で**継続して**使える正規の経路がない（Issue #16 の背景）。
  - `kumo login`（003）は、CLI を動かす PC のブラウザでログインし、その PC の `127.0.0.1` で結果を受け取る前提である。
  - CLI 用サービストークン `kumodana-cli` は、#10 の決定で退路になった。使うたびに `rotate` で再発行し、シークレットはどこにも保存しない。
    常駐する用途には合わない。
- 所有者の条件: 再ログインが週 1 回要る方式は採らない。Managed OAuth の許可の期間（`grant.session_duration`）は 1 週間で、起点（ログイン時から
  数えるか、更新で延びるか）も確かめられていないため、この条件を保証できない。
- 2026-10-22 の判断（(a) 今のサービストークンを VPS に置く、(b) エージェント専用の権限を絞ったトークンを作る、のどちらも採らない）は、
  2026-11-16 の決定で覆した。用途が具体的になり、所有者本人のエージェントであるため、専用のトークンを作る手間を受け入れる。

## 用語

- **エージェント**: ブラウザのない環境（Linux の VM）に常駐し、非対話で動く、所有者の個人エージェント Muse（Jolly）。
- **ヘルパー**: エージェントが管理 API を直接呼ぶための小さなプログラム。このリポジトリの外にあり、この仕様では作らない。
- **エージェント用サービストークン**: エージェント専用に新しく発行する Access のサービストークン（名前の例: `kumodana-jolly`）。
  クライアント ID（`client_id`）とシークレット（`client_secret`）の組。
- **退路用サービストークン**: 既存の CLI 用サービストークン `kumodana-cli`（#10）。この仕様では変えない。
- **Muse の資格情報ストア**: Muse が、登録した接続ごとに資格情報を保管する場所（登録済み接続）。この仕様では、ここに `client_secret` だけを置く。

## Clarifications

### Session 2026-11-16（Issue #16 の決定）

- Q: どの方式を採るか → A: エージェント専用のサービストークンを新しく発行する。退路用 `kumodana-cli` は、流用も `rotate` の共有もしない。
  Access アプリ `kumodana-admin` に、このトークンの Service Auth ポリシーを足す
- Q: 権限を絞るか → A: 絞らない。管理用 Worker の `cli` の主体と同じ権限にする。用途が `put`・`ls`・`link`・`rm` を含む常用であり、
  所有者本人のエージェントであるため
- Q: シークレットをどこに置くか → A: Muse の資格情報ストア（登録済み接続）に `client_secret` だけを置く。`client_id` は識別子として
  ヘルパーが付与する。エージェント側の平文ファイル、チャット、リポジトリには置かない。runbook §3 の「シークレットは保存しない」は、
  退路用 `kumodana-cli` については変えず、このトークンは保管先を明記した例外とする
- Q: kumo CLI を変えるか → A: 変えない。エージェントは CLI ではなく、管理 API を直接呼ぶヘルパーから使う
- Q: 期限と取り消しをどうするか → A: 期限は 1 年。期限の前に `refresh` で延ばす（シークレットは変わらない）。`rotate` したときは、
  Muse 側の登録を入れ直す。取り消しは、このトークンを消すか、ポリシーから外す。所有者の PC のログインと退路用トークンには影響しない
- Q: 管理用 Worker は 2 件目の client_id をどう受けるか → A: 追加の任意のシークレット `AGENT_CLIENT_ID` で受ける。`CLI_CLIENT_ID` と同じく
  `cli` の主体として受け付ける。空のときは、今までどおり `CLI_CLIENT_ID` だけを受け付ける

## 採る方式

エージェント用サービストークンを、入口（Access）と処理の本体（管理用 Worker）の両方に登録する。手順の詳細は runbook にある。

1. 所有者が、エージェント用サービストークン（`kumodana-jolly`、期間 `8760h`）を発行する（runbook §3）。
2. Access アプリ `kumodana-admin` に、このトークンだけを含む Service Auth ポリシーを足す（runbook §6）。これで入口を通れるようになる。
3. 管理用 Worker のシークレット `AGENT_CLIENT_ID` に、このトークンの `client_id` を入れて再デプロイする（runbook §4・§5）。
   管理用 Worker は、Access の JWT に `email` がなく、`common_name` が `CLI_CLIENT_ID` か `AGENT_CLIENT_ID` のどちらかに一致するとき、
   `cli` の主体として受け付ける。2 つの権限は同じである。
4. `client_secret` を Muse の資格情報ストアに登録する（runbook §7「常駐エージェントで使う」）。
5. ヘルパーは、管理 API への要求のたびに、`CF-Access-Client-Id`・`CF-Access-Client-Secret`・`X-Kumodana-Client: cli` を付けて送る。

## 資格情報の置き場と、延長・入れ直し・取り消し

| 値 | 置き場 | 置かない場所 |
|---|---|---|
| `client_secret` | Muse の資格情報ストア（登録済み接続）だけ | エージェント側の平文ファイル、チャット、リポジトリ、所有者の PC のファイル |
| `client_id` | ヘルパーの設定（識別子として要求に付与する）と、所有者の PC の `.secrets.production.json` の `AGENT_CLIENT_ID`（コミットしない） | リポジトリ |

- 退路用 `kumodana-cli` のシークレットは、今までどおりどこにも保存しない（#10）。保管してよいのは、エージェント用サービストークンの
  `client_secret` を、Muse の資格情報ストアに置く場合だけである。
- **延長**: 期限（発行から 1 年）の前に `npx cf zero-trust access service-tokens refresh <service_token_id>` で 1 年延ばす。
  シークレットは変わらないので、Muse 側の登録はそのままでよい。
- **入れ直し**: シークレットが漏れたかもしれないときは、`npx cf zero-trust access service-tokens rotate <service_token_id>` で再発行し、
  出力の `client_secret` を Muse の資格情報ストアに登録し直す。前のシークレットはすぐ使えなくなり、登録し直すまでエージェントは止まる。
  `client_id` は変わらないので、管理用 Worker の再デプロイは要らない。退路用 `kumodana-cli` には影響しない。
- **取り消し**: エージェントを止めるとき、VM や資格情報ストアが漏れたかもしれないときは、次のどちらかを行う。
  - このトークンを消す: `npx cf zero-trust access service-tokens delete <service_token_id>`
  - Access アプリ `kumodana-admin` から、このトークンのポリシー（`kumodana-jolly`）を外す
  - どちらも、このトークンだけが対象で、所有者の PC のログイン（`kumo login`）と退路用 `kumodana-cli` には影響しない。
    Strict service token authentication（runbook §6）が有効なとき、Access は Cookie（`CF_Authorization`）を返さず、要求のたびにヘッダーで
    確かめる（[Cloudflare の文書](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)）。
    このため、次の要求から入口で拒否される見込みである。実地の確認は、下の「受け入れ条件」で行う
  - 後片付け: Muse の資格情報ストアの登録を消す。作り直さないなら、`AGENT_CLIENT_ID` を空（`""`）にして再デプロイし、処理の本体でも
    受け付けないようにする
- **作り直し**（消して新しく発行した場合）: `client_id` が変わるので、`AGENT_CLIENT_ID` を更新して再デプロイし、ポリシーも新しいトークンに向ける。

## 採らない方式と理由

- **`kumo login`（Managed OAuth）**: ループバック（`127.0.0.1`）での受け取りが前提で、VM に合わない。許可の期間は 1 週間で、週ごとの
  再ログインの可能性を排除できない。
- **デバイスコード（RFC 8628）**: Access の Managed OAuth が対応していない。2026-10-22 に、Managed OAuth の公式文書
  （https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ ）には認可コードフローだけが
  書かれていること、本番の管理用 Worker の `/.well-known/oauth-authorization-server` の `grant_types_supported` が
  `["authorization_code","refresh_token"]` で、`device_authorization_endpoint` がないことを確かめた（Issue #16 の根拠）。
- **SSH のポート転送、転送先の URL の手渡し**: 許可の期間ごとに、人の手作業が残る。
- **既存のサービストークン（`kumodana-cli`）の流用**: 退路と共有になる。所有者が退路として `rotate` するとエージェントが止まり、
  逆も起きる。
- **権限を絞ったエージェント用トークン**: 用途が `put`・`ls`・`link`・`rm` を含む常用であり、所有者本人のエージェントであるため、絞らない。

## 憲法との関係

- **III（書き込み経路は管理 API だけ）**: エージェントも管理 API だけを通す。R2 と D1 に直接は書き込まない。
- **IV（多層防御）**: 入口（Access のポリシー）と処理の本体（管理用 Worker の JWT の検証）の 2 か所で確かめる仕組みは変えない。
  「許可するのは所有者のメールアドレスと CLI 用のサービストークンだけ」は、管理用 Worker が `cli` の主体として受け付ける、所有者が発行した
  サービストークンと読み、エージェント用サービストークンもこれに含める。シークレットとクライアント ID は、リポジトリに含めない。
- **IV（EXIF の削除）と VII（Markdown 文書は kumo CLI で HTML に変換して置く）**: ヘルパーから置くものにも及ぶ（FR-011）。
- **VII（操作は CLI だけ）**: このリポジトリに、新しい操作の手段（Web UI など）は加えない。ヘルパーはエージェント側のもので、
  既存の管理 API を呼ぶだけである。
- IV の「CLI 用のサービストークン」と VII の「操作は CLI だけ」は、kumo CLI だけを指すとも読める。この仕様は上のように読み、憲法は改正しない。
  文言を明確にする改正（PATCH）が要るかは、所有者が判断する。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - エージェントが成果物を置いて、リンクで共有する (Priority: P1)

エージェントは、ヘルパーで管理 API を呼び、成果物の HTML を棚に置いてリンクを発行する。ブラウザでのログインは要らず、
トークンの期限（1 年）までは、週ごとのログインし直しもない。

**Why this priority**: ブラウザのない環境で、人の操作なしに使い続けられることが、この仕様の目的そのものである。

**Independent Test**: ブラウザのない Linux で、ヘルパーから HTML を置いてリンクを発行し、リンクの URL が 200 を返すことを確かめる。

**Acceptance Scenarios**:

1. **Given** エージェント用サービストークンを発行し、ポリシーと `AGENT_CLIENT_ID` を設定済み, **When** ヘルパーが
   `CF-Access-Client-Id`・`CF-Access-Client-Secret`・`X-Kumodana-Client: cli` を付けて `GET /api/usage` を呼ぶ, **Then** 200 で使用量が返る
2. **Given** 1 と同じ, **When** ヘルパーが HTML を置いてリンクを発行する, **Then** リンクの URL が 200 を返す
3. **Given** 1 と同じ, **When** ヘルパーが一覧、リンクの取り消し、削除を行う, **Then** 所有者の CLI と同じように成功する
4. **Given** ポリシーはあるが `AGENT_CLIENT_ID` が空, **When** ヘルパーが同じ要求を送る, **Then** 入口は通るが、管理用 Worker が
   `403 forbidden` を返す

---

### User Story 2 - トークンを延長し、入れ直す (Priority: P2)

所有者は、期限の前に `refresh` で延ばす。シークレットは変わらず、エージェントは止まらない。漏れたかもしれないときは `rotate` し、
Muse の登録を入れ直す。

**Why this priority**: 期限（1 年）を越えて使い続けるために要る。入れ直しは、漏れたときの備えである。

**Independent Test**: `refresh` の後も Muse の登録を変えずに `GET /api/usage` が成功すること、`rotate` の後は前のシークレットが入口で
拒否され、登録し直すとまた成功することを確かめる。

**Acceptance Scenarios**:

1. **Given** 期限が近い, **When** 所有者が `refresh` する, **Then** 期限が 1 年延び、エージェントは登録を変えずに使い続けられる
2. **Given** シークレットが漏れたかもしれない, **When** 所有者が `rotate` する, **Then** 前のシークレットでの要求は入口で拒否され、
   新しいシークレットを Muse に登録し直すと、また成功する。管理用 Worker の再デプロイは要らない
3. **Given** エージェントが使っている, **When** 所有者が退路用 `kumodana-cli` を `rotate` する, **Then** エージェントは影響を受けない（逆も同じ）

---

### User Story 3 - エージェントだけを止める (Priority: P3)

所有者は、エージェント用サービストークンだけを取り消して、エージェントを止められる。所有者の PC のログインと退路用トークンは使い続けられる。

**Why this priority**: VM や資格情報ストアが漏れたときに、ほかの経路を巻き込まずに止める手段が要る。

**Independent Test**: トークンを消す（またはポリシーから外す）前後で、ヘルパーの `GET /api/usage` と、所有者の PC の `kumo usage` を比べる。

**Acceptance Scenarios**:

1. **Given** エージェントが使っている, **When** 所有者がこのトークンを消すか、ポリシーから外す, **Then** ヘルパーの要求は入口で拒否される
   （401 か 403）
2. **Given** 1 の後, **When** 所有者が自分の PC で `kumo usage` を実行する, **Then** ログイン（`kumo login`）で成功する。退路用 `kumodana-cli` の
   ポリシーと `CLI_CLIENT_ID` も変わらない

---

### Edge Cases

- **`AGENT_CLIENT_ID` が未設定か空**: `CLI_CLIENT_ID` だけを受け付ける（この機能の追加前と同じ）。
- **`AGENT_CLIENT_ID` に `CLI_CLIENT_ID` と同じ値を入れる**: 退路用トークンの流用になるので、行わない。
- **シークレットが違う、トークンの期限が切れた、取り消された**: 入口（Access）が 401 か 403 を返す。本文は、管理 API のエラーの JSON の形ではない。
- **ポリシーはあるが、`AGENT_CLIENT_ID` が違うか、再デプロイを忘れた**: 入口は通り、管理用 Worker が `403 forbidden`（JSON）を返す。
- **ヘルパーが `X-Kumodana-Client: cli` を付けない、`Origin` を付ける**: `403 cross_site_request`（001 の CSRF 対策。エージェントにも同じく効く）。
- **期限が近い**: runbook §8 の期限の通知（Expiring Service Token Alert）で気づき、`refresh` で延ばす。通知の対象にこのトークンが
  入っているかは、発行の後に確かめる（通知は、すべてのトークンか、特定のトークンを対象にできる）。
- **保存量の上限を超える**: 所有者の CLI と同じく、管理 API が使用量・上限・要求サイズの分かるエラーで拒否する（憲法 V。変えない）。

## Requirements *(mandatory)*

### Functional Requirements

**管理用 Worker**

- **FR-001**: 管理用 Worker は、Access の JWT に `email` がなく、`common_name` が `CLI_CLIENT_ID` か `AGENT_CLIENT_ID` に一致するとき、
  `cli` の主体として受け付けなければならない（MUST）。2 つの権限は同じとする。
- **FR-002**: `AGENT_CLIENT_ID` が未設定か空のときは、`CLI_CLIENT_ID` だけを受け付けなければならない（MUST）。未設定の値を、文字列
  （例: `"undefined"`）にして照合してはならない（MUST NOT）。
- **FR-003**: JWT の検証（署名、`iss`、`aud`、期限）、所有者のメールアドレスの判定、CSRF 対策は変えてはならない（MUST NOT）。
  入口と処理の本体の 2 か所で確かめる（001 の FR-031）。
- **FR-004**: FR-001 と FR-002 の判定には、自動テストを用意しなければならない（MUST。憲法 VI）。

**Access と資格情報**

- **FR-005**: エージェント用サービストークンは、退路用 `kumodana-cli` とは別に発行し、期間は 1 年（`8760h`）としなければならない（MUST）。
  退路用のトークンやシークレットを流用・共有してはならない（MUST NOT）。
- **FR-006**: Access アプリ `kumodana-admin` に、このトークンだけを含む Service Auth ポリシーを足さなければならない（MUST）。既存のポリシー
  （`owner`・`kumodana-cli`）と Managed OAuth の設定は変えてはならない（MUST NOT）。
- **FR-007**: `client_secret` は、Muse の資格情報ストア（登録済み接続）にだけ保管しなければならない（MUST）。エージェント側の平文ファイル、
  チャット、リポジトリに置いてはならない（MUST NOT）。`client_id` は、ヘルパーが識別子として付与する。`client_id` もリポジトリには書かない。
- **FR-008**: 退路用 `kumodana-cli` のシークレットを保存しない方針（#10、runbook §3）は変えてはならない（MUST NOT）。
- **FR-009**: 発行、ポリシーの追加、延長（`refresh`）、入れ直し（`rotate` と Muse の登録のし直し）、取り消し（トークンの削除か
  ポリシーからの除外）の手順を、runbook に書かなければならない（MUST）。取り消しは、このトークンだけを対象にでき、所有者のログインと
  退路用トークンに影響してはならない（MUST NOT）。

**ヘルパーに求めること**（ヘルパーはこのリポジトリの外にある。この仕様では作らない）

- **FR-010**: ヘルパーは、すべての `/api/*` の要求に `CF-Access-Client-Id`・`CF-Access-Client-Secret`・`X-Kumodana-Client: cli` を付け、
  `Origin` を付けてはならない（MUST。001 の contracts/admin-api.md）。`client_secret` を、出力、ログ、エラーに表示してはならない
  （MUST NOT。001 の FR-033 と同じ）。
- **FR-011**: ヘルパーから置くものにも、kumo CLI と同じ前処理の規則が及ばなければならない（MUST）。Markdown 文書とテキストは、kumo CLI で
  HTML に変換したもの（`kumo preview <file> -o <path>`。管理 API を使わない）を置く。画像と SVG は、メタデータ（位置情報など）を取り除いた
  ものだけを置く（憲法 IV）。取り除く手段がない間は、ヘルパーで画像と SVG を置かない。

**変えないもの**

- **FR-012**: kumo CLI（`apps/cli`）は変えてはならない（MUST NOT）。003 の `kumo login` と、CLI の資格情報の選び方も変わらない。

### Key Entities *(include if feature involves data)*

- **エージェント用サービストークン**: Access が持つ。名前（例: `kumodana-jolly`）、`client_id`、`client_secret`、期限（1 年）。
  退路用 `kumodana-cli` とは別のトークンで、取り消しと入れ直しも別に行う。
- **`AGENT_CLIENT_ID`**: 管理用 Worker のシークレット。エージェント用サービストークンの `client_id` を入れる。空なら使わない。
- **Service Auth ポリシー（`kumodana-jolly`）**: Access アプリ `kumodana-admin` のポリシー。このトークンだけを含む。
- **Muse の資格情報ストアの登録**: `client_secret` だけを持つ。`rotate` のたびに入れ直す。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: トークンの期限（1 年）のあいだ、エージェントの管理操作に、人のログインの操作は 1 回も要らない。
- **SC-002**: `AGENT_CLIENT_ID` が空のとき、エージェント用サービストークンでの管理操作の成功は 0 件で、`CLI_CLIENT_ID` と所有者のログインでの
  管理操作は、この機能の追加前と同じく 100% 成功する。
- **SC-003**: エージェント用サービストークンを取り消した後、そのトークンでの管理操作の成功は 0 件で、所有者の PC の `kumo usage` は成功する。
- **SC-004**: `client_secret` が、リポジトリ、エージェント側の平文ファイル、ヘルパーの出力に現れる件数は 0 件である。
- **SC-005**: `refresh` の後も、Muse 側の登録を変えずに管理操作が成功する。

## 受け入れ条件

この仕様を実装する PR で確かめるもの:

- [ ] 管理用 Worker のテストで、`AGENT_CLIENT_ID` の client_id が `cli` の主体として受け付けられること、`AGENT_CLIENT_ID` が空か未設定の
  ときは、その client_id とほかの知らない client_id が `403 forbidden` になり、`CLI_CLIENT_ID` は受け付けられ続けることを確かめる。
  - 確かめ方: リポジトリのルートで `npm run typecheck` と `npm test` を実行し、終了コードが 0 であることを確かめる（`apps/admin/test/auth.test.ts`）。
- [ ] runbook §3・§4・§6・§7・§10 と README の案内が、この仕様と食い違わない。
  - 確かめ方: `git grep -n "kumodana-jolly\|AGENT_CLIENT_ID\|常駐エージェント" README.md docs specs` で該当の箇所を読む。

所有者の作業（トークンの発行、ポリシーの追加、`AGENT_CLIENT_ID` の設定と再デプロイ、Muse への登録）と、ヘルパーの実装の後に確かめるもの:

- [ ] ブラウザのない Linux で、ヘルパーから HTML を置いてリンクを発行できる。
  - 確かめ方: リンクの URL に `curl -s -o /dev/null -w "%{http_code}"` すると `200` になる。記録は runbook §12 か Issue #16 に残す。
- [ ] 取り消し（トークンの削除か、ポリシーからの除外）の後、ヘルパーの要求が入口で拒否される。同じときに、所有者の PC の `kumo usage` は成功する。
  - 確かめ方: ヘルパーの `GET /api/usage` の HTTP ステータス（401 か 403）と、`kumo usage` の終了コード（0）を記録する。

## Assumptions

- 利用者は所有者 1 人である。エージェントは所有者本人のもので、所有者と同じ管理操作を任せてよい。
- エージェントの環境では当面、リポジトリから入れた kumo CLI と、管理 API のヘルパーを併用する（Issue #16 の決定）。
- Zero Trust の Strict service token authentication は有効である（runbook §6・§12）。
- Muse の資格情報ストアの仕組みと守り方は、Muse の側で決まる。この仕様では、保管先をそこに限ることだけを決める。
- 管理用 Worker の `AGENT_CLIENT_ID` は 1 つである。エージェント用サービストークンを 2 つ以上同時に使う形は考えない。
- Issue #16 の「許可の期間の起点の確認」は、ログインをエージェントの常用の経路にしないことにしたため、優先度を下げる。所有者の PC の
  `kumo login` には引き続き関係するので、runbook §11 の項目は残す。

## 対象外（今回は作らない・決めない）

- kumo CLI（`apps/cli`）の変更。
- ヘルパーの実装、Muse への資格情報の登録、接続の実地の確認（上の「受け入れ条件」の後半）。
- Cloudflare 上での作業（トークンの発行、Access のポリシーの変更、管理用 Worker のデプロイ）。所有者が行う。
- kumo CLI だけを VPS などに入れる手段（単体の配布物とその置き場、Linux での `exiftool-vendored` の Perl の要否）。Issue #16 の別のコメントの
  論点で、この仕様では決めず、未決のまま残す。
- 権限を絞ったトークン、ブラウザのない環境向けのログイン（デバイスコードなど）、憲法の改正。

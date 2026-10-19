# Implementation Plan: Markdown 文書を置いてリンクで共有する

**Branch**: `002-markdown-share` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-markdown-share/spec.md`

## Summary

kumo CLI が Markdown 文書を 1 枚で完結する HTML に変換し、既存の HTML と同じ経路で棚に置く。形式はファイルの中身で判定し、
画像・SVG・HTML のどれでもない UTF-8 のテキストを Markdown 文書とみなす。管理用 Worker、配信用 Worker、管理 API、D1、
`packages/shared` の許可形式は変えない。検討の経緯と比較は [docs/markdown-support.md](../../docs/markdown-support.md) にある。

技術的な要点（詳細は [research.md](./research.md)）:

- 変換は CLI で行う（憲法 V）。変換器は markdown-it 15.0.2 と `@mdit/plugin-tasklist` 1.1.3（GFM の表・取り消し線・自動リンクは内蔵）
- 生の HTML は無効（`html: false`）、リンクは `http`・`https`・`mailto` とスキームのない URL だけを許す
- 生成する HTML は、`<meta charset>` の直後に meta の CSP（`default-src 'none'; img-src https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`）を持つ。
  配信時の sandbox（既存）と合わせて二重に守る
- 判定は「画像 → 拒否する署名 → SVG・HTML（今と同じ）→ XML の拒否 → テキストの条件 → 秘密鍵の拒否 → Markdown」の順。テキストの条件はファイル全体で調べる
- `--as text`（等幅でそのまま見せる）と `--as markdown`（判定より優先）を加える。判定結果と警告を必ず表示する
- 棚に置く名前は元の名前の末尾に `.html` を足す。`kumo preview` で、置く前に同じ結果を確かめられる

## Technical Context

**Language/Version**: TypeScript 7.0（型検査）、Node.js 22.18 以上（CLI はビルドせず型除去で実行。001 の research R16）

**Primary Dependencies**: 既存の commander 15、exiftool-vendored 39 に加えて、markdown-it 15.0.2 と `@mdit/plugin-tasklist` 1.1.3
（`apps/cli` の `dependencies` に完全固定。`.npmrc` の `min-release-age=7` を満たす最新）

**Storage**: 変更なし（D1 と R2 は 001 のまま。棚に置く形式は画像と HTML のまま）

**Testing**: Vitest 5（Node.js 上、`apps/cli`）。管理 API はローカルの HTTP サーバーで代用する（`apps/cli/test/helpers.ts`）。
Worker のテストは変更しない

**Target Platform**: 所有者の Windows PC（CLI）。閲覧者は PC とスマートフォンの主要ブラウザ

**Project Type**: CLI ＋ 2 つの Web サービス（npm workspaces のモノレポ）。今回変えるのは CLI だけ

**Performance Goals**: 1MB の Markdown 文書の変換が 2 秒以内（SC-006）

**Constraints**:

- 管理 API、配信、D1 のスキーマ、`packages/shared/src/limits.ts` の許可形式を変えない（FR-007）
- 変換後の大きさも 100MB 未満（`MAX_FILE_BYTES`）
- 画像・SVG・HTML の判定結果を変えない（FR-004）。既存の判定のテストはそのまま通す
- 依存は公開から 7 日以上経った版に完全固定する（憲法の技術・運用上の制約）

**Scale/Scope**: 利用者 1 人。CLI のソースに 5 ファイル（`text.ts`、`markdown.ts`、`warnings.ts`、`prepare.ts`、`commands/preview.ts`）を加え、
`sniff.ts`、`commands/put.ts`、`commands/index.ts`、`main.ts` を変える

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

憲法 v2.1.0（2026-10-19 改正）に対して確認する。

| 原則 | この計画での対応 | 判定 |
|---|---|---|
| I. 原本は手元、棚には共有用のコピーだけ | 原本は読むだけ。棚に置くのは変換後の HTML（共有用のコピー）で、Markdown の原文は置かない | PASS |
| II. 既定は非公開、共有はリンクで行う | リンクの仕組みは変えない。変換後の HTML も通常のファイルとして扱う | PASS |
| III. 書き込み経路は管理 API だけ | 既存の `PUT /api/files` を使う。管理 API と Worker は変えない | PASS |
| IV. 多層防御 | 変換後の HTML に生の HTML を含めず（`html: false`）、スクリプトを禁止する meta の CSP を文書に持たせる（v2.1.0 で追加した MUST）。配信時の sandbox などのヘッダーは既存のまま効く | PASS |
| V. コストには上限を設ける | 変換は CLI で行い、Worker の CPU を使わない。保存量の判定は変わらない（変換後の大きさで判定される） | PASS |
| VI. 重要な経路は自動テストで守る | 認証、上限、リンク、配信ヘッダーの経路は変えない。判定・変換・安全性は CLI の単体テストで守る | PASS |
| VII. 小さく保つ | 対象に Markdown 文書を加える（v2.1.0）。棚に置く形式は画像と HTML のまま。依存の追加理由は research M2 に記録した | PASS |
| 技術・運用上の制約 | 形式は中身で判定し、画像・SVG・HTML でない UTF-8 のテキストを Markdown 文書とみなす。CLI の基準の技術選定に markdown-it を加えた（v2.1.0）。版は完全固定で `min-release-age` を守る | PASS |

**Phase 1 後の再確認**: data-model（保存データの変更なし）と contracts（`kumo put` の追加と `kumo preview`）を確認し、違反はない。

## Project Structure

### Documentation (this feature)

```text
specs/002-markdown-share/
├── plan.md              # この計画
├── research.md          # Phase 0: 技術上の決定
├── data-model.md        # Phase 1: 判定結果と変換結果（保存データの変更なし）
├── quickstart.md        # Phase 1: 検証手順
├── contracts/
│   └── cli.md           # kumo put の変更と kumo preview
├── checklists/
│   └── requirements.md  # 仕様の品質チェック
└── tasks.md             # Phase 2（/speckit.tasks で作成）
```

### Source Code (repository root)

```text
apps/cli/
├── package.json             # dependencies に markdown-it と @mdit/plugin-tasklist を追加
├── src/
│   ├── text.ts              # 新規: テキストの条件（BOM、UTF-16/32、UTF-8、制御文字、空白だけ）
│   ├── sniff.ts             # 変更: 判定の順序、kind に markdown と text、--as、XML・PDF・秘密鍵の拒否
│   ├── markdown.ts          # 新規: Markdown とテキストの HTML への変換、テンプレート、名前、警告
│   ├── warnings.ts          # 新規: 拡張子と判定の食い違い、JSON の警告
│   ├── prepare.ts           # 新規: 判定と変換をまとめる（put と preview が同じものを使う）
│   ├── main.ts              # 変更: 説明文
│   └── commands/
│       ├── put.ts           # 変更: --as、変換、名前、判定結果と警告の表示、集計
│       ├── preview.ts       # 新規: kumo preview
│       └── index.ts         # 変更: preview の登録
└── test/
    ├── text.test.ts         # 新規
    ├── sniff.test.ts        # 変更: 既存の判定はそのまま、hello world の期待だけ書き換え
    ├── markdown.test.ts     # 新規
    ├── warnings.test.ts     # 新規
    ├── put.test.ts          # 変更: Markdown とテキストの経路
    └── preview.test.ts      # 新規

docs/verification/markdown-check.md   # 新規: 手動確認用の文書（記法と攻撃パターン）
```

変更しないもの: `apps/admin/**`、`apps/files/**`、`apps/admin/migrations/**`、`packages/shared/**`。

**Structure Decision**: 001 の構成のまま、CLI（`apps/cli`）の中だけで完結させる。判定（`sniff.ts`・`text.ts`）、変換（`markdown.ts`）、
警告（`warnings.ts`）を分け、`prepare.ts` がそれらをまとめる。コマンド（`put.ts`・`preview.ts`）は `prepare` を呼ぶだけなので、
プレビューと置くものが必ず一致する（SC-005）。`sniff` はファイル名を受け取らず、
拡張子を判定に使わないことを型で保つ。

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

違反はない。

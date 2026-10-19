---

description: "Task list for 002-markdown-share"
---

# Tasks: Markdown 文書を置いてリンクで共有する

**Input**: Design documents from `/specs/002-markdown-share/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli.md, quickstart.md

**Tests**: 検討資料 §4.4 と憲法 VI に従い、判定・変換・安全性・コマンドの振る舞いのテストを書く。各ストーリーで、テストを
先に書いてから実装する。既存の判定のテスト（画像・HEIC・動画・zip・SVG・HTML）は変えずに通す。

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1〜US4)
- パスはリポジトリのルートからの相対パス（plan.md の Project Structure に従う）
- 変えないもの: `apps/admin/**`、`apps/files/**`、`apps/admin/migrations/**`、`packages/shared/**`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 依存の追加

- [X] T001 `npm install -w kumodana-cli --save-exact markdown-it@15.0.2 @mdit/plugin-tasklist@1.1.3` で `apps/cli/package.json` の `dependencies` に完全固定で加え、`package-lock.json` を更新する（`min-release-age=7` を守る。research M2）
- [X] T002 インストールした版と型（markdown-it 15 の同梱の型、`@mdit/plugin-tasklist` の `tasklist` の書き出し）を確かめ、`npm run typecheck -w kumodana-cli` が通ることを確認する

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: すべてのストーリーが使う、テキストの検査と形式の判定

- [X] T003 [P] テキストの条件のテストを `apps/cli/test/text.test.ts` に書く: 0 バイト、空白だけ、UTF-8 の BOM（取り除かれる）、UTF-16LE・UTF-16BE の BOM、UTF-32LE・UTF-32BE の BOM（UTF-16LE より先に判定）、BOM のない UTF-16（NUL で落ちる）、Shift_JIS の「あ」（`82 A0`）、4096 バイトより後ろにだけ不正なバイトがあるファイル、NUL、VT・ESC・DEL・U+0085 の拒否、タブ・LF・CR・FF・CRLF の受け入れ、私用領域と U+200B の受け入れ、理由と案内の文と `code`（`unsupported_type` / `unsupported_encoding`）
- [X] T004 `checkText(bytes)` を `apps/cli/src/text.ts` に実装する（research M5、data-model の TextCheck）
- [X] T005 `apps/cli/test/sniff.test.ts` を更新する: 既存のテストは変えずに残し、`hello world` の期待だけを Markdown に書き換え、拒否の例を NUL のバイト列で置き換える。判定の順序（PDF、UTF-16 の HTML、XML 宣言、`<!DOCTYPE plist>`、4096 バイトを超えるコメントの後の `<html>`、BOM や空白の後の `<!doctype html>`、HTML コメントで始まる Markdown、`<p align>` で始まる Markdown）、秘密鍵（`BEGIN PRIVATE KEY`・`BEGIN OPENSSH PRIVATE KEY`・`BEGIN PGP PRIVATE KEY BLOCK` は拒否、`BEGIN PUBLIC KEY` は通す、`--as text` でも拒否）、`--as text` と `--as markdown` が SVG・HTML・XML の判定より優先されること、画像に `--as` を付けると `not_text`
- [X] T006 `apps/cli/src/sniff.ts` を research M5 の順序に書き換える: `kind` に `markdown` と `text`、`sniff(bytes, { as })`、読み飛ばしを全体に広げる（`meta charset` の確認は先頭 4096 バイトのまま）、XML・PDF・秘密鍵の拒否、`ACCEPTED` の文に Markdown を加える。ファイル名は受け取らない
- [X] T007 新しい `Sniffed` の型に合わせて `apps/cli/src/commands/put.ts` を最小限直し、画像・SVG・HTML の経路が変わらないことを `apps/cli/test/put.test.ts` の既存のテストで確かめる

**Checkpoint**: 既存の CLI のテストがすべて通り、テキストが `markdown` と判定される

---

## Phase 3: User Story 1 - Markdown 文書を置いてリンクで共有する (Priority: P1) 🎯 MVP

**Goal**: `kumo put note.md --link` で、整形された HTML が `note.md.html` として置かれ、リンクで見られる

**Independent Test**: GFM の記法と攻撃パターンを含む文書を置き、送られた HTML の内容・名前・形式を確かめる

### Tests for User Story 1 ⚠️

- [X] T008 [P] [US1] `apps/cli/test/markdown.test.ts` に `renderMarkdown` のテストを書く: 見出し、強調、リスト、リンク、コード、表（列揃え）、タスクリスト（`disabled` のチェックボックス）、取り消し線、自動リンク（日本語の句読点で終わる URL）、生の HTML とコメントの文字表示、§3.5 の攻撃パターン（`<script>`、`onerror`、`javascript:`・`JAVASCRIPT:`・`jav&#x09;ascript:`、`data:text/html`、`<javascript:…>`、タイトルの引用符、コードフェンスの言語名、表のセル、`<meta http-equiv="refresh">`、`<base>`、`<style>`、`<iframe>`、`<svg onload>`）、meta の CSP が charset の直後にあること、題名（最初の h1、なければ元の名前、`<` と `&` のエスケープ）、決定性、BOM を除いた先頭の見出し、CRLF と LF で同じ出力、病的な入力と 1MB の文書が 2 秒以内、画像の警告（相対パス・`data:`・`http:` は表示されない、`https:` はホスト名）、生の HTML の行番号の警告、`sharedName`（`note.md` → `note.md.html`、拡張子なし、250 文字への切り詰め）
- [X] T009 [P] [US1] `apps/cli/test/put.test.ts` に Markdown の経路のテストを書く: `note.md` が `note.md.html`・`text/html; charset=utf-8`・変換後の SHA-256 で送られ、出力に `Markdown → HTML` とリンクが出る。`--json` の `kind: "markdown"` と `warnings`。同じ内容の 2 回目は重複。原本の内容と更新日時が変わらない（FR-017）

### Implementation for User Story 1

- [X] T010 [US1] `apps/cli/src/markdown.ts` に `renderMarkdown(text, { fallbackTitle })`、テンプレート（research M4）、CSS、`sharedName(name)`、生の HTML と画像の警告を実装する（research M3・M4・M7・M8）
- [X] T011 [US1] `apps/cli/src/commands/put.ts` で Markdown を変換して送る: 名前は `sharedName`、`Content-Type: text/html; charset=utf-8`、変換後が 100MB 以上なら `file_too_large`、結果に `kind` と `warnings`、人向けの出力に形式を出す（contracts/cli.md）
- [X] T012 [P] [US1] 手動確認用の文書 `docs/verification/markdown-check.md` を作る（GFM のすべての記法と、§3.5 の攻撃パターン、外部・相対・`data:` の画像）

**Checkpoint**: Markdown 文書を置くと、整形された HTML が正しい名前で送られる

---

## Phase 4: User Story 2 - 置く前に見え方を確かめる (Priority: P2)

**Goal**: `kumo preview` で、置かれるものと同じ HTML を手元で確かめられる

**Independent Test**: プレビューの出力と、`kumo put` で送られたバイト列が一致する

### Tests for User Story 2 ⚠️

- [X] T013 [P] [US2] `apps/cli/test/preview.test.ts` を書く: 設定なしで動き管理 API を呼ばない、`--output` に書いて開かない、既存のファイルを上書きせず `file_exists`（終了コード 2）、`--no-open` では一時ファイルに書くだけ、それ以外は開く関数が呼ばれる、画像・HTML は判定結果だけでファイルを書かない、`--json` の出力、出力が `kumo put` で送られるバイト列と一致する

### Implementation for User Story 2

- [X] T014 [US2] `apps/cli/src/commands/preview.ts` に `kumo preview <path> [--output] [--no-open]` を実装する（research M9。開く関数は差し替え可能にする）
- [X] T015 [US2] `apps/cli/src/commands/index.ts` に `registerPreview` を加える

**Checkpoint**: プレビューと置く処理が同じ変換を使う

---

## Phase 5: User Story 3 - Markdown 以外のテキストを、そのままの形で見せる (Priority: P3)

**Goal**: `--as text` で等幅のまま、`--as markdown` で判定より Markdown を優先して置ける

**Independent Test**: `app.log --as text` が `app.log.html` として、行と空白を保った `<pre>` で送られる

### Tests for User Story 3 ⚠️

- [X] T016 [P] [US3] `apps/cli/test/markdown.test.ts` に `renderText` のテストを書く: `&`・`<`・`>`・`"`・`</pre>` のエスケープ、空白・タブ・改行の保持、改行で始まる本文が失われない、meta の CSP、題名が元の名前
- [X] T017 [P] [US3] `apps/cli/test/put.test.ts` に `--as` のテストを書く: `app.log --as text` → `app.log.html` と `テキスト → HTML`、`page.html --as text` → `page.html.html`、`<svg>` で始まる文書を `--as markdown`、画像に `--as` で `not_text`、不正な値で終了コード 2

### Implementation for User Story 3

- [X] T018 [US3] `apps/cli/src/markdown.ts` に `renderText(text, { title })` を実装する（research M6）
- [X] T019 [US3] `apps/cli/src/commands/put.ts` と `apps/cli/src/commands/preview.ts` に `--as <markdown|text>` を加え、値を検証する（不正なら `invalid_argument`、終了コード 2）

**Checkpoint**: テキストをそのままの形で共有でき、誤判定を `--as` で回避できる

---

## Phase 6: User Story 4 - 判定の結果と問題に気づける (Priority: P4)

**Goal**: 判定した形式、拡張子との食い違い、JSON、拒否の理由が分かり、複数ファイルでは集計が出る

**Independent Test**: `memo.txt`、`data.json`、`.html` なのに先頭が `<div>` のファイル、UTF-16 の文書、秘密鍵を含むテキストを置き、表示・警告・拒否を確かめる

### Tests for User Story 4 ⚠️

- [X] T020 [P] [US4] `apps/cli/test/warnings.test.ts` を書く: 拡張子と判定の組み合わせ（`.md` なのに HTML・SVG、`.html` なのに Markdown、`.txt`・`.csv`・`.json`・`.log`・`.py` なのに Markdown、`.png` なのにテキスト）は警告、`.md` で Markdown・拡張子なし・一覧にない拡張子・`--as` 指定は警告しない、JSON として読める入力への警告、警告が判定を変えないこと
- [X] T021 [P] [US4] `apps/cli/test/put.test.ts` に、警告の表示（`警告: <path>: …`）、`--json` の `warnings`、2 つ以上のファイルでの集計（人向けと `summary`）、UTF-16 と秘密鍵を含むファイルは送られずに残りは続行して終了コード 1、のテストを書く

### Implementation for User Story 4

- [X] T022 [US4] `apps/cli/src/warnings.ts` に拡張子と判定の食い違いと JSON の警告を実装する（research M8）
- [X] T023 [US4] `apps/cli/src/commands/put.ts` と `apps/cli/src/commands/preview.ts` に警告と集計をつなぐ（人向けは標準エラー出力、`--json` は `warnings` と `summary`）

**Checkpoint**: すべてのストーリーが独立に動く

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T024 [P] `apps/cli/src/main.ts` と `kumo put` の説明文に Markdown を加える
- [X] T025 [P] `README.md` を更新する（冒頭の説明、`kumo put note.md --link`、`--as text`、`kumo preview`、UTF-8 で保存すること、改行の扱い）
- [X] T026 [P] `docs/runbook.md` に markdown-it とプラグインの更新手順を加える（research M11）
- [X] T027 [P] `specs/001-share-shelf-mvp/spec.md`（FR-002、Edge Cases）、`specs/001-share-shelf-mvp/research.md`（R10）、`specs/001-share-shelf-mvp/contracts/cli.md`（`kumo put` の手順 2）に、002 で置き換えたことを注記する
- [X] T028 `npm run typecheck` と `npm test` を実行し、すべて成功することを確かめる
- [X] T029 `git diff --stat main -- apps/admin apps/files packages/shared` が空であることを確かめる（Worker、管理 API、D1、許可形式を変えていない）
- [X] T030 ローカルでできる quickstart の確認を行う: `kumo preview docs/verification/markdown-check.md --output <一時の場所>` の出力を確かめる（管理 API を使わない部分）
- [ ] T031 （所有者が実施）本番での quickstart（§2 の US1・US3・US4、PC とスマートフォンでの表示）は所有者が PR の確認時に行う

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 依存なし
- **Foundational (Phase 2)**: Setup の後。すべてのストーリーの前提（判定が `markdown` と `text` を返すこと）
- **User Stories (Phase 3〜6)**: Foundational の後。US2〜US4 は US1 の `markdown.ts` と `put.ts` の変更を使う
- **Polish (Phase 7)**: すべてのストーリーの後

### User Story Dependencies

- **US1 (P1)**: Foundational の後。ほかのストーリーに依存しない
- **US2 (P2)**: US1 の `renderMarkdown` と `sharedName` を使う
- **US3 (P3)**: US1 の `put.ts` の変換の経路に `--as` を足す。`preview.ts`（US2）にも足す
- **US4 (P4)**: US1〜US3 の出力に警告と集計を足す

### Within Each User Story

- テストを先に書き、失敗を確かめてから実装する
- `markdown.ts`・`warnings.ts` などの部品 → `put.ts`・`preview.ts` のコマンドの順

### Parallel Opportunities

- T003 と T005 はファイルが違うので並行できる（T004・T006 は順に）
- T008 と T009、T016 と T017、T020 と T021 はそれぞれ並行できる
- Polish の T024〜T027 は並行できる

---

## Parallel Example: User Story 1

```bash
# テストを並行して書く
Task: "renderMarkdown のテストを apps/cli/test/markdown.test.ts に書く"
Task: "Markdown の経路のテストを apps/cli/test/put.test.ts に書く"

# 部品を作ってからコマンドにつなぐ
Task: "renderMarkdown と sharedName を apps/cli/src/markdown.ts に実装する"
Task: "apps/cli/src/commands/put.ts で Markdown を変換して送る"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1（依存）と Phase 2（判定）を終える
2. Phase 3（US1）で Markdown を置けるようにする
3. **STOP and VALIDATE**: CLI のテストと既存のテストがすべて通ることを確かめる

### Incremental Delivery

1. US1: Markdown を置ける（MVP）
2. US2: 置く前に確かめられる
3. US3: テキストをそのまま見せられ、誤判定を回避できる
4. US4: 判定の結果と問題に気づける
5. どの段階でも、既存の画像・SVG・HTML の扱いは変わらない

---

## Notes

- [P] tasks = different files, no dependencies
- 意味のまとまりごとに commit する（依存の追加、判定、変換と put、プレビュー、`--as`、警告、文書）
- 完了したタスクは `[X]` にする
- 実装メモ: 判定と変換をまとめる `apps/cli/src/prepare.ts` を加えた（T011・T014 で put と preview が共有）。SC-006 の 2 秒は単体テストではなく
  quickstart で計測する（research M12）。T031 は本番の環境と端末が要るため、PR の確認時に所有者が行う

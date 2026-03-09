# 実装計画: X (Twitter) 投稿Bot

## 概要

X（旧Twitter）への自動投稿CLI。Twitter API（月$100〜）は使わず、CDP + Playwright ブラウザ自動化で実装する。
既存の `twitter-collect` スキルと同一の認証・GraphQL呼び出しパターンを流用。

---

## アーキテクチャ方針

| 項目 | 内容 |
|------|------|
| 認証 | `~/.twitter-export/auth_token` (0600) からセッショントークン読み込み |
| ブラウザ | Headless Chrome (Playwright) に auth_token Cookie を注入 |
| API | Twitter 内部 GraphQL API を queryId 動的抽出で呼び出す |
| メディア | REST Media Upload API (INIT→APPEND→FINALIZE) |
| エントリポイント | `node x-post.js [options] "text"` |

---

## Linear タスク一覧と実装状況

### KEN-23: 基盤実装（CDP接続・GraphQL queryId抽出・認証）

**状態:** ✅ 実装済み（x-post.js に統合）

**実装内容:**
- `getAuthToken()` — `~/.twitter-export/auth_token` を `O_NOFOLLOW` で読み取り、権限0600を検証
- `buildAuthCookies()` — auth_token を `.x.com` ドメインの httpOnly Cookie として構築
- `checkAuthExpiry(page)` — ログインリダイレクト検知 → 即終了（fail-closed）
- `verifyCt0(page)` — ct0 Cookie が存在しない場合は abort（CSRF保護）
- `findChromeBinary()` — Chrome バイナリを複数パスで探索
- `extractQueryIds(page)` — `client-web` JS バンドルから `CreateTweet` / `CreateRetweet` queryId を動的取得
- `--no-headless` モード — CDP 経由で既存 Chrome（ポート9222）に接続

**ファイル:** `x-post.js:68-165`, `x-post.js:330-354`

---

### KEN-24: テキスト投稿・リプライ・RT

**状態:** ✅ 実装済み（x-post.js に統合）

**実装内容:**
- `postTweet()` — `CreateTweet` GraphQL。テキスト・リプライ・引用RT に対応
- `postRetweet()` — `CreateRetweet` GraphQL
- `extractTweetId(url)` — `x.com/.../status/ID` 形式から tweet_id を抽出
- `--reply <url>` — `reply.in_reply_to_tweet_id` パラメータを付与
- `--quote <url>` — `attachment_url` に `https://twitter.com/i/web/status/{id}` を付与
- `--retweet <url>` — CreateRetweet 呼び出し

**ファイル:** `x-post.js:313-677`

**CLIフラグ:**
```
node x-post.js "テキスト"
node x-post.js --reply https://x.com/user/status/123 "返信テキスト"
node x-post.js --quote  https://x.com/user/status/123 "コメント"
node x-post.js --retweet https://x.com/user/status/123
```

---

### KEN-25: スレッド投稿

**状態:** ✅ 実装済み（x-post.js に統合）

**実装内容:**
- `runThread()` — 複数ツイートを順次投稿。各ツイートのレスポンスから `rest_id` を取得し、次の `in_reply_to_tweet_id` に使用。投稿間隔 1秒。

**ファイル:** `x-post.js:693-726`

**CLIフラグ:**
```
node x-post.js --thread "1ツ目" "2つ目" "3つ目"
```

---

### KEN-22: 画像・動画アップロード（メディア投稿）

**状態:** ✅ 実装済み（x-post.js に統合）

**実装内容:**
- `getMediaMeta(filePath)` — 拡張子から MIME タイプ・カテゴリを判定（image/jpeg, image/png, image/gif, video/mp4 等）
- `uploadMediaFile(page, filePath)` — INIT→APPEND→FINALIZE の3ステップ REST API
  - Node.js でファイル読み込み → base64 → `page.evaluate()` 内で `atob()` → `Uint8Array` → `FormData`
  - 動画: 5MB チャンク分割 + `PROCESSING_INFO` ポーリング（state=succeeded まで待機）
- `uploadAllMedia()` — 複数ファイルを順次アップロード、media_id 配列を返す
- `--media <file>` — 繰り返し可能（画像最大4枚 or 動画1本）

**ファイル:** `x-post.js:388-571`

**CLIフラグ:**
```
node x-post.js --media photo.jpg "キャプション"
node x-post.js --media a.jpg --media b.jpg "複数画像"
node x-post.js --media video.mp4 "動画投稿"
```

---

### KEN-21: auto-matomeパイプラインへの組み込み

**状態:** 📋 未実装（次のタスク）

**実装方針:**
1. `run_pipeline.sh` の末尾から `node x-post.js` を呼び出す
2. 記事タイトル + URL + サムネイル画像を投稿
3. オプション: 当日のトップ3記事をスレッド形式で投稿

**実装手順:**
```bash
# 1. auto-matomeリポジトリの run_pipeline.sh を確認
# 2. 記事タイトル・URL・サムネパスを環境変数またはファイルで受け渡し
# 3. シェルスクリプトから呼び出すラッパーを作成
# 4. Cron または pipeline hook に登録
```

**必要な調整:**
- auto-matome側のリポジトリパスを確認
- サムネイル画像のパス取得ロジックを把握
- x-post.js の `--media` と `--thread` を組み合わせた呼び出し例を作成

---

## セキュリティ不変条件（全タスク共通）

1. `auth_token` の値を stdout/stderr に出力しない
2. `auth_token` は `~/.twitter-export/auth_token` (0600) からのみ読む
3. `auth_token` を環境変数に書き込まない（/proc/environ 対策）
4. `ct0` (CSRF token) は Twitter JS が自動生成。手動注入しない
5. `ct0` が取得できない場合は abort（fail-closed）
6. `auth_token` 失効時はログインリダイレクトを検知して停止

---

## テスト・検証方法

```bash
# 構文チェック
node --check x-post.js

# dry-runで動作確認（実際には投稿しない）
node x-post.js --dry-run "テストツイート"
node x-post.js --dry-run --reply https://x.com/user/status/123 "返信"
node x-post.js --dry-run --thread "1" "2" "3"
node x-post.js --dry-run --media photo.jpg "メディアテスト"

# 実際の投稿（auth_token要）
node x-post.js "テスト投稿"
```

---

## 残タスク

| Linear ID | タスク | 優先度 |
|-----------|--------|--------|
| KEN-21 | auto-matomeパイプラインへの組み込み | 低 |

KEN-23, KEN-24, KEN-25, KEN-22 はすべて `x-post.js` に実装済み。

---
name: twitter-poster
description: >
  X（旧Twitter）への自動投稿スキル。CDP + Playwright ブラウザ自動化で投稿する（Twitter API不要）。
  Use when the user wants to post to Twitter/X: tweet, reply, retweet, quote-tweet, thread, or
  media post (images/video). Triggers on: ツイートして, 投稿して, x-post, twitter post, tweetして,
  スレッド投稿, リプライして, RTして, 引用ツイート, 画像投稿, tweet this, post to X, xに投稿.
---

# twitter-poster

## Script

```
/home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js
```

auth_token: `~/.twitter-export/auth_token` (0600) — 設定済み。

## Commands

```bash
# テキスト投稿
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js "テキスト"

# リプライ
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --reply <tweet-url> "返信テキスト"

# リツイート
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --retweet <tweet-url>

# 引用リツイート
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --quote <tweet-url> "コメント"

# スレッド（引数ごとに1ツイート）
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --thread "1ツ目" "2つ目" "3つ目"

# 画像付き（最大4枚）、動画付き（1本）
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --media /path/to/file.jpg "キャプション"

# dry-run（確認のみ、実際には投稿しない）
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --dry-run "テスト"

# 現在ログイン中のアカウントを確認
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --whoami

# auth_token を更新（アカウント初期化）
node /home/kento/projects/0309/twitter-poster/skills/twitter-poster/scripts/x-post.js --set-token
```

## Workflow

1. **投稿前に必ず `--whoami` でアカウントを確認**（意図しないアカウント操作防止）
2. 投稿内容・種別をユーザーに確認（不明な場合は質問）
3. 必要なら `--dry-run` で先に確認
4. コマンド実行 → 出力の `Logged in as: @username` とツイートID をユーザーに報告

## アカウント管理

- **全操作で `Logged in as: @username` を自動表示** — 操作前に必ず確認できる
- `--whoami`: アカウント確認のみ（投稿しない）
- `--set-token`: Chrome DevTools > Application > Cookies > `auth_token` の値を対話入力で更新
- auth_token は `~/.twitter-export/auth_token` (0600) に保存

## 重要: 実装制約

**CDP経由のブラウザ自動化のみ使用すること。公式APIは絶対に使わない。**

- ✅ OK: Playwright headless Chrome + auth_token Cookie injection
- ✅ OK: ブラウザセッション内部から呼ぶ `x.com/i/api/graphql/...`（Twitterウェブアプリが内部で使うエンドポイント）
- ❌ NG: Twitter/X 公式API（`api.twitter.com`, OAuth app keys, Bearer token for public API）
- ❌ NG: Twitter API v2 / v1.1 公式エンドポイント（有料・要OAuth）

内部エンドポイントのパス名に `1.1` や `graphql` が含まれていても、それはブラウザの内部通信であり公式APIではない。

## Notes

- `--media` は繰り返し可能（`--media a.jpg --media b.jpg`）
- スレッドの各ツイートは140字制限に注意
- エラー時の主な原因: auth_token失効 / ct0未取得 / queryId取得失敗
- 既存 Chrome に接続する場合: `--no-headless --port 9222` を追加

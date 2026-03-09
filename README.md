# twitter-poster

X（旧Twitter）への自動投稿CLI。Twitter API（月$100〜）を使わず、CDP + Playwright ブラウザ自動化で実装。

## セットアップ

### 1. 依存インストール

```bash
npm install
```

### 2. auth_token の準備

Chrome の DevTools または拡張機能で `auth_token` Cookie の値を取得し、ファイルに保存する。

```bash
mkdir -p ~/.twitter-export
echo "YOUR_AUTH_TOKEN_HERE" > ~/.twitter-export/auth_token
chmod 600 ~/.twitter-export/auth_token
```

> **注意:** `auth_token` はアカウントへのフルアクセスを持つセッショントークン。漏洩するとアカウントを乗っ取られる。パーミッションは必ず `0600` に設定すること。

---

## 使い方

### テキスト投稿

```bash
node skills/twitter-poster/scripts/x-post.js "ツイート本文"
```

### リプライ

```bash
node skills/twitter-poster/scripts/x-post.js --reply https://x.com/user/status/1234567890 "返信テキスト"
```

### リツイート（RT）

```bash
node skills/twitter-poster/scripts/x-post.js --retweet https://x.com/user/status/1234567890
```

### 引用リツイート（QT）

```bash
node skills/twitter-poster/scripts/x-post.js --quote https://x.com/user/status/1234567890 "コメント"
```

### スレッド投稿

```bash
node skills/twitter-poster/scripts/x-post.js --thread "1ツ目のツイート" "2つ目のツイート" "3つ目のツイート"
```

### 画像付き投稿

```bash
# 1枚
node skills/twitter-poster/scripts/x-post.js --media photo.jpg "キャプション"

# 複数枚（最大4枚）
node skills/twitter-poster/scripts/x-post.js --media a.jpg --media b.jpg --media c.jpg "複数画像"
```

### 動画付き投稿

```bash
node skills/twitter-poster/scripts/x-post.js --media video.mp4 "動画のキャプション"
```

### dry-run（実際には投稿しない）

```bash
node skills/twitter-poster/scripts/x-post.js --dry-run "テスト"
node skills/twitter-poster/scripts/x-post.js --dry-run --thread "1" "2" "3"
node skills/twitter-poster/scripts/x-post.js --dry-run --media photo.jpg "確認"
```

---

## オプション一覧

| フラグ | 説明 |
|--------|------|
| `--reply <url>` | 指定ツイートへの返信 |
| `--retweet <url>` | 指定ツイートをRT |
| `--quote <url>` | 指定ツイートを引用RT（コメント必須） |
| `--thread` | 残りの引数をスレッドとして連続投稿 |
| `--media <file>` | 添付ファイル（繰り返し可。画像最大4枚 or 動画1本） |
| `--dry-run` | 投稿内容を表示するだけで実際には投稿しない |
| `--no-headless` | 既存 Chrome に CDP 接続（ポート9222） |
| `--port <n>` | CDP ポート番号（デフォルト: 9222） |

---

## 対応メディア形式

| 種別 | 形式 |
|------|------|
| 画像 | JPEG, PNG, GIF |
| 動画 | MP4, MOV, WEBM |

---

## 仕組み

1. `~/.twitter-export/auth_token` からセッショントークンを読み込む
2. Headless Chrome を起動し、auth_token Cookie を注入
3. `https://x.com/home` にアクセスして ct0 (CSRF token) を取得
4. JS バンドルから GraphQL の `queryId` を動的に抽出
5. Twitter 内部 GraphQL API 経由で投稿

> Twitter の内部 API は仕様変更されることがある。動作しない場合は Issue を報告してください。

---

## 関連

- 実装計画: [`docs/PLAN.md`](docs/PLAN.md)
- Linear: [KEN-20](https://linear.app/keno/issue/KEN-20) X自動投稿bot実装

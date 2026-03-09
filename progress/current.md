# Current Progress

## Objective

Build a Twitter/X posting automation CLI (`x-post.js`) using CDP + Playwright browser automation (no paid API).

## Status

Core implementation complete. KEN-23/24/25/22 done. KEN-21 (pipeline integration) remains.

## Key Paths

- Main implementation: x-post.js
- Implementation plan: docs/PLAN.md
- Harness checker: tools/harness
- Agents instructions: AGENTS.md

## Last Session

- What was changed: Implemented x-post.js (955 lines) covering KEN-23 (auth/CDP foundation), KEN-24 (text/reply/RT), KEN-25 (thread), KEN-22 (media upload). Added docs/PLAN.md with full task breakdown.
- What was verified: node --check x-post.js passed. ./tools/harness self-check passed.
- Where to resume: Implement KEN-21 — hook x-post.js into auto-matome pipeline (run_pipeline.sh).

## Resume Here

- Next command to run: ./tools/harness self-check
- Next file to open: docs/PLAN.md
- Expected first small task: Find auto-matome repo, understand run_pipeline.sh output format, wire x-post.js call at end.

## Next Actions

- [ ] KEN-21: auto-matomeパイプラインへの組み込み
  1. 場所確認: auto-matome リポジトリの `run_pipeline.sh` を探す
  2. 記事タイトル・URL・サムネパスの受け渡し方を把握
  3. `node x-post.js --media <thumb> "<title> <url>"` 形式で呼び出すラッパー作成
  4. スレッド形式（トップ3記事）は `--thread` フラグで実装
- [ ] 実機テスト: `node x-post.js "test"` で実際に投稿確認（auth_token要）
- [ ] `--dry-run` での全オプション動作確認

## Blockers

- None.

## Risks

- Twitter 内部 GraphQL の queryId は随時変更される可能性あり（動的抽出で対応済み）
- auth_token の有効期限は約1年。失効時は `~/.twitter-export/auth_token` を更新する必要がある
- メディアアップロード API の仕様変更リスク

## Last Verified

- Command: node --check x-post.js && ./tools/harness self-check
- Result: Both passed.
- Date: 2026-03-09

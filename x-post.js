#!/usr/bin/env node

/**
 * x-post.js - CLI tool for posting to Twitter/X using browser automation (CDP + Playwright headless)
 *
 * !! このファイルを編集する前に必ず読んでください !!
 *
 * 設計意図:
 *   auth_token は Twitter のセッショントークン（有効期限約1年）。
 *   これが漏洩するとアカウントを乗っ取られる。
 *   以下のセキュリティ不変条件を絶対に壊さないこと。
 *
 * 不変条件:
 *   1. auth_token の値を stdout/stderr に絶対に出力しない
 *   2. auth_token は平文ファイル (~/.twitter-export/auth_token, 0600) から読む
 *   3. auth_token を環境変数に書き込まない（/proc/environ 対策）
 *   4. 取得した auth_token の参照寿命を最短化する（Cookie 注入まで）
 *   5. ct0 (CSRF token) は Twitter JS が自動生成する。手動注入しない
 *   6. ct0 が取得できない場合は処理を中断する（fail-closed）
 *   7. auth_token 失効時はログインリダイレクトを検知して停止する
 *
 * Usage:
 *   node x-post.js [options] "tweet text"
 *   node x-post.js --thread "tweet1" "tweet2" "tweet3"
 *   node x-post.js --reply <tweet-url> "reply text"
 *   node x-post.js --retweet <tweet-url>
 *   node x-post.js --quote <tweet-url> "comment"
 *   node x-post.js --media <file1> [--media <file2>] "tweet text"
 *   node x-post.js --dry-run "text"
 *
 * Options:
 *   --reply <url>      Reply to tweet at given URL
 *   --retweet <url>    Retweet the tweet at given URL
 *   --quote <url>      Quote-tweet the tweet at given URL
 *   --thread           Post remaining positional args as a thread
 *   --media <file>     Attach media file (can be repeated, up to 4 images or 1 video)
 *   --dry-run          Parse args and print what would be sent, without posting
 *   --no-headless      Connect via CDP to existing Chrome at port 9222
 *   --port <number>    CDP port (default: 9222, --no-headless only)
 */

'use strict';

const { chromium } = require('./node_modules/playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Security constants
// ---------------------------------------------------------------------------

const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const AUTH_TOKEN_PATH = process.env.TWITTER_AUTH_TOKEN_FILE
  || path.join(os.homedir(), '.twitter-export', 'auth_token');

// ---------------------------------------------------------------------------
// Auth helpers (mirrors auth.js security invariants)
// ---------------------------------------------------------------------------

/**
 * Read auth_token from file with strict security checks.
 * - O_NOFOLLOW: no symlink traversal
 * - Must be 0600 permissions
 * - Value is never printed
 */
function getAuthToken() {
  let fd;
  try {
    fd = fs.openSync(AUTH_TOKEN_PATH, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const hint = err.code === 'ENOENT' ? ' (file not found)' : '';
    console.error(`ERROR: Failed to read auth_token${hint}`);
    process.exit(1);
  }
  try {
    const stat = fs.fstatSync(fd);
    // eslint-disable-next-line no-bitwise
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      console.error(`ERROR: auth_token file has insecure permissions (${mode.toString(8)}). Expected 600.`);
      process.exit(1);
    }
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!token) {
      console.error('ERROR: auth_token file is empty');
      process.exit(1);
    }
    return token;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Build Playwright cookie array from auth_token.
 * auth_token reference lifetime is intentionally short.
 */
function buildAuthCookies() {
  const authToken = getAuthToken();
  const cookies = [
    {
      name: 'auth_token',
      value: authToken,
      domain: '.x.com',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ];
  console.log('auth_token retrieved from file');
  return cookies;
}

/**
 * Detect login redirect → auth_token expired (invariant 7).
 */
function checkAuthExpiry(page) {
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
    console.error('ERROR: Redirected to login page. auth_token may be expired.');
    console.error('Update auth_token file and retry.');
    process.exit(1);
  }
}

/**
 * Verify ct0 CSRF cookie is present. Fail-closed (invariant 6).
 */
async function verifyCt0(page) {
  const cookies = await page.context().cookies('https://x.com');
  if (cookies.some(c => c.name === 'ct0')) return;

  console.log('ct0 not found after page load. Attempting reload...');
  await page.reload({ waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(3000);

  const retryCheck = await page.context().cookies('https://x.com');
  if (!retryCheck.some(c => c.name === 'ct0')) {
    console.error('ERROR: ct0 cookie not available. Cannot post. Aborting (fail-closed).');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Chrome binary detection
// ---------------------------------------------------------------------------

function findChromeBinary() {
  const candidates = [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'google-chrome';
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const argv = process.argv.slice(2);

  const config = {
    mode: 'tweet',        // 'tweet' | 'reply' | 'retweet' | 'quote' | 'thread'
    texts: [],            // positional tweet text(s)
    replyUrl: null,
    retweetUrl: null,
    quoteUrl: null,
    mediaFiles: [],
    dryRun: false,
    headless: true,
    port: 9222,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--dry-run') {
      config.dryRun = true;
      i++;
    } else if (arg === '--no-headless') {
      config.headless = false;
      i++;
    } else if (arg === '--headless') {
      config.headless = true;
      i++;
    } else if (arg === '--port' && argv[i + 1]) {
      config.port = parseInt(argv[i + 1], 10);
      i += 2;
    } else if (arg === '--reply' && argv[i + 1]) {
      config.mode = 'reply';
      config.replyUrl = argv[i + 1];
      i += 2;
    } else if (arg === '--retweet' && argv[i + 1]) {
      config.mode = 'retweet';
      config.retweetUrl = argv[i + 1];
      i += 2;
    } else if (arg === '--quote' && argv[i + 1]) {
      config.mode = 'quote';
      config.quoteUrl = argv[i + 1];
      i += 2;
    } else if (arg === '--thread') {
      config.mode = 'thread';
      i++;
    } else if (arg === '--media' && argv[i + 1]) {
      config.mediaFiles.push(argv[i + 1]);
      i += 2;
    } else if (!arg.startsWith('--')) {
      config.texts.push(arg);
      i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  // Validate
  if (config.mode === 'retweet') {
    if (!config.retweetUrl) {
      console.error('ERROR: --retweet requires a tweet URL');
      process.exit(1);
    }
  } else if (config.mode === 'reply') {
    if (!config.replyUrl) {
      console.error('ERROR: --reply requires a tweet URL');
      process.exit(1);
    }
    if (config.texts.length === 0) {
      console.error('ERROR: --reply requires reply text');
      process.exit(1);
    }
  } else if (config.mode === 'quote') {
    if (!config.quoteUrl) {
      console.error('ERROR: --quote requires a tweet URL');
      process.exit(1);
    }
    if (config.texts.length === 0) {
      console.error('ERROR: --quote requires comment text');
      process.exit(1);
    }
  } else if (config.mode === 'thread') {
    if (config.texts.length < 2) {
      console.error('ERROR: --thread requires at least 2 tweet texts');
      process.exit(1);
    }
  } else {
    // plain tweet
    if (config.texts.length === 0) {
      console.error('ERROR: tweet text required');
      printUsage();
      process.exit(1);
    }
  }

  // Validate media files exist
  for (const f of config.mediaFiles) {
    if (!fs.existsSync(f)) {
      console.error(`ERROR: Media file not found: ${f}`);
      process.exit(1);
    }
  }

  if (config.mediaFiles.length > 4) {
    console.error('ERROR: Maximum 4 media files per tweet');
    process.exit(1);
  }

  return config;
}

function printUsage() {
  console.error(`
Usage:
  node x-post.js [options] "tweet text"
  node x-post.js --thread "tweet1" "tweet2" "tweet3"
  node x-post.js --reply <tweet-url> "reply text"
  node x-post.js --retweet <tweet-url>
  node x-post.js --quote <tweet-url> "comment"
  node x-post.js --media <file> "tweet text"
  node x-post.js --dry-run "text"

Options:
  --reply <url>      Reply to the tweet at given URL
  --retweet <url>    Retweet the tweet at given URL
  --quote <url>      Quote-tweet with comment
  --thread           Post remaining positional args as a thread
  --media <file>     Attach media (repeat for multiple; max 4 images or 1 video)
  --dry-run          Show what would be posted without actually posting
  --no-headless      Connect via CDP to existing Chrome at port 9222
  --port <n>         CDP port (default: 9222)
`.trim());
}

// ---------------------------------------------------------------------------
// Tweet ID extraction from URL
// ---------------------------------------------------------------------------

/**
 * Extract numeric tweet ID from x.com or twitter.com status URL.
 * e.g. https://x.com/user/status/1234567890 → "1234567890"
 */
function extractTweetId(url) {
  const m = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
  if (!m) {
    console.error(`ERROR: Cannot extract tweet ID from URL: ${url}`);
    process.exit(1);
  }
  return m[1];
}

// ---------------------------------------------------------------------------
// GraphQL queryId extraction
// ---------------------------------------------------------------------------

/**
 * Scan client-web JS bundles for CreateTweet and CreateRetweet queryIds.
 * queryIds change per Twitter deploy, so we cannot hardcode them.
 */
async function extractQueryIds(page) {
  return page.evaluate(async () => {
    if (location.origin !== 'https://x.com') return {};

    const scripts = [...document.querySelectorAll('script[src]')]
      .map(s => s.src)
      .filter(s => s.includes('client-web'));

    const ids = {};
    for (const url of scripts) {
      try {
        const text = await fetch(url).then(r => r.text());

        const ct = text.match(/queryId:"([^"]+)",operationName:"CreateTweet"/);
        if (ct) ids.CreateTweet = ct[1];

        const cr = text.match(/queryId:"([^"]+)",operationName:"CreateRetweet"/);
        if (cr) ids.CreateRetweet = cr[1];

        if (ids.CreateTweet && ids.CreateRetweet) break;
      } catch {}
    }
    return ids;
  });
}

// ---------------------------------------------------------------------------
// CreateTweet features object (standard set)
// ---------------------------------------------------------------------------

const CREATE_TWEET_FEATURES = {
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_video_timestamps_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ---------------------------------------------------------------------------
// Media upload helpers
// ---------------------------------------------------------------------------

/**
 * Determine media_type and media_category from file extension.
 */
function getMediaMeta(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg':  { mediaType: 'image/jpeg', mediaCategory: 'tweet_image' },
    '.jpeg': { mediaType: 'image/jpeg', mediaCategory: 'tweet_image' },
    '.png':  { mediaType: 'image/png',  mediaCategory: 'tweet_image' },
    '.gif':  { mediaType: 'image/gif',  mediaCategory: 'tweet_gif'   },
    '.mp4':  { mediaType: 'video/mp4',  mediaCategory: 'tweet_video' },
    '.mov':  { mediaType: 'video/mp4',  mediaCategory: 'tweet_video' },
    '.webm': { mediaType: 'video/webm', mediaCategory: 'tweet_video' },
  };
  const meta = map[ext];
  if (!meta) {
    console.error(`ERROR: Unsupported media file type: ${ext}`);
    process.exit(1);
  }
  return meta;
}

/**
 * Upload one media file to Twitter's chunked media upload API.
 * Runs inside page.evaluate() using FormData + fetch with credentials:include.
 * The file buffer is passed as a base64 string from Node.js, decoded in browser.
 *
 * Returns media_id_string on success.
 */
async function uploadMediaFile(page, filePath, bearer) {
  console.log(`  Uploading media: ${path.basename(filePath)}`);

  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');
  const totalBytes = fileBuffer.length;
  const { mediaType, mediaCategory } = getMediaMeta(filePath);
  const isVideo = mediaCategory === 'tweet_video';

  // Chunk size: 5MB for video, whole file for images
  const CHUNK_SIZE = 5 * 1024 * 1024;

  const mediaId = await page.evaluate(
    async ({ base64Data, totalBytes, mediaType, mediaCategory, isVideo, chunkSize, bearer }) => {
      // Decode base64 → Uint8Array
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }

      const uploadUrl = 'https://upload.twitter.com/1.1/media/upload.json';

      // Shared auth headers (no Content-Type — FormData sets boundary)
      function authHeaders(csrfToken) {
        return {
          'x-csrf-token': csrfToken,
          'authorization': `Bearer ${bearer}`,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
        };
      }

      // Extract ct0 CSRF token from cookie
      const ct0Entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
      if (!ct0Entry) throw new Error('ct0 cookie not found in page context');
      const csrfToken = ct0Entry.split('=')[1];

      // --- INIT ---
      const initForm = new FormData();
      initForm.append('command', 'INIT');
      initForm.append('total_bytes', String(totalBytes));
      initForm.append('media_type', mediaType);
      initForm.append('media_category', mediaCategory);

      const initRes = await fetch(uploadUrl, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(csrfToken),
        body: initForm,
      });
      if (!initRes.ok) {
        const txt = await initRes.text();
        throw new Error(`INIT failed (${initRes.status}): ${txt}`);
      }
      const initData = await initRes.json();
      const mediaId = initData.media_id_string;
      if (!mediaId) throw new Error('INIT response missing media_id_string');

      // --- APPEND (chunked) ---
      const numChunks = Math.ceil(totalBytes / chunkSize);
      for (let seg = 0; seg < numChunks; seg++) {
        const start = seg * chunkSize;
        const end = Math.min(start + chunkSize, totalBytes);
        const chunk = bytes.slice(start, end);
        const blob = new Blob([chunk], { type: mediaType });

        const appendForm = new FormData();
        appendForm.append('command', 'APPEND');
        appendForm.append('media_id', mediaId);
        appendForm.append('segment_index', String(seg));
        appendForm.append('media', blob);

        const appendRes = await fetch(uploadUrl, {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders(csrfToken),
          body: appendForm,
        });
        // 204 No Content is success for APPEND
        if (!appendRes.ok && appendRes.status !== 204) {
          const txt = await appendRes.text();
          throw new Error(`APPEND segment ${seg} failed (${appendRes.status}): ${txt}`);
        }
      }

      // --- FINALIZE ---
      const finalizeForm = new FormData();
      finalizeForm.append('command', 'FINALIZE');
      finalizeForm.append('media_id', mediaId);

      const finalizeRes = await fetch(uploadUrl, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders(csrfToken),
        body: finalizeForm,
      });
      if (!finalizeRes.ok) {
        const txt = await finalizeRes.text();
        throw new Error(`FINALIZE failed (${finalizeRes.status}): ${txt}`);
      }
      const finalizeData = await finalizeRes.json();

      // --- POLL for video processing ---
      if (isVideo && finalizeData.processing_info) {
        let state = finalizeData.processing_info.state;
        let checkAfterSecs = finalizeData.processing_info.check_after_secs || 5;

        while (state === 'pending' || state === 'in_progress') {
          await new Promise(r => setTimeout(r, checkAfterSecs * 1000));

          const statusRes = await fetch(
            `${uploadUrl}?command=STATUS&media_id=${mediaId}`,
            {
              method: 'GET',
              credentials: 'include',
              headers: authHeaders(csrfToken),
            }
          );
          if (!statusRes.ok) {
            const txt = await statusRes.text();
            throw new Error(`STATUS check failed (${statusRes.status}): ${txt}`);
          }
          const statusData = await statusRes.json();
          const pi = statusData.processing_info;
          if (!pi) break;
          state = pi.state;
          checkAfterSecs = pi.check_after_secs || 5;
        }

        if (state === 'failed') {
          throw new Error('Video processing failed on Twitter side');
        }
      }

      return mediaId;
    },
    { base64Data, totalBytes, mediaType, mediaCategory, isVideo, chunkSize: CHUNK_SIZE, bearer }
  );

  console.log(`  Media uploaded: id=${mediaId}`);
  return mediaId;
}

/**
 * Upload all media files and return array of media_id strings.
 */
async function uploadAllMedia(page, mediaFiles, bearer) {
  if (mediaFiles.length === 0) return [];
  console.log(`Uploading ${mediaFiles.length} media file(s)...`);
  const ids = [];
  for (const f of mediaFiles) {
    const id = await uploadMediaFile(page, f, bearer);
    ids.push(id);
  }
  console.log(`All media uploaded: [${ids.join(', ')}]`);
  return ids;
}

// ---------------------------------------------------------------------------
// GraphQL posting operations
// ---------------------------------------------------------------------------

/**
 * Post a single tweet via GraphQL CreateTweet.
 * All params are passed into page.evaluate() to run inside the browser context.
 */
async function postTweet(page, { text, queryId, replyToId, quoteUrl, mediaIds, bearer }) {
  return page.evaluate(
    async ({ text, queryId, replyToId, quoteUrl, mediaIds, bearer, features }) => {
      if (location.origin !== 'https://x.com') return { error: 'wrong origin' };

      const ct0Entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
      if (!ct0Entry) return { error: 'ct0 not found' };
      const csrfToken = ct0Entry.split('=')[1];

      const variables = {
        tweet_text: text,
        dark_request: false,
        media: {
          media_ids: mediaIds || [],
          tagged_user_ids: [],
        },
        semantic_annotation_ids: [],
        reply_control: {},
      };

      if (replyToId) {
        variables.reply = {
          in_reply_to_tweet_id: replyToId,
          exclude_reply_user_ids: [],
        };
      }

      if (quoteUrl) {
        variables.attachment_url = quoteUrl;
      }

      try {
        const res = await fetch(`https://x.com/i/api/graphql/${queryId}/CreateTweet`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'authorization': `Bearer ${bearer}`,
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-active-user': 'yes',
          },
          body: JSON.stringify({ variables, features, queryId }),
        });
        const data = await res.json();
        if (!res.ok) return { error: `HTTP ${res.status}`, data };
        return { ok: true, data };
      } catch (e) {
        return { error: e.message };
      }
    },
    { text, queryId, replyToId, quoteUrl, mediaIds, bearer, features: CREATE_TWEET_FEATURES }
  );
}

/**
 * Retweet a tweet via GraphQL CreateRetweet.
 */
async function postRetweet(page, { tweetId, queryId, bearer }) {
  return page.evaluate(
    async ({ tweetId, queryId, bearer }) => {
      if (location.origin !== 'https://x.com') return { error: 'wrong origin' };

      const ct0Entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
      if (!ct0Entry) return { error: 'ct0 not found' };
      const csrfToken = ct0Entry.split('=')[1];

      const variables = {
        tweet_id: tweetId,
        dark_request: false,
      };

      try {
        const res = await fetch(`https://x.com/i/api/graphql/${queryId}/CreateRetweet`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrfToken,
            'authorization': `Bearer ${bearer}`,
            'x-twitter-auth-type': 'OAuth2Session',
            'x-twitter-active-user': 'yes',
          },
          body: JSON.stringify({ variables, features: {}, queryId }),
        });
        const data = await res.json();
        if (!res.ok) return { error: `HTTP ${res.status}`, data };
        return { ok: true, data };
      } catch (e) {
        return { error: e.message };
      }
    },
    { tweetId, queryId, bearer }
  );
}

/**
 * Extract tweet ID from GraphQL CreateTweet response.
 */
function extractPostedTweetId(result) {
  try {
    const tweet = result.data?.create_tweet?.tweet_results?.result;
    return tweet?.rest_id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// High-level operation dispatchers
// ---------------------------------------------------------------------------

async function runThread(page, texts, queryIds, mediaIds, bearer) {
  // Only first tweet in thread gets media; subsequent tweets are plain text replies
  let prevTweetId = null;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const attachMedia = i === 0 ? mediaIds : [];

    console.log(`Posting thread tweet ${i + 1}/${texts.length}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

    const result = await postTweet(page, {
      text,
      queryId: queryIds.CreateTweet,
      replyToId: prevTweetId,
      quoteUrl: null,
      mediaIds: attachMedia,
      bearer,
    });

    if (result.error) {
      console.error(`ERROR posting thread tweet ${i + 1}: ${result.error}`);
      if (result.data) console.error(JSON.stringify(result.data, null, 2));
      process.exit(1);
    }

    prevTweetId = extractPostedTweetId(result.data);
    console.log(`  Thread tweet ${i + 1} posted${prevTweetId ? ` (id=${prevTweetId})` : ''}`);

    // Small delay between thread posts
    if (i < texts.length - 1) {
      await page.waitForTimeout(1000 + Math.random() * 500);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = parseArgs();

  // --- Dry run mode ---
  if (config.dryRun) {
    console.log('=== DRY RUN ===');
    console.log('Mode:', config.mode);
    if (config.texts.length) console.log('Text(s):', config.texts);
    if (config.replyUrl) console.log('Reply to:', config.replyUrl);
    if (config.retweetUrl) console.log('Retweet:', config.retweetUrl);
    if (config.quoteUrl) console.log('Quote:', config.quoteUrl);
    if (config.mediaFiles.length) console.log('Media:', config.mediaFiles);
    console.log('(No actual posting in --dry-run mode)');
    process.exit(0);
  }

  // --- Print summary of what we will do ---
  console.log('x-post.js');
  console.log('Mode:', config.mode);
  if (config.texts.length) console.log('Text(s):', config.texts.map(t => `"${t.slice(0, 60)}${t.length > 60 ? '...' : ''}"`).join(', '));
  if (config.replyUrl) console.log('Reply to:', config.replyUrl);
  if (config.retweetUrl) console.log('Retweet:', config.retweetUrl);
  if (config.quoteUrl) console.log('Quote tweet:', config.quoteUrl);
  if (config.mediaFiles.length) console.log('Media files:', config.mediaFiles);

  let browser;
  let headlessBrowser;
  let page;

  try {
    if (config.headless) {
      // --- Headless mode: inject auth_token cookie ---
      const cookies = buildAuthCookies();

      console.log('Launching headless Chrome...');
      headlessBrowser = await chromium.launch({
        headless: true,
        executablePath: findChromeBinary(),
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const context = await headlessBrowser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });

      await context.addCookies(cookies);
      console.log(`  ${cookies.length} auth cookie(s) injected`);

      page = await context.newPage();
      console.log('Headless Chrome ready');
    } else {
      // --- CDP mode: connect to existing Chrome ---
      try {
        browser = await chromium.connectOverCDP(`http://localhost:${config.port}`);
        console.log(`Connected to Chrome via CDP on port ${config.port}`);
      } catch (err) {
        console.error(`ERROR: Failed to connect to Chrome CDP on port ${config.port}: ${err.message}`);
        process.exit(1);
      }

      const context = browser.contexts()[0];
      if (!context) {
        console.error('ERROR: No browser context found in existing Chrome');
        process.exit(1);
      }
      page = await context.newPage();
    }

    // --- Navigate to x.com/home ---
    console.log('Navigating to https://x.com/home ...');
    try {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      console.log('Page loaded (networkidle timeout is normal for Twitter)');
    }
    await page.waitForTimeout(3000);

    // --- Security gates ---
    checkAuthExpiry(page);  // invariant 7: detect login redirect
    await verifyCt0(page);  // invariant 6: ct0 must be present

    // --- Extract GraphQL queryIds ---
    console.log('Extracting GraphQL queryIds from JS bundles...');
    const queryIds = await extractQueryIds(page);
    console.log('  CreateTweet queryId:', queryIds.CreateTweet || '(not found)');
    console.log('  CreateRetweet queryId:', queryIds.CreateRetweet || '(not found)');

    if (!queryIds.CreateTweet && config.mode !== 'retweet') {
      console.error('ERROR: Could not find CreateTweet queryId in JS bundles. Twitter may have redeployed.');
      process.exit(1);
    }
    if (!queryIds.CreateRetweet && config.mode === 'retweet') {
      console.error('ERROR: Could not find CreateRetweet queryId in JS bundles. Twitter may have redeployed.');
      process.exit(1);
    }

    // --- Upload media if any ---
    const mediaIds = await uploadAllMedia(page, config.mediaFiles, BEARER_TOKEN);

    // --- Execute the requested operation ---
    let result;

    switch (config.mode) {
      case 'tweet': {
        const text = config.texts[0];
        console.log(`Posting tweet: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`);
        result = await postTweet(page, {
          text,
          queryId: queryIds.CreateTweet,
          replyToId: null,
          quoteUrl: null,
          mediaIds,
          bearer: BEARER_TOKEN,
        });
        if (result.error) {
          console.error('ERROR posting tweet:', result.error);
          if (result.data) console.error(JSON.stringify(result.data, null, 2));
          process.exit(1);
        }
        const tweetId = extractPostedTweetId(result.data);
        console.log(`Tweet posted successfully${tweetId ? ` (id=${tweetId})` : ''}`);
        break;
      }

      case 'reply': {
        const replyToId = extractTweetId(config.replyUrl);
        const text = config.texts[0];
        console.log(`Replying to tweet ${replyToId}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);
        result = await postTweet(page, {
          text,
          queryId: queryIds.CreateTweet,
          replyToId,
          quoteUrl: null,
          mediaIds,
          bearer: BEARER_TOKEN,
        });
        if (result.error) {
          console.error('ERROR posting reply:', result.error);
          if (result.data) console.error(JSON.stringify(result.data, null, 2));
          process.exit(1);
        }
        const replyId = extractPostedTweetId(result.data);
        console.log(`Reply posted successfully${replyId ? ` (id=${replyId})` : ''}`);
        break;
      }

      case 'retweet': {
        const tweetId = extractTweetId(config.retweetUrl);
        console.log(`Retweeting tweet ${tweetId}`);
        result = await postRetweet(page, {
          tweetId,
          queryId: queryIds.CreateRetweet,
          bearer: BEARER_TOKEN,
        });
        if (result.error) {
          console.error('ERROR retweeting:', result.error);
          if (result.data) console.error(JSON.stringify(result.data, null, 2));
          process.exit(1);
        }
        console.log('Retweet posted successfully');
        break;
      }

      case 'quote': {
        const quotedId = extractTweetId(config.quoteUrl);
        const quoteAttachUrl = `https://twitter.com/i/web/status/${quotedId}`;
        const text = config.texts[0];
        console.log(`Quote-tweeting ${quotedId}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);
        result = await postTweet(page, {
          text,
          queryId: queryIds.CreateTweet,
          replyToId: null,
          quoteUrl: quoteAttachUrl,
          mediaIds,
          bearer: BEARER_TOKEN,
        });
        if (result.error) {
          console.error('ERROR posting quote tweet:', result.error);
          if (result.data) console.error(JSON.stringify(result.data, null, 2));
          process.exit(1);
        }
        const qId = extractPostedTweetId(result.data);
        console.log(`Quote tweet posted successfully${qId ? ` (id=${qId})` : ''}`);
        break;
      }

      case 'thread': {
        console.log(`Posting thread of ${config.texts.length} tweets`);
        await runThread(page, config.texts, queryIds, mediaIds, BEARER_TOKEN);
        console.log('Thread posted successfully');
        break;
      }

      default:
        console.error(`ERROR: Unknown mode: ${config.mode}`);
        process.exit(1);
    }
  } finally {
    // Always clean up the browser
    if (headlessBrowser) {
      await headlessBrowser.close();
    } else if (page) {
      await page.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error(`x-post.js failed: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, extractTweetId, getMediaMeta };

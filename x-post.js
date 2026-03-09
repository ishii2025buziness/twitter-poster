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
 *   node x-post.js --dry-run "text"
 *
 * Options:
 *   --reply <url>      Reply to tweet at given URL
 *   --retweet <url>    Retweet the tweet at given URL
 *   --quote <url>      Quote-tweet the tweet at given URL
 *   --thread           Post remaining positional args as a thread
 *   --dry-run          Parse args and print what would be sent, without posting
 *   --no-headless      Connect via CDP to existing Chrome at port 9222
 *   --port <number>    CDP port (default: 9222, --no-headless only)
 */

'use strict';

const { chromium } = require('./node_modules/playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

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
  const cookieBase = {
    name: 'auth_token',
    value: authToken,
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  };
  const cookies = [
    { ...cookieBase, domain: '.x.com' },
    { ...cookieBase, domain: '.twitter.com' },
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

/**
 * Fetch the screen_name of the currently logged-in account via Viewer GraphQL query.
 * Returns "username" or null on failure.
 */
async function getLoggedInUser(page) {
  return page.evaluate(async (bearer) => {
    const ct0Entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
    if (!ct0Entry) return null;
    const csrfToken = ct0Entry.split('=')[1];
    try {
      // Extract Viewer queryId from JS bundles
      const scripts = [...document.querySelectorAll('script[src]')]
        .map(s => s.src)
        .filter(s => s.includes('client-web'));
      let viewerQid = null;
      for (const url of scripts) {
        try {
          const text = await fetch(url).then(r => r.text());
          const m = text.match(/queryId:"([^"]+)",operationName:"Viewer"/);
          if (m) { viewerQid = m[1]; break; }
        } catch {}
      }
      if (!viewerQid) return null;

      const features = {
        responsive_web_graphql_exclude_directive_enabled: true,
        verified_phone_label_enabled: false,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        responsive_web_graphql_timeline_navigation_enabled: true,
      };
      const variables = { withCommunitiesMemberships: true };
      const apiUrl = `https://x.com/i/api/graphql/${viewerQid}/Viewer?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
      const res = await fetch(apiUrl, {
        credentials: 'include',
        headers: {
          'authorization': `Bearer ${bearer}`,
          'x-csrf-token': csrfToken,
          'x-twitter-auth-type': 'OAuth2Session',
          'x-twitter-active-user': 'yes',
        },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const m = JSON.stringify(data).match(/"screen_name":"([^"]+)"/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }, BEARER_TOKEN);
}

/**
 * Interactively update auth_token file (account initialization).
 * Reads token from stdin to avoid shell history exposure.
 */
async function runSetToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`auth_token will be saved to: ${AUTH_TOKEN_PATH}`);
  const token = await new Promise((resolve) => {
    rl.question('Paste your auth_token (from Chrome DevTools > Application > Cookies > auth_token): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!token) {
    console.error('ERROR: No token provided');
    process.exit(1);
  }

  const dir = path.dirname(AUTH_TOKEN_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(AUTH_TOKEN_PATH, token + '\n', { mode: 0o600 });
  console.log(`auth_token saved to ${AUTH_TOKEN_PATH} (permissions: 0600)`);
  console.log('Run "node x-post.js --whoami" to verify the account.');
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
    mode: 'tweet',        // 'tweet' | 'reply' | 'retweet' | 'quote' | 'thread' | 'whoami' | 'set-token'
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

    if (arg === '--whoami') {
      config.mode = 'whoami';
      i++;
    } else if (arg === '--set-token') {
      config.mode = 'set-token';
      i++;
    } else if (arg === '--dry-run') {
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
  if (config.mode === 'whoami' || config.mode === 'set-token') {
    return config;
  }

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
  node x-post.js --dry-run "text"
  node x-post.js --whoami
  node x-post.js --set-token

Options:
  --whoami           Show which account is currently logged in, then exit
  --set-token        Update auth_token interactively (account initialization)
  --reply <url>      Reply to the tweet at given URL
  --retweet <url>    Retweet the tweet at given URL
  --quote <url>      Quote-tweet with comment
  --thread           Post remaining positional args as a thread
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
// Media upload via page.evaluate() (browser context, upload.x.com)
// ---------------------------------------------------------------------------

async function uploadMediaFile(page, filePath) {
  console.log(`  Uploading media: ${path.basename(filePath)}`);

  const fileBuffer = fs.readFileSync(filePath);
  const totalBytes = fileBuffer.length;
  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    '.jpg': ['image/jpeg', 'tweet_image'], '.jpeg': ['image/jpeg', 'tweet_image'],
    '.png': ['image/png', 'tweet_image'],  '.gif': ['image/gif', 'tweet_gif'],
    '.mp4': ['video/mp4', 'tweet_video'],  '.mov': ['video/mp4', 'tweet_video'],
    '.webm': ['video/webm', 'tweet_video'],
  };
  const [mediaType, mediaCategory] = typeMap[ext] || (() => { throw new Error(`Unsupported file type: ${ext}`); })();
  const isVideo = mediaCategory === 'tweet_video';
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const base64Data = fileBuffer.toString('base64');

  const mediaId = await page.evaluate(
    async ({ base64Data, totalBytes, mediaType, mediaCategory, isVideo, chunkSize, bearer }) => {
      const uploadUrl = 'https://upload.x.com/1.1/media/upload.json';

      const ct0Entry = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('ct0='));
      if (!ct0Entry) throw new Error('ct0 cookie not found');
      const csrfToken = ct0Entry.split('=')[1];

      const headers = {
        'x-csrf-token': csrfToken,
        'authorization': `Bearer ${bearer}`,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
      };

      // Decode base64 → Uint8Array
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

      // INIT
      const initForm = new FormData();
      initForm.append('command', 'INIT');
      initForm.append('total_bytes', String(totalBytes));
      initForm.append('media_type', mediaType);
      initForm.append('media_category', mediaCategory);
      const initRes = await fetch(uploadUrl, { method: 'POST', credentials: 'include', headers, body: initForm });
      if (!initRes.ok) { const t = await initRes.text(); throw new Error(`INIT ${initRes.status}: ${t}`); }
      const { media_id_string: mediaId } = await initRes.json();
      if (!mediaId) throw new Error('INIT: no media_id_string');

      // APPEND
      const numChunks = Math.ceil(totalBytes / chunkSize);
      for (let seg = 0; seg < numChunks; seg++) {
        const chunk = bytes.slice(seg * chunkSize, Math.min((seg + 1) * chunkSize, totalBytes));
        const appendForm = new FormData();
        appendForm.append('command', 'APPEND');
        appendForm.append('media_id', mediaId);
        appendForm.append('segment_index', String(seg));
        appendForm.append('media', new Blob([chunk], { type: mediaType }));
        const r = await fetch(uploadUrl, { method: 'POST', credentials: 'include', headers, body: appendForm });
        if (!r.ok && r.status !== 204) { const t = await r.text(); throw new Error(`APPEND[${seg}] ${r.status}: ${t}`); }
      }

      // FINALIZE
      const finalizeForm = new FormData();
      finalizeForm.append('command', 'FINALIZE');
      finalizeForm.append('media_id', mediaId);
      const finalizeRes = await fetch(uploadUrl, { method: 'POST', credentials: 'include', headers, body: finalizeForm });
      if (!finalizeRes.ok) { const t = await finalizeRes.text(); throw new Error(`FINALIZE ${finalizeRes.status}: ${t}`); }
      const finalizeData = await finalizeRes.json();

      // POLL for video
      if (isVideo && finalizeData.processing_info) {
        let { state, check_after_secs: wait = 5 } = finalizeData.processing_info;
        while (state === 'pending' || state === 'in_progress') {
          await new Promise(r => setTimeout(r, wait * 1000));
          const sr = await fetch(`${uploadUrl}?command=STATUS&media_id=${mediaId}`, { credentials: 'include', headers });
          if (!sr.ok) { const t = await sr.text(); throw new Error(`STATUS ${sr.status}: ${t}`); }
          const sd = await sr.json();
          if (!sd.processing_info) break;
          ({ state, check_after_secs: wait = 5 } = sd.processing_info);
        }
        if (state === 'failed') throw new Error('Video processing failed');
      }

      return mediaId;
    },
    { base64Data, totalBytes, mediaType, mediaCategory, isVideo, chunkSize: CHUNK_SIZE, bearer: BEARER_TOKEN }
  );

  console.log(`  Media uploaded: id=${mediaId}`);
  return mediaId;
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
        semantic_annotation_ids: [],
      };

      if (mediaIds && mediaIds.length > 0) {
        variables.media = { media_ids: mediaIds, tagged_user_ids: [] };
      }

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
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {}
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
    const tweet = result?.data?.create_tweet?.tweet_results?.result;
    return tweet?.rest_id || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// High-level operation dispatchers
// ---------------------------------------------------------------------------

async function runThread(page, texts, queryIds, bearer) {
  let prevTweetId = null;

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];

    console.log(`Posting thread tweet ${i + 1}/${texts.length}: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`);

    const result = await postTweet(page, {
      text,
      queryId: queryIds.CreateTweet,
      replyToId: prevTweetId,
      quoteUrl: null,
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

  // --- set-token mode: no browser needed ---
  if (config.mode === 'set-token') {
    await runSetToken();
    return;
  }

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

    // --- Account verification ---
    const screenName = await getLoggedInUser(page);
    if (screenName) {
      console.log(`Logged in as: @${screenName}`);
    } else {
      console.warn('WARNING: Could not determine logged-in account. Proceeding anyway.');
    }

    if (config.mode === 'whoami') {
      return;
    }

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
    const mediaIds = [];
    if (config.mediaFiles.length > 0) {
      console.log(`Uploading ${config.mediaFiles.length} media file(s)...`);
      for (const f of config.mediaFiles) {
        mediaIds.push(await uploadMediaFile(page, f));
      }
    }

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
        await runThread(page, config.texts, queryIds, BEARER_TOKEN);
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

module.exports = { main, extractTweetId };

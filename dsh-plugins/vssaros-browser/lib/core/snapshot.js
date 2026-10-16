/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ⚠ **本文件由脚本生成，不要手改**：`node dsh-plugins/vssaros-browser/bin/sync-snapshot.mjs`。
 *
 * 真源：`src/vs/sessions/contrib/agentStudio/browser/browserCdpSnapshot.ts`（esbuild 机械转换 TS→JS）。
 * 为什么 Host 侧要有一份：独立入口没有 VsSaros，但 `browser` 族的 `snapshot` 必须给出**同一套**
 * ref 与同一套渲染结果（模型在两种入口之间不应该看到两种格式）。
 * 一致性由 `test/common/dshBrowserPlugin.test.ts` 里的 `--check` 守卫兜住。
 */

// src/vs/sessions/contrib/agentStudio/common/chromeDebugSetup.ts
var CHROME_REMOTE_DEBUGGING_PAGE = "chrome://inspect/#remote-debugging";

// src/vs/sessions/contrib/agentStudio/common/webPageQuality.ts
var MIN_USEFUL_CONTENT_LENGTH = 200;
var SHORT_PAGE_LIMIT = 600;
var SCAN_HEAD_CHARS = 300;
var STRONG_BLOCK_PATTERNS = [
  { re: /checking your browser( before accessing)?/i, label: "cloudflare-browser-check" },
  { re: /enable javascript and cookies to continue/i, label: "js-cookies-required" },
  { re: /attention required!\s*[|\-–—]\s*cloudflare/i, label: "cloudflare-block-page" },
  { re: /ddos protection by/i, label: "ddos-guard" },
  { re: /(verifying|checking) (that )?you are (a )?human/i, label: "human-verification" },
  { re: /cf-(chl-|browser-verification)/i, label: "cloudflare-chl" },
  { re: /(网站|站点|服务)(正在)?(进行)?(安全|人机|身份)?验证/i, label: "zh-verification" },
  { re: /(请|需要)(启用|开启)\s*(您的)?\s*JavaScript/i, label: "zh-js-required" }
];
var WEAK_BLOCK_PATTERNS = [
  { re: /just a moment/i, label: "cloudflare-interstitial" },
  { re: /(re|h)captcha|turnstile/i, label: "captcha" },
  { re: /are you a robot/i, label: "robot-check" },
  { re: /access denied|403 forbidden/i, label: "access-denied" },
  { re: /too many requests|rate limit(ed)?/i, label: "rate-limited" }
];
var STRONG_UNAVAILABLE_PATTERNS = [
  { re: /你访问的页面不见了/, label: "zh-page-gone" },
  { re: /(当前)?笔记(暂时)?无法(浏览|查看)/, label: "zh-note-unavailable" },
  { re: /你要(查看|访问)的页面(不存在|已删除|找不到了)/, label: "zh-page-removed" }
];
var LOGIN_WALL_PATTERNS = [
  { re: /请先登录后(查看|继续|访问)/, label: "zh-login-required" },
  { re: /登录后(可)?查看/, label: "zh-login-to-view" },
  { re: /请(在|用)(手机|App|客户端)(内|中)?(打开|查看)/i, label: "zh-app-only" }
];
function classifyExtractQuality(text, title) {
  const trimmed = (text ?? "").trim();
  const length = trimmed.length;
  const head = `${title ?? ""}
${trimmed.slice(0, SCAN_HEAD_CHARS)}`;
  const signals = [];
  let kind;
  for (const p of STRONG_UNAVAILABLE_PATTERNS) {
    if (p.re.test(head)) {
      signals.push(p.label);
      kind = "unavailable";
    }
  }
  for (const p of STRONG_BLOCK_PATTERNS) {
    if (p.re.test(head)) {
      signals.push(p.label);
      kind ??= "interstitial";
    }
  }
  if (signals.length === 0 && length < SHORT_PAGE_LIMIT) {
    for (const p of LOGIN_WALL_PATTERNS) {
      if (p.re.test(head)) {
        signals.push(p.label);
        kind = "login-required";
      }
    }
    for (const p of WEAK_BLOCK_PATTERNS) {
      if (p.re.test(head)) {
        signals.push(p.label);
        kind ??= "interstitial";
      }
    }
  }
  if (signals.length > 0) {
    return {
      verdict: "blocked",
      kind,
      length,
      reason: `${kindReason(kind)} (${signals.join(", ")})`,
      signals
    };
  }
  if (length < MIN_USEFUL_CONTENT_LENGTH) {
    return { verdict: "thin", length, reason: `extracted text is suspiciously short (${length} < ${MIN_USEFUL_CONTENT_LENGTH} chars)`, signals: [] };
  }
  return { verdict: "ok", length, reason: "content looks usable", signals: [] };
}
function kindReason(kind) {
  switch (kind) {
    case "login-required":
      return "page is behind a login / client-only wall";
    case "unavailable":
      return "page reports itself as gone or restricted";
    default:
      return "looks like an interstitial, not page content";
  }
}
var WEB_PAGE_QUALITY_SIGNAL_LABELS = [
  ...STRONG_UNAVAILABLE_PATTERNS,
  ...STRONG_BLOCK_PATTERNS,
  ...LOGIN_WALL_PATTERNS,
  ...WEAK_BLOCK_PATTERNS
].map((p) => p.label);
var MANUAL_ACTION_NEEDS_HUMAN = {
  "login-required": true,
  "app-only": true,
  "captcha-required": true,
  "browser-check": false,
  "rate-limited": false,
  "permission-required": false,
  "content-gone": false,
  unknown: false
};
var MANUAL_ACTION_BY_SIGNAL = {
  "zh-login-required": "login-required",
  "zh-login-to-view": "login-required",
  "zh-app-only": "app-only",
  "captcha": "captcha-required",
  "human-verification": "captcha-required",
  "robot-check": "captcha-required",
  "zh-verification": "captcha-required",
  "cloudflare-browser-check": "browser-check",
  "cloudflare-block-page": "browser-check",
  "cloudflare-interstitial": "browser-check",
  "cloudflare-chl": "browser-check",
  "ddos-guard": "browser-check",
  "js-cookies-required": "browser-check",
  "zh-js-required": "browser-check",
  "rate-limited": "rate-limited",
  "access-denied": "permission-required",
  "zh-page-gone": "content-gone",
  "zh-note-unavailable": "content-gone",
  "zh-page-removed": "content-gone"
};
var MANUAL_ACTION_HINT = {
  "login-required": "ask the user to sign in once in the browser window this toolset drives (a QR code scan is fine)",
  "app-only": "client/App-only content: ask the user to open it on their phone and paste it, or say so honestly",
  "captcha-required": "only a human can clear this check \u2014 do NOT retry in a loop",
  "browser-check": "anti-bot check: one retry often passes; if not, use the real browser or find another source",
  "rate-limited": "back off and retry later, or take the information from another source",
  "permission-required": "this is not a login problem \u2014 it is unavailable to this account/region; find another source",
  "content-gone": "the content is gone \u2014 signing in will not bring it back; find another source",
  unknown: "unclear which wall this is \u2014 say what you actually saw instead of guessing"
};
function assessManualAction(quality) {
  if (quality.verdict !== "blocked") {
    return void 0;
  }
  for (const signal of quality.signals) {
    const action = MANUAL_ACTION_BY_SIGNAL[signal];
    if (action) {
      return { action, needsHuman: MANUAL_ACTION_NEEDS_HUMAN[action], hint: MANUAL_ACTION_HINT[action], signal };
    }
  }
  return { action: "unknown", needsHuman: false, hint: MANUAL_ACTION_HINT.unknown };
}
function manualActionLine(quality) {
  const assessed = assessManualAction(quality);
  if (!assessed) {
    return "";
  }
  return `manualAction: ${assessed.action} (needsHuman=${assessed.needsHuman ? "yes" : "no"}) \u2014 ${assessed.hint}`;
}
function finishWallNotice(lines, quality) {
  const actionLine = manualActionLine(quality);
  if (actionLine) {
    lines.push("", actionLine);
  }
  return lines.join("\n");
}
function browserPageWallNotice(url, quality, opts) {
  if (quality.verdict !== "blocked") {
    return "";
  }
  const where = url || "this page";
  const cause = quality.kind === "login-required" ? 'the site is answering with a **login wall / "open in the app" notice** instead of the page' : quality.kind === "unavailable" ? 'the site is answering with a "content is gone / restricted" notice instead of the page' : "the site served an anti-bot / browser-check interstitial instead of the page";
  const lines = [
    "",
    "---",
    "",
    "## \u26A0 This is NOT the page content",
    `Everything above was captured from a placeholder: ${cause} (signals: ${quality.signals.join(", ") || quality.reason}).`,
    "Do NOT summarise it, and do NOT guess what the real page says."
  ];
  if (opts?.imageList) {
    lines.push("In particular, do NOT treat the list above as the page's images: on a login wall / interstitial the only `<img>` that render are avatars and site icons.");
  }
  if (quality.kind === "login-required") {
    lines.push(
      "",
      "Why: the browser this toolset is driving is **not signed in** to this site \u2014 nothing is wrong with the tools or with page loading, the identity is missing.",
      "",
      "This is the one case where **retrying changes nothing**: the wall comes back every single time until someone signs in. Do not retry, do not fall back to a plain text fetch, and do not reconstruct the content from the title.",
      "",
      "Next step (ask the user for this \u2014 never ask for credentials, and never type them yourself):",
      "  1. Get the page open in a real, visible browser window and ask the user to sign in there once (scanning a QR code with their phone is fine). If the window this toolset drives is the dedicated instance, that session stays in its profile and later calls reuse it.",
      `  2. Or switch to the browser that already holds their logins: ask them to open \`${CHROME_REMOTE_DEBUGGING_PAGE}\` in their everyday Chrome and tick "Allow remote debugging for this browser instance". Keep the configured CDP port at 9222 \u2014 that toggle has no port option. Our tools prefer that browser over the dedicated instance we launch ourselves.`,
      '  3. Then call `browser` with `op: "login"` together with `done: true` \u2014 it inspects the login state and tells you plainly whether it took. Only after that is a fresh snapshot worth taking.',
      "",
      `Then reload ${where} and take a fresh snapshot. Anything read before that is placeholder-only \u2014 say so plainly instead of reusing it.`
    );
    return finishWallNotice(lines, quality);
  }
  if (quality.kind === "unavailable") {
    lines.push(
      "",
      "Why: this is **not** about credentials \u2014 the resource itself is gone, or is restricted to certain accounts/regions. Signing in will not bring it back.",
      "",
      "Next step (pick whichever fits):",
      "  1. Say plainly that the item is unavailable / restricted, and stop: do not retry this URL and do not reconstruct it from its title or snippet.",
      "  2. Get the same information elsewhere (search, mirror, the site's official API), or ask the user to paste the content.",
      "",
      `A fresh snapshot of ${where} will show the same notice \u2014 take one only to confirm the situation changed.`
    );
    return finishWallNotice(lines, quality);
  }
  lines.push(
    "",
    'Why: the site classified this session as automated **before** it served the page. The identity is not the issue here \u2014 the "how" is.',
    "",
    "Next step (pick whichever fits, then reload and snapshot again):",
    `  1. Prefer the browser that already holds the user's logins and a normal browsing history: ask them to open \`${CHROME_REMOTE_DEBUGGING_PAGE}\` in their everyday Chrome and tick "Allow remote debugging for this browser instance" (keep the configured CDP port at 9222 \u2014 that toggle has no port option).`,
    "  2. Retry later \u2014 rate limits and challenges are often momentary \u2014 or take the information from another source.",
    "",
    `Then reload ${where} and take a fresh snapshot. Anything read before that is placeholder-only \u2014 say so plainly instead of reusing it.`
  );
  return finishWallNotice(lines, quality);
}

// src/vs/sessions/contrib/agentStudio/browser/browserCdpSnapshot.ts
var SAROS_REF_ATTR = "data-saros-ref";
var MAX_SNAPSHOT_REFS = 400;
var SNAPSHOT_TEXT_EXCERPT_LIMIT = 2e3;
var SNAPSHOT_SCRIPT = `(() => {
  const REF = '${SAROS_REF_ATTR}';
  const MAX_REFS = ${MAX_SNAPSHOT_REFS};
  const out = { url: location.href, title: document.title, nodes: [], headings: [], textExcerpt: '', truncatedRefs: false };
  const clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };

  // \u6E05\u6389\u4E0A\u4E00\u8F6E\u7684\u6807\u8BB0\uFF1A\u9875\u9762\u53EF\u80FD\u5DF2\u7ECF\u53D8\u4E86\uFF0C\u65E7 ref \u4E00\u5F8B\u4F5C\u5E9F\uFF08\u907F\u514D\u6A21\u578B\u7528\u8FC7\u671F ref \u70B9\u5230\u522B\u5904\uFF09\u3002
  try { document.querySelectorAll('[' + REF + ']').forEach(function (e) { e.removeAttribute(REF); }); } catch (e) { }

  const visible = function (el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) { return false; }
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') { return false; }
      return true;
    } catch (e) { return false; }
  };

  const nameOf = function (el) {
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria) { return clean(aria).slice(0, 120); }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const ph = el.getAttribute('placeholder');
      if (ph) { return clean(ph).slice(0, 120); }
      const own = clean(el.value);
      if (own) { return own.slice(0, 120); }
    }
    const txt = clean(el.innerText || el.textContent || '');
    if (txt) { return txt.slice(0, 120); }
    const other = el.getAttribute && (el.getAttribute('title') || el.getAttribute('name'));
    return clean(other || '').slice(0, 120);
  };

  const roleOf = function (el) {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) { return clean(explicit).toLowerCase(); }
    const tag = el.tagName;
    const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
    if (tag === 'A') { return 'link'; }
    if (tag === 'BUTTON' || tag === 'SUMMARY') { return 'button'; }
    if (tag === 'SELECT') { return 'combobox'; }
    if (tag === 'TEXTAREA') { return 'textbox'; }
    if (tag === 'OPTION') { return 'option'; }
    if (tag === 'INPUT') {
      if (type === 'checkbox' || type === 'radio') { return type; }
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') { return 'button'; }
      return 'textbox';
    }
    if (el.isContentEditable) { return 'textbox'; }
    return '';
  };

  let ref = 0;
  const walk = function (root) {
    let list;
    try { list = root.querySelectorAll('*'); } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      try {
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') { continue; }
        // \u7A7F\u900F open shadow root\uFF08\u666E\u901A\u9009\u62E9\u5668\u53D6\u4E0D\u5230\uFF0C\u4F46\u5185\u5BB9\u786E\u5B9E\u5728 DOM \u91CC\uFF09\u3002
        if (el.shadowRoot) { walk(el.shadowRoot); }
        const role = roleOf(el);
        if (!role) { continue; }
        if (!visible(el)) { continue; }
        const name = nameOf(el);
        if (!name && role !== 'textbox' && role !== 'combobox') { continue; }
        if (ref >= MAX_REFS) { out.truncatedRefs = true; return; }
        ref = ref + 1;
        el.setAttribute(REF, String(ref));
        out.nodes.push({ ref: ref, role: role, name: name });
      } catch (e) { /* \u5355\u4E2A\u5143\u7D20\u5931\u8D25\u4E0D\u5F71\u54CD\u6574\u4F53 */ }
    }
  };
  try { walk(document); } catch (e) { }

  // \u540C\u6E90 iframe \u4E5F\u8D70\u4E00\u904D\uFF08\u8DE8\u6E90\u8BFB\u4E0D\u5230\uFF0Ctry/catch \u515C\u4F4F\uFF09\u3002
  try {
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length && ref < MAX_REFS; i++) {
      try {
        const doc = frames[i].contentDocument;
        if (doc) { walk(doc); }
      } catch (e) { }
    }
  } catch (e) { }

  try {
    const hs = document.querySelectorAll('h1,h2,h3');
    for (let i = 0; i < hs.length && i < 30; i++) {
      const t = clean(hs[i].innerText || hs[i].textContent);
      if (t) { out.headings.push(hs[i].tagName.toLowerCase() + ' ' + t.slice(0, 140)); }
    }
  } catch (e) { }

  try {
    const body = document.body ? clean(document.body.innerText || document.body.textContent || '') : '';
    out.textExcerpt = body.slice(0, ${SNAPSHOT_TEXT_EXCERPT_LIMIT});
  } catch (e) { }

  return out;
})()`;
function normalizeRawSnapshot(raw) {
  const r = raw ?? {};
  const nodes = Array.isArray(r.nodes) ? r.nodes.filter((n) => !!n && typeof n.ref === "number" && typeof n.name === "string").map((n) => ({ ref: n.ref, role: typeof n.role === "string" ? n.role : "generic", name: n.name })) : [];
  return {
    url: typeof r.url === "string" ? r.url : "",
    title: typeof r.title === "string" ? r.title : "",
    nodes,
    headings: Array.isArray(r.headings) ? r.headings.filter((h) => typeof h === "string") : [],
    textExcerpt: typeof r.textExcerpt === "string" ? r.textExcerpt : "",
    truncatedRefs: r.truncatedRefs === true
  };
}
function formatSnapshot(raw) {
  const lines = [];
  lines.push(`# ${raw.title || raw.url || "(untitled)"}`);
  if (raw.url) {
    lines.push(`URL: ${raw.url}`);
  }
  lines.push("", `## Interactive elements (${raw.nodes.length})`);
  if (raw.nodes.length === 0) {
    lines.push("(none found \u2014 this page exposes no visible interactive elements; read the text excerpt instead)");
  } else {
    for (const n of raw.nodes) {
      lines.push(`[${n.ref}] ${n.role}${n.name ? ` "${n.name}"` : ""}`);
    }
  }
  if (raw.truncatedRefs) {
    lines.push(`\u2026 more interactive elements were not listed (limit ${MAX_SNAPSHOT_REFS}). Scroll or narrow the page to see the rest.`);
  }
  if (raw.headings.length > 0) {
    lines.push("", "## Headings");
    lines.push(...raw.headings);
  }
  if (raw.textExcerpt) {
    lines.push("", "## Text excerpt");
    lines.push(raw.textExcerpt);
  }
  lines.push("", "Use `browser_click` / `browser_type` with the [n] refs above. Refs are invalidated by navigation or re-render \u2014 call `browser_snapshot` again after any change.");
  const wallNotice = browserPageWallNotice(raw.url, classifyExtractQuality(raw.textExcerpt, raw.title));
  if (wallNotice) {
    lines.push(wallNotice);
  }
  return lines.join("\n");
}
function isDocumentComplete(raw) {
  return raw?.readyState === "complete";
}
var READY_STATE_SCRIPT = `({ readyState: (document.readyState || '') })`;
var MAX_SNAPSHOT_IMAGES = 40;
var MIN_IMAGE_DIMENSION = 100;
var MAX_SNAPSHOT_VIDEOS = 12;
var IMAGES_SCRIPT = `(() => {
  const MAX = ${MAX_SNAPSHOT_IMAGES};
  const MIN = ${MIN_IMAGE_DIMENSION};
  const out = { url: location.href, title: document.title, images: [], truncated: false, skippedInline: 0 };
  const seen = {};
  const clean = function (t) { return String(t == null ? '' : t).replace(/\\s+/g, ' ').trim(); };
  const dims = function (el) {
    let w = 0, h = 0;
    try {
      w = el.naturalWidth || 0; h = el.naturalHeight || 0;
      if (!w || !h) { const r = el.getBoundingClientRect(); w = Math.round(r.width); h = Math.round(r.height); }
    } catch (e) { }
    return { w: w, h: h };
  };
  const collect = function (list) {
    for (let i = 0; i < list.length; i++) {
      try {
        const el = list[i];
        // currentSrc \u4F18\u5148\uFF1A\u61D2\u52A0\u8F7D\uFF08data-src / srcset\uFF09\u6E32\u67D3\u540E\u53EA\u6709\u5B83\u662F\u771F\u5B9E\u5730\u5740\u3002
        let src = '';
        try { src = el.currentSrc || el.src || ''; } catch (e) { src = ''; }
        const attrSrc = el.getAttribute ? (el.getAttribute('src') || '') : '';
        if (!src) { src = attrSrc; }
        if (!src) { continue; }
        // \u53EA\u770B**\u751F\u6548\u7684** src \u662F\u4E0D\u662F\u5185\u8054\u56FE\u3002\u26A0 \u4E0D\u80FD\u628A"\u5C5E\u6027\u662F data:"\u4E5F\u5F53\u8DF3\u8FC7\uFF1A\u61D2\u52A0\u8F7D\u7684\u5E38\u89C1\u5199\u6CD5\u662F
        // src \u653E 1\xD71 \u7684 data: \u5360\u4F4D\u3001\u771F\u5730\u5740\u5728 currentSrc \u2014\u2014 \u90A3\u6837\u4F1A\u628A\u6574\u5F20\u771F\u56FE\u8BEF\u5220\uFF08\u5B9E\u6D4B\u5199\u6CD5\u903C\u51FA\u6765\u7684\uFF09\u3002
        if (src.indexOf('data:') === 0) { out.skippedInline = out.skippedInline + 1; continue; }
        const d = dims(el);
        if (d.w > 0 && d.h > 0 && d.w < MIN && d.h < MIN) { continue; }
        if (seen[src]) { continue; }
        seen[src] = 1;
        if (out.images.length >= MAX) { out.truncated = true; continue; }
        const alt = el.getAttribute ? (el.getAttribute('alt') || '') : '';
        out.images.push({ src: src, alt: clean(alt).slice(0, 160), width: d.w, height: d.h });
      } catch (e) { /* \u5355\u5F20\u5931\u8D25\u4E0D\u5F71\u54CD\u6574\u4F53 */ }
    }
  };
  try { collect(document.querySelectorAll('img')); } catch (e) { }
  // \u540C\u6E90 iframe \u4E5F\u6536\u4E00\u904D\uFF08\u4E0E\u5FEB\u7167\u811A\u672C\u540C\u4E00\u53D6\u5411\uFF1A\u8DE8\u6E90\u8BFB\u4E0D\u5230\uFF0Ctry/catch \u515C\u4F4F\uFF09\u3002
  try {
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      try { const doc = frames[i].contentDocument; if (doc) { collect(doc.querySelectorAll('img')); } } catch (e) { }
    }
  } catch (e) { }
  // \u89C6\u9891\u76F4\u94FE\uFF082026-09-25\uFF09\uFF1Avideo.currentSrc/src \u6216 <video><source src>\u3002
  // \u53EA\u6536 http(s) \u76F4\u94FE \u2014\u2014 blob:/data: \u662F\u9875\u9762**\u672C\u5730**\u751F\u6210\u7684\u64AD\u653E\u5BF9\u8C61\uFF08HLS \u5E38\u89C1\uFF09\uFF0C
  // \u5BF9\u6A21\u578B/\u62BD\u5E27\u4E0D\u53EF\u6D88\u8D39\uFF0C\u6536\u8FDB\u6765\u5C31\u662F\u5047\u76F4\u94FE\uFF08"\u770B\u8D77\u6765\u6709\u76F4\u94FE\uFF0C\u5176\u5B9E\u7528\u4E0D\u4E86"\uFF09\u3002
  // \u7EAA\u5F8B\u540C collect\uFF1A\u53EA\u91C7\u96C6\u539F\u59CB\u4E8B\u5B9E\uFF0C\u600E\u4E48\u663E\u793A\u4EA4\u7ED9 formatImages\u3002
  const videos = [];
  const seenV = {};
  const collectVideos = function (root) {
    const list = root.querySelectorAll('video');
    for (let i = 0; i < list.length; i++) {
      try {
        const el = list[i];
        let src = '';
        try { src = el.currentSrc || el.src || ''; } catch (e) { src = ''; }
        if (!src) { const s = el.querySelector ? el.querySelector('source') : null; if (s) { src = s.src || (s.getAttribute ? (s.getAttribute('src') || '') : ''); } }
        if (!src || src.indexOf('http') !== 0) { continue; }
        if (seenV[src]) { continue; }
        seenV[src] = 1;
        if (videos.length >= ${MAX_SNAPSHOT_VIDEOS}) { continue; }
        const t = el.getAttribute ? (el.getAttribute('title') || el.getAttribute('aria-label') || '') : '';
        videos.push({ src: src, title: clean(t).slice(0, 120) });
      } catch (e) { }
    }
  };
  try { collectVideos(document); } catch (e) { }
  try {
    const frames2 = document.querySelectorAll('iframe');
    for (let i = 0; i < frames2.length; i++) {
      try { const doc = frames2[i].contentDocument; if (doc) { collectVideos(doc); } } catch (e) { }
    }
  } catch (e) { }
  out.videos = videos;
  return out;
})()`;
function normalizeRawImages(raw) {
  const r = raw ?? {};
  const images = Array.isArray(r.images) ? r.images.filter((i) => !!i && typeof i.src === "string" && i.src.length > 0).map((i) => ({
    src: i.src,
    alt: typeof i.alt === "string" ? i.alt : "",
    width: typeof i.width === "number" ? i.width : 0,
    height: typeof i.height === "number" ? i.height : 0
  })) : [];
  const videos = Array.isArray(r.videos) ? r.videos.filter((v) => !!v && typeof v.src === "string" && v.src.length > 0).map((v) => ({
    src: v.src,
    title: typeof v.title === "string" ? v.title : ""
  })) : [];
  return {
    url: typeof r.url === "string" ? r.url : "",
    title: typeof r.title === "string" ? r.title : "",
    images,
    truncated: r.truncated === true,
    skippedInline: typeof r.skippedInline === "number" && r.skippedInline > 0 ? Math.floor(r.skippedInline) : 0,
    videos
  };
}
function formatImages(raw) {
  const lines = [];
  lines.push(`# ${raw.title || raw.url || "(untitled)"}`);
  if (raw.url) {
    lines.push(`URL: ${raw.url}`);
  }
  lines.push("", `## Images (${raw.images.length})`);
  if (raw.images.length === 0) {
    lines.push("(none found \u2014 no rendered <img> passed the size filter; try scrolling the page first, or the page may draw images via CSS background)");
  } else {
    for (const img of raw.images) {
      const size = img.width > 0 && img.height > 0 ? ` [${img.width}x${img.height}]` : " [size unknown]";
      lines.push(`${img.src}${size}${img.alt ? `  alt="${img.alt}"` : ""}`);
    }
  }
  if (raw.truncated) {
    lines.push(`\u2026 more images were not listed (limit ${MAX_SNAPSHOT_IMAGES}). Scroll to load the rest, then call this tool again.`);
  }
  if (raw.skippedInline > 0) {
    lines.push(`(${raw.skippedInline} inline data: image(s) skipped \u2014 base64 payloads never enter the context)`);
  }
  if (raw.videos && raw.videos.length > 0) {
    lines.push("", `## Videos (${raw.videos.length})`);
    for (const v of raw.videos) {
      lines.push(`${v.src}${v.title ? `  "${v.title}"` : ""}`);
    }
    lines.push('To read the video: `extract_video_frames(source=<one of the URLs above>, outDir="<vault>/\u5E93/raw/assets/<slug>/")` then `vision_analyze` each frame.');
  }
  lines.push(
    "",
    "Notes: only rendered `<img>` elements (incl. same-origin iframes); CSS background images are NOT listed; deduplicated by URL; images smaller than both dimensions of the filter are treated as icons.",
    "To read text inside an image: call `vision_analyze` with the image URL directly (one image per call). To keep it in a note: download it with `execute_code` into `\u5E93/raw/assets/<slug>/` and reference it as a **relative** path."
  );
  const wallNotice = browserPageWallNotice(
    raw.url,
    classifyExtractQuality("", raw.title),
    { imageList: true }
  );
  if (wallNotice) {
    lines.push(wallNotice);
  }
  return lines.join("\n");
}
export {
  IMAGES_SCRIPT,
  MANUAL_ACTION_NEEDS_HUMAN,
  MAX_SNAPSHOT_IMAGES,
  MAX_SNAPSHOT_REFS,
  MAX_SNAPSHOT_VIDEOS,
  MIN_IMAGE_DIMENSION,
  READY_STATE_SCRIPT,
  SAROS_REF_ATTR,
  SNAPSHOT_SCRIPT,
  SNAPSHOT_TEXT_EXCERPT_LIMIT,
  assessManualAction,
  browserPageWallNotice,
  classifyExtractQuality,
  formatImages,
  formatSnapshot,
  isDocumentComplete,
  kindReason,
  manualActionLine,
  normalizeRawImages,
  normalizeRawSnapshot
};

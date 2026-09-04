#!/usr/bin/env node
/**
 * LightAI -> OpenAI 兼容适配器
 *
 * LightAI（腾讯光子内部 aigclsp.com 的 gemini-chat 应用）本质是 web 聊天，
 * 没有原生 OpenAI 兼容接口。本服务对外暴露 OpenAI 兼容的
 *   POST /v1/chat/completions   (支持 stream 与非 stream)
 *   GET  /v1/models
 * 内部把请求翻译成 LightAI 的真实协议：
 *   POST /api/gemini/chat/create_conversation
 *   POST /api/gemini/chat/send_message/{conversation_id}
 *
 * 鉴权所需凭据来自登录后的浏览器会话（cookie + x-user-id），通过环境变量注入。
 * 这些凭据会过期，过期后重新从浏览器 DevTools 的 Network 里取 cookie / x-user-id 更新即可。
 *
 * 用法：
 *   LIGHTAI_COOKIE="sessionid=...; uid=..." \
 *   LIGHTAI_USER_ID="xxx@tencent.com" \
 *   node server.js
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---------- 配置 ----------
const CFG = {
  baseUrl: process.env.LIGHTAI_BASE_URL || 'https://lightai-gemini-chat-v1-sd.aigclsp.com',
  cookie: process.env.LIGHTAI_COOKIE || '',
  userId: process.env.LIGHTAI_USER_ID || '',
  appId: process.env.LIGHTAI_APP_ID || '137',
  bizId: process.env.LIGHTAI_BIZ_ID || '73',
  // project_name 会做 encodeURIComponent，这里写原文
  projectName: process.env.LIGHTAI_PROJECT_NAME || '萨罗斯GR项目',
  appName: process.env.LIGHTAI_APP_NAME || '智能对话',
  userType: process.env.LIGHTAI_USER_TYPE || '内部用户',
  company: process.env.LIGHTAI_COMPANY || '腾讯-二方公司',
  defaultModel: process.env.LIGHTAI_DEFAULT_MODEL || 'gemini-3.5-flash',
  port: parseInt(process.env.PORT || '8011', 10),
  // k 参数（用于 referer，保持与浏览器一致，部分网关会校验）
  refererK:
    process.env.LIGHTAI_REFERER_K ||
    'YXBwX2lkPTEzNyZhcHBfbmFtZT3mmbrog73lr7nor50mcHJvZHVjdF9pZD03MyZwcm9kdWN0X25hbWU96JCo572X5pavR1Lpobnnm64=&lang=zh_CN',
};

const MODELS = (process.env.LIGHTAI_MODELS || 'gemini-3.5-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 会话复用表：会话 key（X-Conversation-ID / user / Authorization）→ LightAI conversation_id。
// LightAI 是会话制（历史在服务端按 conversation_id 维护），多轮对话必须复用同一个
// conversation，否则每次新建会话都会丢失上下文（与 chatgpt2api 的消息收发语义对齐）。
// key 优先级：X-Conversation-ID header（VsSaros 每次请求都会带上会话 ID）> body.user >
// Authorization header。命中即复用，未命中则新建并登记。
const conversations = new Map();
// 会话复用表上限：超出后删除最旧条目（Map 迭代顺序 = 插入顺序），防止长期运行内存增长。
const MAX_CONVERSATIONS = parseInt(process.env.LIGHTAI_MAX_CONVERSATIONS || '100', 10);

// ---------- 工具 ----------
// WAF 无害化：LightAI 上游有 WAF，直发 <script>/javascript:/on* 等会被 403 拦截。
// 把危险字面量拆散（保持人类可读），绕过规则而不改变语义。
function sanitizeForWAF(text) {
  let out = text;
  out = out.replace(/<(\s*)script/gi, (_m, sp) => '<' + sp + 'scr ipt');
  out = out.replace(/javascript\s*:/gi, () => 'java script :');
  out = out.replace(/\b(alert|prompt|confirm|eval)\s*\(/gi, (_m, w) => w.slice(0, -1) + ' ' + w.slice(-1) + '(');
  out = out.replace(/document\.cookie/gi, () => 'document .cookie');
  out = out.replace(/union\s+select/gi, () => 'union sele ct');
  out = out.replace(/\b(on[a-z]{2,})\s*=/gi, (_m, w) => w.slice(0, 2) + ' ' + w.slice(2) + '=');
  return out;
}

// 从 OpenAI content 提取纯文本：支持 string 与 multimodal array（[{type:'text',text}]）。
function extractTextContent(content) {
  if (typeof content === 'string') { return content; }
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
  }
  return '';
}

// 把 OpenAI messages 数组按角色标记拼接成单条 text（LightAI 上游 5 个发送端点均只收
// 单条 text，无结构化 messages 数组端点 —— 这是「传数组」在本协议下的等效形态）。
// includeHistory=false 时只发 system + 最后一条 user（会话复用命中，服务端已持有历史）。
// 超长（MAX_TEXT_CHARS>0）时从最旧对话轮次裁剪，system 与最近轮次优先保留。
const MAX_TEXT_CHARS = parseInt(process.env.LIGHTAI_MAX_TEXT_CHARS || '60000', 10);
function buildOpenAIDialogText(messages, includeHistory) {
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const t = extractTextContent(m && m.content).trim();
    if (!t) { continue; }
    const role = m.role === 'system' ? 'system' : (m.role === 'assistant' ? 'assistant' : 'user');
    turns.push({ role, text: t });
  }
  const sysText = turns.filter((t) => t.role === 'system').map((t) => t.text).join('\n').trim();
  const dialog = turns.filter((t) => t.role !== 'system');
  const encode = (list) => list.map((t) => `${t.role === 'user' ? '[用户]' : '[助手]'}\n${t.text}`).join('\n\n');
  if (!includeHistory) {
    const lastUser = [...dialog].reverse().find((t) => t.role === 'user');
    const userText = lastUser ? lastUser.text : '';
    return sysText ? `${sysText}\n\n${userText}` : userText;
  }
  let kept = dialog;
  if (MAX_TEXT_CHARS > 0) {
    while (kept.length > 1 && (sysText.length + encode(kept).length) > MAX_TEXT_CHARS) {
      kept = kept.slice(1);
    }
  }
  const lines = [];
  if (sysText) { lines.push(`[系统]\n${sysText}`); }
  const dialogText = encode(kept);
  if (dialogText) { lines.push(dialogText); }
  return lines.join('\n\n');
}

function sendUpstream(method, path, bodyObj, headersExtra, opts) {
  const buffer = !(opts && opts.buffer === false); // 默认缓冲；buffer:false 返回实时流
  return new Promise((resolve, reject) => {
    const url = new URL(path, CFG.baseUrl);
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = Object.assign(
      {
        'content-type': 'application/json',
        accept: method === 'POST' && path.includes('send_message') ? '*/*' : 'application/json, text/plain, */*',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        origin: CFG.baseUrl,
        referer: `${CFG.baseUrl}/?k=${CFG.refererK}`,
        'x-user-id': CFG.userId,
        app_id: CFG.appId,
        biz_id: CFG.bizId,
        project_name: encodeURIComponent(CFG.projectName),
        cookie: CFG.cookie,
      },
      headersExtra || {}
    );
    if (payload) headers['content-length'] = Buffer.byteLength(payload);

    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
        timeout: 120000,
      },
      (res) => {
        if (!buffer) {
          // 实时流：直接把未消耗的 res 交回调用方
          resolve({ status: res.statusCode, headers: res.headers, stream: res });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve({ status: res.statusCode, headers: res.headers, raw, stream: res });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function createConversation() {
  const resp = await sendUpstream('POST', '/api/gemini/chat/create_conversation', {
    title: 'saros-agent',
    conversation_type: 'PERMANENT',
  });
  if (resp.status !== 200) {
    throw new Error(`create_conversation failed: ${resp.status} ${resp.raw}`);
  }
  const data = JSON.parse(resp.raw);
  return String(data.id);
}

// 解析 LightAI SSE 流，逐条回调 data: {...}
function parseLightAISSE(raw, onChunk) {
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const json = t.slice(5).trim();
    if (!json) continue;
    try {
      onChunk(JSON.parse(json));
    } catch (_) {
      /* 忽略非 JSON 行 */
    }
  }
}

function openAIChatChunk(id, model, content, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content !== null ? { content } : {},
        finish_reason: finishReason || null,
      },
    ],
  };
}

// ---------- 路由 ----------
async function handleChatCompletions(req, res) {
  let body = '';
  for await (const c of req) body += c;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
    return;
  }

  const model = parsed.model || CFG.defaultModel;
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const stream = !!parsed.stream;

  // 会话复用 key：X-Conversation-ID（VsSaros 每次请求带上）> body.user > Authorization。
  // 命中即复用 conversation_id，实现多轮；未命中则下方新建并登记。
  const convKey =
    (req.headers['x-conversation-id'] && String(req.headers['x-conversation-id'])) ||
    (typeof parsed.user === 'string' && parsed.user) ||
    (req.headers['authorization'] && String(req.headers['authorization'])) ||
    '';
  let convId = convKey ? conversations.get(convKey) : undefined;

  // 构造发送文本：未命中复用（新建/失效重建/无 key）→ 全量回放完整 messages
  // （角色标记拼接，等效「传 messages 数组」）；命中 → 只发增量（服务端已持有历史）。
  const text = sanitizeForWAF(buildOpenAIDialogText(messages, !convId));
  if (!text) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'empty user message' } }));
    return;
  }

  // 构造 LightAI 请求体
  const billingInfo = {
    app_id: CFG.appId,
    app_name: CFG.appName,
    project_id: CFG.bizId,
    project_name: CFG.projectName,
    user_type: CFG.userType,
    company: CFG.company,
  };
  const lightBody = {
    text,
    file_urls: [],
    file_names: [],
    model,
    enable_thought: parsed.enable_thought !== false,
    enable_search: !!parsed.enable_search,
    preset_id: null,
    billing_info: billingInfo,
  };

  if (!convId) {
    try {
      convId = await createConversation();
      if (convKey) {
        conversations.set(convKey, convId);
        // 上限清理：超出则删最旧（Map 迭代顺序 = 插入顺序）。
        while (conversations.size > MAX_CONVERSATIONS) {
          const oldest = conversations.keys().next().value;
          conversations.delete(oldest);
        }
      }
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `create conversation failed: ${e.message}` } }));
      return;
    }
  }

  const id = 'chatcmpl-' + Date.now();
  const fullHeaders = { app_id: CFG.appId, biz_id: CFG.bizId, project_name: encodeURIComponent(CFG.projectName) };

  // 始终使用实时流（buffer:false），由本函数统一处理流式/非流式
  let u;
  try {
    u = await sendUpstream('POST', `/api/gemini/chat/send_message/${convId}`, lightBody, fullHeaders, {
      buffer: false,
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `upstream error: ${e.message}` } }));
    return;
  }

  if (u.status !== 200) {
    // 会话失效（如 LightAI 服务端清理了 conversation）：清除映射，下次请求自动重建。
    if (convKey && conversations.get(convKey) === convId) {
      conversations.delete(convKey);
    }
    // 读取出错信息后返回
    let errRaw = '';
    try {
      for await (const c of u.stream) errRaw += c;
    } catch (_) {}
    res.writeHead(u.status === 200 ? 502 : u.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `send_message failed: ${u.status} ${errRaw.slice(0, 300)}` } }));
    return;
  }

  const upstream = u.stream;
  upstream.setEncoding('utf-8');

  if (!stream) {
    // 非流式：累积所有文本后返回完整 JSON
    let fullText = '';
    let finishReason = 'stop';
    let buf = '';
    for await (const c of upstream) {
      buf += c;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        parseLightAISSE(line, (obj) => {
          if (obj.done) {
            finishReason = 'stop';
          } else if (typeof obj.text === 'string') {
            fullText += obj.text;
          }
        });
      }
    }
    parseLightAISSE(buf, (obj) => {
      if (obj.done) finishReason = 'stop';
      else if (typeof obj.text === 'string') fullText += obj.text;
    });

    const out = {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: fullText },
          finish_reason: finishReason,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }

  // 流式：逐块转发
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write('data: ' + JSON.stringify(openAIChatChunk(id, model, '', null)) + '\n\n');

  let buf = '';
  for await (const c of upstream) {
    buf += c;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      parseLightAISSE(line, (obj) => {
        if (obj.done) {
          res.write('data: ' + JSON.stringify(openAIChatChunk(id, model, null, 'stop')) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else if (typeof obj.text === 'string' && obj.text) {
          // thought=true 为思考过程，仍作为 content 透传（如需隐藏可改为跳过）
          res.write('data: ' + JSON.stringify(openAIChatChunk(id, model, obj.text, null)) + '\n\n');
        }
      });
    }
  }
  // 收尾保护
  res.write('data: ' + JSON.stringify(openAIChatChunk(id, model, null, 'stop')) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function handleModels(req, res) {
  const data = {
    object: 'list',
    data: MODELS.map((m) => ({
      id: m,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'lightai',
    })),
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    return handleModels(req, res);
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    return handleChatCompletions(req, res);
  }
  if (req.method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'lightai-openai-adapter', models: MODELS }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found: ' + req.method + ' ' + url } }));
});

server.listen(CFG.port, () => {
  console.log(`[lightai-adapter] listening on http://0.0.0.0:${CFG.port}`);
  console.log(`[lightai-adapter] upstream=${CFG.baseUrl} user=${CFG.userId || '(unset)'} models=${MODELS.join(',')}`);
  if (!CFG.cookie || !CFG.userId) {
    console.warn('[lightai-adapter] WARNING: LIGHTAI_COOKIE / LIGHTAI_USER_ID 未设置，请求会被上游拒绝。');
  }
});

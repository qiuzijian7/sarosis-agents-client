#!/usr/bin/env node
/**
 * export-bundled-resources.mjs
 * 将 bundledMcpPresets.ts 和 bundledTools.ts 中的硬编码资源导出为 JSON 文件
 * 输出目录：resources/.agents/mcp-presets/*.json 和 resources/.agents/tools/*.json
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const OUT_MCP = resolve(ROOT, 'resources/.agents/mcp-presets');
const OUT_TOOLS = resolve(ROOT, 'resources/.agents/tools');

mkdirSync(OUT_MCP, { recursive: true });
mkdirSync(OUT_TOOLS, { recursive: true });

// ─── MCP Presets ───────────────────────────────────────────────────────────────
// 从 bundledMcpPresets.ts 手工转写（保持与源码完全一致）
const mcpPresets = [
  {
    "id": "codebase-memory-mcp",
    "name": "Codebase Memory",
    "description": "Code intelligence engine: full-indexes repositories into a knowledge graph of functions, classes, call chains, and cross-service links. 14 MCP tools for structural queries.",
    "transportType": "stdio",
    "command": "codebase-memory-mcp",
    "icon": "🧠",
    "builtin": true
  },
  {
    "id": "filesystem",
    "name": "Filesystem",
    "description": "Secure file system access for reading, writing, and searching files",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem"]
  },
  {
    "id": "github",
    "name": "GitHub",
    "description": "GitHub API access for repos, issues, PRs, and more",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "envKeys": ["GITHUB_PERSONAL_ACCESS_TOKEN"]
  },
  {
    "id": "gitlab",
    "name": "GitLab",
    "description": "GitLab API access for projects, issues, MRs, and more",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-gitlab"],
    "envKeys": ["GITLAB_PERSONAL_ACCESS_TOKEN"]
  },
  {
    "id": "postgres",
    "name": "PostgreSQL",
    "description": "PostgreSQL database access with read-only queries",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-postgres"],
    "envKeys": ["POSTGRES_CONNECTION_STRING"]
  },
  {
    "id": "sqlite",
    "name": "SQLite",
    "description": "SQLite database access for queries and schema inspection",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite"]
  },
  {
    "id": "brave-search",
    "name": "Brave Search",
    "description": "Web search using Brave Search API",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "envKeys": ["BRAVE_API_KEY"]
  },
  {
    "id": "puppeteer",
    "name": "Puppeteer",
    "description": "Browser automation using Puppeteer for web scraping and interaction",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-puppeteer"]
  },
  {
    "id": "memory",
    "name": "Memory",
    "description": "Knowledge graph-based persistent memory system",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"]
  },
  {
    "id": "sequential-thinking",
    "name": "Sequential Thinking",
    "description": "Dynamic problem-solving through structured thinking steps",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
  },
  {
    "id": "time",
    "name": "Time",
    "description": "Time and timezone conversion utilities",
    "transportType": "stdio",
    "command": "uvx",
    "args": ["mcp-server-time"]
  },
  {
    "id": "notion",
    "name": "Notion",
    "description": "Notion workspace access for pages, databases, and content",
    "transportType": "http",
    "url": "https://mcp.notion.com/mcp"
  },
  {
    "id": "slack",
    "name": "Slack",
    "description": "Slack workspace access for channels, messages, and users",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"],
    "envKeys": ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"]
  },
  {
    "id": "google-drive",
    "name": "Google Drive",
    "description": "Google Drive file access and search",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-google-drive"]
  },
  {
    "id": "fetch",
    "name": "Fetch",
    "description": "HTTP request tool for fetching web content",
    "transportType": "stdio",
    "command": "uvx",
    "args": ["mcp-server-fetch"]
  },
  {
    "id": "codex",
    "name": "Codex",
    "description": "OpenAI Codex MCP server for code generation",
    "transportType": "stdio",
    "command": "codex",
    "args": ["mcp-server"]
  },
  {
    "id": "everything",
    "name": "MCP Everything",
    "description": "Test server with all MCP features (tools, resources, prompts, sampling)",
    "transportType": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-everything"]
  }
];

// ─── Tools ──────────────────────────────────────────────────────────────────────
// 从 bundledTools.ts 手工转写（保持与源码完全一致）
const tools = [
  {
    "name": "web_search",
    "description": "Search the web for information. Returns search results with titles, URLs, and snippets.",
    "inputSchema": {"type":"object","properties":{"query":{"type":"string","description":"Search query"},"num_results":{"type":"number","description":"Number of results to return (default: 10)"}},"required":["query"]},
    "category": "web",
    "source": "hermes-bundled"
  },
  {
    "name": "web_extract",
    "description": "Extract and summarize content from a web page. Returns the page text content.",
    "inputSchema": {"type":"object","properties":{"url":{"type":"string","description":"URL to extract content from"},"query":{"type":"string","description":"Optional focus query for targeted extraction"}},"required":["url"]},
    "category": "web",
    "source": "hermes-bundled"
  },
  {
    "name": "terminal",
    "description": "Execute a command in the terminal. Supports local, SSH, Docker, Modal, Daytona, and other backends. Returns stdout, stderr, and exit code.",
    "inputSchema": {"type":"object","properties":{"command":{"type":"string","description":"Shell command to execute"},"background":{"type":"boolean","description":"Run command in background (default: false)"},"timeout":{"type":"number","description":"Command timeout in seconds (default: 180)"},"cwd":{"type":"string","description":"Working directory for command execution"},"notify_on_complete":{"type":"boolean","description":"Notify when background command completes (default: true)"}},"required":["command"]},
    "category": "terminal",
    "source": "hermes-bundled"
  },
  {
    "name": "process",
    "description": "Manage background processes: list running processes, get output, or terminate them.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["list","output","terminate","wait"],"description":"Action to perform"},"pid":{"type":"string","description":"Process ID (for output/terminate/wait actions)"}},"required":["action"]},
    "category": "terminal",
    "source": "hermes-bundled"
  },
  {
    "name": "file_read",
    "description": "Read a file and return its content. Supports reading specific line ranges.",
    "inputSchema": {"type":"object","properties":{"path":{"type":"string","description":"Absolute or relative file path"},"start_line":{"type":"number","description":"Start line number (1-based, optional)"},"end_line":{"type":"number","description":"End line number (inclusive, optional)"}},"required":["path"]},
    "category": "file",
    "source": "hermes-bundled"
  },
  {
    "name": "file_write",
    "description": "Write content to a file. Creates the file and parent directories if they don't exist.",
    "inputSchema": {"type":"object","properties":{"path":{"type":"string","description":"File path to write"},"content":{"type":"string","description":"Content to write"}},"required":["path","content"]},
    "category": "file",
    "source": "hermes-bundled"
  },
  {
    "name": "patch",
    "description": "Apply a fuzzy-matched patch to a file. Finds the best match for the search text and replaces it. Safer than file_write for targeted edits.",
    "inputSchema": {"type":"object","properties":{"path":{"type":"string","description":"File path to patch"},"search":{"type":"string","description":"Text to search for (fuzzy matched)"},"replace":{"type":"string","description":"Replacement text"},"replace_all":{"type":"boolean","description":"Replace all occurrences (default: false)"}},"required":["path","search","replace"]},
    "category": "file",
    "source": "hermes-bundled"
  },
  {
    "name": "search_files",
    "description": "Search for a pattern in files. Supports regex and file glob patterns. Returns matching file paths and line content.",
    "inputSchema": {"type":"object","properties":{"path":{"type":"string","description":"Directory to search in"},"pattern":{"type":"string","description":"Search pattern (literal or regex)"},"file_pattern":{"type":"string","description":"Glob pattern to filter files (e.g., \"*.py\")"},"ignore_case":{"type":"boolean","description":"Case-insensitive search (default: true)"},"max_results":{"type":"number","description":"Maximum number of results (default: 50)"}},"required":["path","pattern"]},
    "category": "file",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_navigate",
    "description": "Navigate the browser to a URL. Waits for the page to load and returns a snapshot.",
    "inputSchema": {"type":"object","properties":{"url":{"type":"string","description":"URL to navigate to"}},"required":["url"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_snapshot",
    "description": "Take an accessibility snapshot of the current page. Returns the DOM tree in a structured format for analysis.",
    "inputSchema": {"type":"object","properties":{"ref":{"type":"string","description":"Element reference to snapshot (optional, defaults to full page)"},"raw":{"type":"boolean","description":"Return raw HTML instead of structured snapshot (default: false)"}}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_click",
    "description": "Click an element on the page identified by its reference string from a snapshot.",
    "inputSchema": {"type":"object","properties":{"ref":{"type":"string","description":"Element reference from snapshot to click"}},"required":["ref"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_type",
    "description": "Type text into an input element. Clears existing text first unless append is true.",
    "inputSchema": {"type":"object","properties":{"ref":{"type":"string","description":"Element reference to type into"},"text":{"type":"string","description":"Text to type"},"append":{"type":"boolean","description":"Append to existing text instead of clearing (default: false)"},"submit":{"type":"boolean","description":"Press Enter after typing (default: false)"}},"required":["ref","text"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_scroll",
    "description": "Scroll the page or a specific element in a direction.",
    "inputSchema": {"type":"object","properties":{"direction":{"type":"string","enum":["up","down"],"description":"Scroll direction"},"amount":{"type":"number","description":"Scroll amount in pixels (default: 500)"},"ref":{"type":"string","description":"Element reference to scroll within (optional)"}}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_back",
    "description": "Navigate back in browser history.",
    "inputSchema": {"type":"object","properties":{}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_press",
    "description": "Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown).",
    "inputSchema": {"type":"object","properties":{"key":{"type":"string","description":"Key to press (e.g., \"Enter\", \"Tab\", \"Escape\", \"ArrowDown\")"}},"required":["key"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_get_images",
    "description": "Get all images on the current page with their source URLs and alt text.",
    "inputSchema": {"type":"object","properties":{}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_vision",
    "description": "Take a screenshot of the current page and analyze it with a vision model.",
    "inputSchema": {"type":"object","properties":{"query":{"type":"string","description":"What to look for or analyze in the screenshot"}}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_console",
    "description": "Execute JavaScript in the browser console or view console output.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["execute","logs"],"description":"Action: execute JS or view console logs"},"code":{"type":"string","description":"JavaScript code to execute (for execute action)"}}},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_cdp",
    "description": "Execute Chrome DevTools Protocol commands directly for advanced browser automation.",
    "inputSchema": {"type":"object","properties":{"method":{"type":"string","description":"CDP method name (e.g., \"Runtime.evaluate\", \"DOM.querySelector\")"},"params":{"type":"object","description":"CDP method parameters"}},"required":["method"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "browser_dialog",
    "description": "Handle browser dialogs (alert, confirm, prompt). Accept or dismiss the dialog, optionally providing input text.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["accept","dismiss"],"description":"Action to take on the dialog"},"text":{"type":"string","description":"Text to enter in prompt dialogs (optional)"}},"required":["action"]},
    "category": "browser",
    "source": "hermes-bundled"
  },
  {
    "name": "vision_analyze",
    "description": "Analyze an image using a multimodal vision model. Provide an image URL or base64 data and a query about the image.",
    "inputSchema": {"type":"object","properties":{"image":{"type":"string","description":"Image URL or base64-encoded image data"},"query":{"type":"string","description":"Question or instruction about the image"}},"required":["image","query"]},
    "category": "vision",
    "source": "hermes-bundled"
  },
  {
    "name": "video_analyze",
    "description": "Analyze a video using a multimodal model. Extract frames and understand video content.",
    "inputSchema": {"type":"object","properties":{"video_url":{"type":"string","description":"URL of the video to analyze"},"query":{"type":"string","description":"Question or instruction about the video"}},"required":["video_url","query"]},
    "category": "video",
    "source": "hermes-bundled"
  },
  {
    "name": "image_generate",
    "description": "Generate an image from a text prompt using FLUX or other image generation models.",
    "inputSchema": {"type":"object","properties":{"prompt":{"type":"string","description":"Image generation prompt"},"negative_prompt":{"type":"string","description":"What to avoid in the generated image"},"width":{"type":"number","description":"Image width in pixels (default: 1024)"},"height":{"type":"number","description":"Image height in pixels (default: 1024)"},"num_images":{"type":"number","description":"Number of images to generate (default: 1)"},"image_url":{"type":"string","description":"Reference image URL for image-to-image generation (optional)"}},"required":["prompt"]},
    "category": "image_gen",
    "source": "hermes-bundled"
  },
  {
    "name": "video_generate",
    "description": "Generate a video from a text prompt and optionally an image. Supports text-to-video and image-to-video generation.",
    "inputSchema": {"type":"object","properties":{"prompt":{"type":"string","description":"Video generation prompt"},"image_url":{"type":"string","description":"Reference image URL for image-to-video (optional)"},"duration":{"type":"number","description":"Video duration in seconds (default: 5)"}},"required":["prompt"]},
    "category": "video_gen",
    "source": "hermes-bundled"
  },
  {
    "name": "skills_list",
    "description": "List all available skills with their names, categories, and descriptions.",
    "inputSchema": {"type":"object","properties":{"category":{"type":"string","description":"Filter by category (optional)"}}},
    "category": "skills",
    "source": "hermes-bundled"
  },
  {
    "name": "skill_view",
    "description": "View the full content of a specific skill document by name or ID.",
    "inputSchema": {"type":"object","properties":{"name":{"type":"string","description":"Skill name or ID to view"}},"required":["name"]},
    "category": "skills",
    "source": "hermes-bundled"
  },
  {
    "name": "skill_manage",
    "description": "Create, edit, or delete skill documents. Skills are reusable procedure documents the agent can load.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["create","edit","delete"],"description":"Action to perform"},"name":{"type":"string","description":"Skill name"},"content":{"type":"string","description":"Skill content (for create/edit)"},"category":{"type":"string","description":"Skill category (for create)"}},"required":["action","name"]},
    "category": "skills",
    "source": "hermes-bundled"
  },
  {
    "name": "text_to_speech",
    "description": "Convert text to speech audio. Supports Edge TTS (free), ElevenLabs, OpenAI, MiniMax, Mistral, and xAI providers.",
    "inputSchema": {"type":"object","properties":{"text":{"type":"string","description":"Text to convert to speech"},"voice":{"type":"string","description":"Voice name or ID (provider-dependent)"},"provider":{"type":"string","enum":["edge","elevenlabs","openai","minimax","mistral","xai"],"description":"TTS provider (default: edge)"},"output_path":{"type":"string","description":"File path to save audio (optional)"}},"required":["text"]},
    "category": "tts",
    "source": "hermes-bundled"
  },
  {
    "name": "todo",
    "description": "Manage a task list for tracking multi-step work. Add, list, update, and remove tasks.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["add","list","update","remove","clear"],"description":"Action to perform"},"id":{"type":"string","description":"Task ID (for update/remove)"},"text":{"type":"string","description":"Task description (for add)"},"status":{"type":"string","enum":["pending","in_progress","completed"],"description":"Task status (for update)"}},"required":["action"]},
    "category": "todo",
    "source": "hermes-bundled"
  },
  {
    "name": "memory",
    "description": "Manage persistent memory across sessions. Save and recall personal notes and user profile information.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["save","recall","search","clear"],"description":"Action to perform"},"key":{"type":"string","description":"Memory key or category"},"content":{"type":"string","description":"Memory content to save"},"query":{"type":"string","description":"Search query (for search action)"}},"required":["action"]},
    "category": "memory",
    "source": "hermes-bundled"
  },
  {
    "name": "session_search",
    "description": "Search and recall past conversation sessions. Returns summarized matching sessions.",
    "inputSchema": {"type":"object","properties":{"query":{"type":"string","description":"Search query for past sessions"},"limit":{"type":"number","description":"Maximum number of results (default: 5)"}},"required":["query"]},
    "category": "session_search",
    "source": "hermes-bundled"
  },
  {
    "name": "clarify",
    "description": "Ask the user a clarifying question with multiple-choice or open-ended options. Pauses the agent loop until the user responds.",
    "inputSchema": {"type":"object","properties":{"question":{"type":"string","description":"The question to ask the user"},"options":{"type":"array","items":{"type":"string"},"description":"Multiple-choice options (optional)"}},"required":["question"]},
    "category": "clarify",
    "source": "hermes-bundled"
  },
  {
    "name": "execute_code",
    "description": "Execute a Python script in a sandboxed environment. The script can call other tools via RPC, keeping intermediate results out of the LLM context.",
    "inputSchema": {"type":"object","properties":{"code":{"type":"string","description":"Python code to execute"},"timeout":{"type":"number","description":"Execution timeout in seconds (default: 300)"}},"required":["code"]},
    "category": "code_execution",
    "source": "hermes-bundled"
  },
  {
    "name": "delegate_task",
    "description": "Spawn a subagent with isolated context to handle a specific task. Supports single and batch delegation.",
    "inputSchema": {"type":"object","properties":{"task":{"type":"string","description":"Task description for the subagent"},"tasks":{"type":"array","items":{"type":"string"},"description":"Multiple tasks for batch delegation"},"model":{"type":"string","description":"Model override for the subagent (optional)"},"toolsets":{"type":"array","items":{"type":"string"},"description":"Toolsets to give the subagent (optional)"}}},
    "category": "delegation",
    "source": "hermes-bundled"
  },
  {
    "name": "cronjob",
    "description": "Manage scheduled tasks: create, list, update, pause, resume, and remove cron jobs.",
    "inputSchema": {"type":"object","properties":{"action":{"type":"string","enum":["create","list","update","pause","resume","remove","trigger"],"description":"Action to perform"},"name":{"type":"string","description":"Cron job name"},"schedule":{"type":"string","description":"Cron schedule expression (e.g., \"0 9 * * *\")"},"task":{"type":"string","description":"Task description for the scheduled job"}},"required":["action"]},
    "category": "cronjob",
    "source": "hermes-bundled"
  },
  {
    "name": "send_message",
    "description": "Send a message to a user on a connected messaging platform (Telegram, Discord, Slack, WhatsApp, Signal, etc.).",
    "inputSchema": {"type":"object","properties":{"platform":{"type":"string","description":"Messaging platform (e.g., \"telegram\", \"discord\", \"slack\")"},"chat_id":{"type":"string","description":"Chat/channel ID to send to"},"text":{"type":"string","description":"Message text"}},"required":["text"]},
    "category": "messaging",
    "source": "hermes-bundled"
  },
  {
    "name": "ha_list_entities",
    "description": "List Home Assistant entities with their states. Filter by domain or area.",
    "inputSchema": {"type":"object","properties":{"domain":{"type":"string","description":"Filter by domain (e.g., \"light\", \"switch\", \"sensor\")"},"area":{"type":"string","description":"Filter by area name"}}},
    "category": "homeassistant",
    "source": "hermes-bundled"
  },
  {
    "name": "ha_get_state",
    "description": "Get the current state and attributes of a Home Assistant entity.",
    "inputSchema": {"type":"object","properties":{"entity_id":{"type":"string","description":"Entity ID (e.g., \"light.living_room\")"}},"required":["entity_id"]},
    "category": "homeassistant",
    "source": "hermes-bundled"
  },
  {
    "name": "ha_list_services",
    "description": "List available Home Assistant services, optionally filtered by domain.",
    "inputSchema": {"type":"object","properties":{"domain":{"type":"string","description":"Filter by domain (optional)"}}},
    "category": "homeassistant",
    "source": "hermes-bundled"
  },
  {
    "name": "ha_call_service",
    "description": "Call a Home Assistant service to control devices (e.g., turn on lights, set climate temperature).",
    "inputSchema": {"type":"object","properties":{"domain":{"type":"string","description":"Service domain (e.g., \"light\", \"switch\")"},"service":{"type":"string","description":"Service name (e.g., \"turn_on\", \"toggle\")"},"entity_id":{"type":"string","description":"Target entity ID"},"data":{"type":"object","description":"Additional service data"}},"required":["domain","service"]},
    "category": "homeassistant",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_show",
    "description": "Show the current kanban board with all tasks and their statuses.",
    "inputSchema": {"type":"object","properties":{}},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_list",
    "description": "List kanban tasks, optionally filtered by status or assignee.",
    "inputSchema": {"type":"object","properties":{"status":{"type":"string","description":"Filter by status (optional)"},"assignee":{"type":"string","description":"Filter by assignee (optional)"}}},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_complete",
    "description": "Mark a kanban task as completed with an optional result summary.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to complete"},"result":{"type":"string","description":"Result summary (optional)"}},"required":["task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_block",
    "description": "Block a kanban task, indicating it needs human input or is waiting on a dependency.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to block"},"reason":{"type":"string","description":"Reason for blocking"}},"required":["task_id","reason"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_heartbeat",
    "description": "Send a heartbeat for a kanban task to indicate the agent is still working on it.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to heartbeat"},"progress":{"type":"string","description":"Progress update message (optional)"}},"required":["task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_comment",
    "description": "Add a comment to a kanban task thread.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to comment on"},"comment":{"type":"string","description":"Comment text"}},"required":["task_id","comment"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_create",
    "description": "Create a new kanban task (orchestrator only).",
    "inputSchema": {"type":"object","properties":{"title":{"type":"string","description":"Task title"},"description":{"type":"string","description":"Task description"},"assignee":{"type":"string","description":"Assignee name (optional)"}},"required":["title"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_link",
    "description": "Link a kanban task to a parent or related task.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to link"},"linked_task_id":{"type":"string","description":"Target task ID to link to"}},"required":["task_id","linked_task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_unblock",
    "description": "Unblock a kanban task that was previously blocked.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to unblock"}},"required":["task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_specify",
    "description": "Refine a rough kanban task into a structured specification (Goal / Approach / Acceptance criteria / Out of scope) using an LLM, then move it from triage to todo.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Task ID to specify (full or last-6 short ID)"}},"required":["task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_decompose",
    "description": "Decompose a kanban task into 2-N concrete subtasks using an LLM, creating child tasks with parent dependencies. Use fanout=true for independent/parallel subtasks, false for sequential ones.",
    "inputSchema": {"type":"object","properties":{"task_id":{"type":"string","description":"Parent task ID to decompose (full or last-6 short ID)"},"fanout":{"type":"boolean","description":"true=parallel/independent subtasks (default), false=sequential subtasks"},"max_subtasks":{"type":"number","description":"Maximum number of subtasks (default 6, hard cap 12)"},"assignee":{"type":"string","description":"Default assignee for created subtasks (optional)"}},"required":["task_id"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "kanban_swarm",
    "description": "Spawn a multi-agent swarm to collaboratively accomplish a goal. Creates a kanban topology (root → parallel workers → verifier → synthesizer), runs the workers in parallel as sub-agents, then verifies and synthesizes their outputs into a final result. Workers share a blackboard. Use for complex goals that benefit from parallel specialized agents.",
    "inputSchema": {"type":"object","properties":{"title":{"type":"string","description":"Swarm title (becomes the root task title)"},"goal":{"type":"string","description":"Overall goal description, injected into every worker's context"},"workers":{"description":"Worker specs (at least 1)","items":{"properties":{"body":{"description":"What this worker should do","type":"string"},"priority":{"description":"Scheduling priority","enum":["low","medium","high"],"type":"string"},"profile":{"description":"Worker role/persona (optional)","type":"string"},"title":{"description":"Worker card title","type":"string"}},"required":["title","body"],"type":"object"},"type":"array"},"enable_verifier":{"default":true,"description":"Enable the verifier stage (default true when >=2 workers)","type":"boolean"},"enable_synthesizer":{"default":true,"description":"Enable the synthesizer stage (default true)","type":"boolean"}},"required":["title","workers"]},
    "category": "kanban",
    "source": "hermes-bundled"
  },
  {
    "name": "computer_use",
    "description": "Control a macOS desktop in the background via cua-driver. Supports screenshots, mouse clicks, keyboard input, scrolling, and drag operations without stealing focus.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Action to perform","enum":["screenshot","click","double_click","type","press","scroll","drag","move"],"type":"string"},"coordinate":{"description":"X, Y coordinates for click/scroll/drag","items":{"type":"number"},"type":"array"},"text":{"description":"Text to type (for type action)","type":"string"},"key":{"description":"Key to press (for press action)","type":"string"},"direction":{"description":"Scroll direction","enum":["up","down"],"type":"string"},"amount":{"description":"Scroll amount","type":"number"}},"required":["action"]},
    "category": "computer_use",
    "source": "hermes-bundled"
  },
  {
    "name": "discord",
    "description": "Discord read and participate: fetch messages, search members, create threads.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Action to perform","enum":["fetch_messages","search_members","create_thread","send_message"],"type":"string"},"channel_id":{"description":"Channel ID","type":"string"},"query":{"description":"Search query","type":"string"},"limit":{"description":"Number of messages to fetch (default: 25)","type":"number"}}},
    "category": "discord",
    "source": "hermes-bundled"
  },
  {
    "name": "discord_admin",
    "description": "Discord server administration: list channels/roles, pin messages, assign roles.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Action to perform","enum":["list_channels","list_roles","pin_message","assign_role","unpin_message"],"type":"string"},"channel_id":{"description":"Channel ID","type":"string"},"message_id":{"description":"Message ID","type":"string"},"user_id":{"description":"User ID","type":"string"},"role_id":{"description":"Role ID","type":"string"}}},
    "category": "discord",
    "source": "hermes-bundled"
  },
  {
    "name": "yb_query_group_info",
    "description": "Query Yuanbao group information.",
    "inputSchema": {"type":"object","properties":{"group_id":{"description":"Group ID","type":"string"}},"required":["group_id"]},
    "category": "yuanbao",
    "source": "hermes-bundled"
  },
  {
    "name": "yb_query_group_members",
    "description": "Query members of a Yuanbao group.",
    "inputSchema": {"type":"object","properties":{"group_id":{"description":"Group ID","type":"string"}},"required":["group_id"]},
    "category": "yuanbao",
    "source": "hermes-bundled"
  },
  {
    "name": "yb_send_dm",
    "description": "Send a direct message to a Yuanbao user.",
    "inputSchema": {"type":"object","properties":{"user_id":{"description":"User ID","type":"string"},"text":{"description":"Message text","type":"string"}},"required":["user_id","text"]},
    "category": "yuanbao",
    "source": "hermes-bundled"
  },
  {
    "name": "yb_search_sticker",
    "description": "Search for a sticker on Yuanbao.",
    "inputSchema": {"type":"object","properties":{"query":{"description":"Sticker search query","type":"string"}},"required":["query"]},
    "category": "yuanbao",
    "source": "hermes-bundled"
  },
  {
    "name": "yb_send_sticker",
    "description": "Send a sticker in a Yuanbao chat.",
    "inputSchema": {"type":"object","properties":{"chat_id":{"description":"Chat ID","type":"string"},"sticker_id":{"description":"Sticker ID","type":"string"}},"required":["chat_id","sticker_id"]},
    "category": "yuanbao",
    "source": "hermes-bundled"
  },
  {
    "name": "feishu_doc_read",
    "description": "Read the content of a Feishu/Lark document.",
    "inputSchema": {"type":"object","properties":{"doc_id":{"description":"Feishu document ID or URL","type":"string"}},"required":["doc_id"]},
    "category": "feishu",
    "source": "hermes-bundled"
  },
  {
    "name": "feishu_drive_list_comments",
    "description": "List comments on a Feishu/Lark drive file.",
    "inputSchema": {"type":"object","properties":{"file_id":{"description":"File ID","type":"string"},"file_type":{"description":"File type (e.g., \"doc\", \"sheet\")","type":"string"}},"required":["file_id","file_type"]},
    "category": "feishu",
    "source": "hermes-bundled"
  },
  {
    "name": "feishu_drive_list_comment_replies",
    "description": "List replies to a comment on a Feishu/Lark drive file.",
    "inputSchema": {"type":"object","properties":{"comment_id":{"description":"Comment ID","type":"string"},"file_id":{"description":"File ID","type":"string"},"file_type":{"description":"File type","type":"string"}},"required":["file_id","comment_id","file_type"]},
    "category": "feishu",
    "source": "hermes-bundled"
  },
  {
    "name": "feishu_drive_reply_comment",
    "description": "Reply to a comment on a Feishu/Lark drive file.",
    "inputSchema": {"type":"object","properties":{"content":{"description":"Reply content","type":"string"},"comment_id":{"description":"Comment ID","type":"string"},"file_id":{"description":"File ID","type":"string"},"file_type":{"description":"File type","type":"string"}},"required":["file_id","comment_id","content","file_type"]},
    "category": "feishu",
    "source": "hermes-bundled"
  },
  {
    "name": "feishu_drive_add_comment",
    "description": "Add a comment to a Feishu/Lark drive file.",
    "inputSchema": {"type":"object","properties":{"content":{"description":"Comment content","type":"string"},"file_id":{"description":"File ID","type":"string"},"file_type":{"description":"File type","type":"string"}},"required":["file_id","content","file_type"]},
    "category": "feishu",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_playback",
    "description": "Control Spotify playback: play, pause, skip, previous, seek, set volume.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Playback action","enum":["play","pause","next","previous","seek","volume","shuffle","repeat"],"type":"string"},"position_ms":{"description":"Position in milliseconds (for seek)","type":"number"},"volume_percent":{"description":"Volume percentage 0-100 (for volume)","type":"number"}},"required":["action"]},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_devices",
    "description": "List available Spotify devices for playback.",
    "inputSchema": {"type":"object","properties":{}},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_queue",
    "description": "Manage Spotify playback queue: view queue or add tracks.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Queue action","enum":["list","add"],"type":"string"},"uri":{"description":"Spotify URI to add (for add action)","type":"string"}}},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_search",
    "description": "Search Spotify for tracks, albums, artists, or playlists.",
    "inputSchema": {"type":"object","properties":{"query":{"description":"Search query","type":"string"},"type":{"default":"track","description":"Type of results (default: track)","enum":["track","album","artist","playlist"],"type":"string"},"limit":{"default":10,"description":"Max results (default: 10)","type":"number"}},"required":["query"]},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_playlists",
    "description": "Manage Spotify playlists: list, create, add tracks, remove tracks.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Playlist action","enum":["list","create","add_track","remove_track"],"type":"string"},"name":{"description":"Playlist name (for create)","type":"string"},"playlist_id":{"description":"Playlist ID","type":"string"},"track_uri":{"description":"Track URI to add/remove","type":"string"}}},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_albums",
    "description": "Get album information from Spotify.",
    "inputSchema": {"type":"object","properties":{"album_id":{"description":"Spotify album ID","type":"string"}},"required":["album_id"]},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "spotify_library",
    "description": "Manage Spotify library: save/remove tracks, check saved status.",
    "inputSchema": {"type":"object","properties":{"action":{"description":"Library action","enum":["saved_tracks","save_track","remove_track","contains"],"type":"string"},"track_id":{"description":"Track ID (for save/remove/contains)","type":"string"}}},
    "category": "spotify",
    "source": "hermes-bundled"
  },
  {
    "name": "memory_remember",
    "description": "Save a memory entry (short-term or long-term). Use this to persist important information across sessions.",
    "inputSchema": {"type":"object","properties":{"content":{"description":"Memory content to save","type":"string"},"memory_type":{"default":"long_term","description":"Memory type (default: long_term)","enum":["short_term","long_term"],"type":"string"},"tags":{"description":"Optional tags for filtering","items":{"type":"string"},"type":"array"}},"required":["content"]},
    "category": "memory",
    "source": "hermes-bundled"
  },
  {
    "name": "memory_search",
    "description": "Search memories by keyword or tag. Returns matching entries sorted by recency.",
    "inputSchema": {"type":"object","properties":{"query":{"description":"Search query. Supports: tag:foo, type:short, type:long","type":"string"},"limit":{"default":10,"description":"Max results (default: 10)","type":"number"}},"required":["query"]},
    "category": "memory",
    "source": "hermes-bundled"
  },
  {
    "name": "memory_delete",
    "description": "Delete a memory entry by its ID. Use memory_search first to find the entry ID.",
    "inputSchema": {"type":"object","properties":{"id":{"description":"Memory entry ID to delete","type":"string"},"memory_type":{"description":"Memory type to delete from","enum":["short_term","long_term"],"type":"string"}},"required":["id","memory_type"]},
    "category": "memory",
    "source": "hermes-bundled"
  },
  {
    "name": "memory_list",
    "description": "List all memory entries of a given type.",
    "inputSchema": {"type":"object","properties":{"limit":{"default":20,"description":"Max entries to return (default: 20)","type":"number"},"memory_type":{"default":"long_term","description":"Memory type to list (default: long_term)","enum":["short_term","long_term"],"type":"string"}}},
    "category": "memory",
    "source": "hermes-bundled"
  }
];

// ─── Toolsets ───────────────────────────────────────────────────────────────────
const toolsets = {
  "web": {
    "description": "Web research and content extraction",
    "tools": ["web_search", "web_extract"],
    "includes": []
  },
  "terminal": {
    "description": "Terminal/command execution",
    "tools": ["terminal", "process"],
    "includes": []
  },
  "file": {
    "description": "File manipulation",
    "tools": ["file_read", "file_write", "patch", "search_files"],
    "includes": []
  },
  "browser": {
    "description": "Browser automation",
    "tools": ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_back", "browser_press", "browser_get_images", "browser_vision", "browser_console", "browser_cdp", "browser_dialog"],
    "includes": []
  },
  "vision": {
    "description": "Image analysis",
    "tools": ["vision_analyze"],
    "includes": []
  },
  "video": {
    "description": "Video analysis",
    "tools": ["video_analyze"],
    "includes": []
  },
  "image_gen": {
    "description": "Image generation",
    "tools": ["image_generate"],
    "includes": []
  },
  "video_gen": {
    "description": "Video generation",
    "tools": ["video_generate"],
    "includes": []
  },
  "skills": {
    "description": "Skill management",
    "tools": ["skills_list", "skill_view", "skill_manage"],
    "includes": []
  },
  "tts": {
    "description": "Text-to-speech",
    "tools": ["text_to_speech"],
    "includes": []
  },
  "todo": {
    "description": "Task planning",
    "tools": ["todo"],
    "includes": []
  },
  "memory": {
    "description": "Persistent memory",
    "tools": ["memory_remember", "memory_search", "memory_delete", "memory_list"],
    "includes": []
  },
  "session_search": {
    "description": "Session search",
    "tools": ["session_search"],
    "includes": []
  },
  "clarity": {
    "description": "Clarifying questions",
    "tools": ["clarify"],
    "includes": []
  },
  "code_execution": {
    "description": "Code execution sandbox",
    "tools": ["execute_code"],
    "includes": []
  },
  "delegation": {
    "description": "Subagent delegation",
    "tools": ["delegate_task"],
    "includes": []
  },
  "cronjob": {
    "description": "Scheduled tasks",
    "tools": ["cronjob"],
    "includes": []
  },
  "messaging": {
    "description": "Cross-platform messaging",
    "tools": ["send_message"],
    "includes": []
  },
  "homeassistant": {
    "description": "Home Assistant control",
    "tools": ["ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service"],
    "includes": []
  },
  "kanban": {
    "description": "Kanban multi-agent coordination",
    "tools": ["kanban_show", "kanban_list", "kanban_complete", "kanban_block", "kanban_heartbeat", "kanban_comment", "kanban_create", "kanban_link", "kanban_unblock", "kanban_specify", "kanban_decompose", "kanban_swarm"],
    "includes": []
  },
  "computer_use": {
    "description": "macOS desktop control",
    "tools": ["computer_use"],
    "includes": []
  },
  "discord": {
    "description": "Discord tools",
    "tools": ["discord", "discord_admin"],
    "includes": []
  },
  "yuanbao": {
    "description": "Yuanbao platform",
    "tools": ["yb_query_group_info", "yb_query_group_members", "yb_send_dm", "yb_search_sticker", "yb_send_sticker"],
    "includes": []
  },
  "feishu": {
    "description": "Feishu/Lark",
    "tools": ["feishu_doc_read", "feishu_drive_list_comments", "feishu_drive_list_comment_replies", "feishu_drive_reply_comment", "feishu_drive_add_comment"],
    "includes": []
  },
  "spotify": {
    "description": "Spotify playback",
    "tools": ["spotify_playback", "spotify_devices", "spotify_queue", "spotify_search", "spotify_playlists", "spotify_albums", "spotify_library"],
    "includes": []
  }
};

// ─── Write MCP preset files ────────────────────────────────────────────────────
for (const preset of mcpPresets) {
  const filePath = resolve(OUT_MCP, `${preset.id}.json`);
  writeFileSync(filePath, JSON.stringify(preset, null, 2), 'utf-8');
  console.log(`✓ MCP preset: ${preset.id}.json`);
}
console.log(`\nTotal MCP presets: ${mcpPresets.length}`);

// ─── Write Tool files ──────────────────────────────────────────────────────────
for (const tool of tools) {
  const filePath = resolve(OUT_TOOLS, `${tool.name}.json`);
  writeFileSync(filePath, JSON.stringify(tool, null, 2), 'utf-8');
  console.log(`✓ Tool: ${tool.name}.json`);
}
console.log(`\nTotal tools: ${tools.length}`);

// ─── Write Toolsets file ──────────────────────────────────────────────────────
const toolsetsPath = resolve(OUT_TOOLS, '_toolsets.json');
writeFileSync(toolsetsPath, JSON.stringify(toolsets, null, 2), 'utf-8');
console.log(`\n✓ Toolsets: _toolsets.json`);

console.log('\nDone!');

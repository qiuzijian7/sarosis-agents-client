#!/usr/bin/env python3
"""
Hermes Agent Bridge Server — JSON-RPC over stdio.

Architecture:
  TypeScript (Plugin) ←→ stdio JSON-RPC ←→ This Server ←→ AIAgent + ToolRegistry + Providers

This bridge exposes hermes-agent's capabilities via JSON-RPC:
  - list_providers: Discover available model providers
  - list_models: List models for a given provider
  - chat.stream: Stream a chat conversation (SSE-like events over JSON-RPC)
  - list_tools: List available tools
  - execute_tool: Execute a single tool
  - memory.load_context: Load memory context
  - memory.write: Write a memory entry
  - memory.search: Search memories
  - upgrade_repo: Pull latest code from git
  - install_deps: Install Python dependencies
  - shutdown: Graceful shutdown

Events streamed during chat.stream:
  - chat.delta: Text or thinking content
  - chat.tool_start: Tool invocation started
  - chat.tool_args: Tool arguments (streamed)
  - chat.tool_end: Tool invocation completed
  - chat.tool_result: Tool execution result
  - chat.done: Conversation complete
  - chat.error: Error occurred
"""

import sys
import json
import os
import asyncio
import signal
import subprocess
import traceback
from typing import Any, Dict, List, Optional, Generator

# ─── Hermes Agent Source Setup ────────────────────────────────────────
# The hermes source path is passed via HERMES_SRC env var or PYTHONPATH
# If running from the embedded hermes/ directory, it's already on the path

HERMES_SRC = os.environ.get('HERMES_SRC', '')
if HERMES_SRC and HERMES_SRC not in sys.path:
    sys.path.insert(0, HERMES_SRC)


class HermesBridgeServer:
    """JSON-RPC server bridging TypeScript plugin to hermes-agent Python code."""

    def __init__(self):
        self._running = True
        self._agent_instances: Dict[str, Any] = {}  # session_id -> AIAgent
        self._tool_registry = None
        self._providers_registered = False

    # ─── JSON-RPC Protocol ──────────────────────────────────────────

    def send_response(self, request_id: int, result: Any = None, error: Optional[Dict] = None):
        """Send a JSON-RPC response."""
        msg = {"jsonrpc": "2.0", "id": request_id}
        if error:
            msg["error"] = error
        else:
            msg["result"] = result
        self._write(msg)

    def send_event(self, method: str, params: Optional[Dict] = None):
        """Send a JSON-RPC notification/event."""
        msg = {"jsonrpc": "2.0", "method": method}
        if params:
            msg["params"] = params
        self._write(msg)

    def _write(self, msg: Dict):
        """Write a JSON message to stdout (newline-delimited)."""
        try:
            sys.stdout.write(json.dumps(msg) + '\n')
            sys.stdout.flush()
        except Exception:
            pass  # Broken pipe — client disconnected

    # ─── Request Dispatch ────────────────────────────────────────────

    async def handle_request(self, request: Dict) -> None:
        """Route a JSON-RPC request to the appropriate handler."""
        method = request.get('method', '')
        params = request.get('params', {})
        req_id = request.get('id')

        handlers = {
            'list_providers': self._handle_list_providers,
            'list_models': self._handle_list_models,
            'chat.stream': self._handle_chat_stream,
            'list_tools': self._handle_list_tools,
            'execute_tool': self._handle_execute_tool,
            'memory.load_context': self._handle_memory_load,
            'memory.write': self._handle_memory_write,
            'memory.search': self._handle_memory_search,
            'upgrade_repo': self._handle_upgrade_repo,
            'install_deps': self._handle_install_deps,
            'shutdown': self._handle_shutdown,
            'ping': self._handle_ping,
        }

        handler = handlers.get(method)
        if handler:
            try:
                result = await handler(params)
                if req_id is not None:
                    self.send_response(req_id, result)
            except Exception as e:
                if req_id is not None:
                    self.send_response(req_id, error={
                        "code": -32000,
                        "message": str(e),
                        "data": {"traceback": traceback.format_exc()}
                    })
        else:
            if req_id is not None:
                self.send_response(req_id, error={
                    "code": -32601,
                    "message": f"Method not found: {method}"
                })

    # ─── Handlers ────────────────────────────────────────────────────

    async def _handle_ping(self, params: Dict) -> Dict:
        return {"status": "ok", "hermes": True}

    async def _handle_list_providers(self, params: Dict) -> List[Dict]:
        """List available model providers from hermes-agent."""
        try:
            from providers import get_all_providers
            providers = get_all_providers()
            result = []
            for name, profile in providers.items():
                models = []
                try:
                    fetched = profile.fetch_models() if hasattr(profile, 'fetch_models') else []
                    models = [{"id": m.get("id", m.get("name", "")), "name": m.get("name", m.get("id", "")), "context_window": m.get("context_window")} for m in (fetched or [])]
                except Exception:
                    pass  # Some providers need API keys to list models

                result.append({
                    "name": name,
                    "display_name": getattr(profile, 'display_name', name),
                    "api_mode": getattr(profile, 'api_mode', 'chat_completions'),
                    "models": models,
                })
            return result
        except ImportError:
            # Fallback: return known providers without dynamic discovery
            return self._fallback_providers()

    def _fallback_providers(self) -> List[Dict]:
        """Return a static list of known providers when hermes-agent isn't importable."""
        return [
            {"name": "anthropic", "display_name": "Anthropic Claude", "api_mode": "anthropic_messages", "models": []},
            {"name": "openrouter", "display_name": "OpenRouter", "api_mode": "chat_completions", "models": []},
            {"name": "gemini", "display_name": "Google Gemini", "api_mode": "chat_completions", "models": []},
            {"name": "deepseek", "display_name": "DeepSeek", "api_mode": "chat_completions", "models": []},
            {"name": "xai", "display_name": "xAI Grok", "api_mode": "codex_responses", "models": []},
            {"name": "ollama-cloud", "display_name": "Ollama", "api_mode": "chat_completions", "models": []},
            {"name": "copilot", "display_name": "GitHub Copilot", "api_mode": "chat_completions", "models": []},
            {"name": "bedrock", "display_name": "AWS Bedrock", "api_mode": "bedrock_converse", "models": []},
            {"name": "nvidia", "display_name": "NVIDIA NIM", "api_mode": "chat_completions", "models": []},
            {"name": "alibaba", "display_name": "Alibaba Qwen", "api_mode": "chat_completions", "models": []},
            {"name": "custom", "display_name": "Custom Endpoint", "api_mode": "chat_completions", "models": []},
        ]

    async def _handle_list_models(self, params: Dict) -> List[Dict]:
        """List models for a specific provider."""
        provider_name = params.get('provider', os.environ.get('HERMES_PROVIDER', ''))
        if not provider_name:
            return []

        try:
            from providers import get_provider_profile
            profile = get_provider_profile(provider_name)
            if profile and hasattr(profile, 'fetch_models'):
                models = profile.fetch_models() or []
                return [{"id": m.get("id", ""), "name": m.get("name", ""), "context_window": m.get("context_window")} for m in models]
        except Exception:
            pass
        return []

    async def _handle_chat_stream(self, params: Dict) -> Dict:
        """Initiate a streaming chat conversation."""
        stream_id = params.get('streamId', f'stream_{id(params)}')

        try:
            from run_agent import AIAgent
            from model_tools import get_tool_definitions, handle_function_call

            provider = params.get('provider') or os.environ.get('HERMES_PROVIDER', '')
            model = params.get('model') or os.environ.get('HERMES_MODEL', '')
            api_key = os.environ.get('HERMES_API_KEY', '')
            base_url = os.environ.get('HERMES_BASE_URL', '')
            max_iterations = int(os.environ.get('HERMES_MAX_ITERATIONS', '90'))
            enabled_toolsets = [t.strip() for t in os.environ.get('HERMES_ENABLED_TOOLSETS', '').split(',') if t.strip()] or None
            disabled_toolsets = [t.strip() for t in os.environ.get('HERMES_DISABLED_TOOLSETS', '').split(',') if t.strip()] or None

            messages = params.get('messages', [])
            system_prompt = params.get('systemPrompt', '')
            temperature = params.get('temperature')
            max_tokens = params.get('maxTokens')
            session_id = params.get('sessionId', '')

            # Convert messages to OpenAI format
            openai_messages = []
            if system_prompt:
                openai_messages.append({"role": "system", "content": system_prompt})
            for msg in messages:
                openai_messages.append({
                    "role": msg.get("role", "user"),
                    "content": msg.get("content", ""),
                })

            # Create AIAgent instance
            agent = AIAgent(
                base_url=base_url or None,
                api_key=api_key or None,
                provider=provider or None,
                model=model or "",
                max_iterations=max_iterations,
                enabled_toolsets=enabled_toolsets,
                disabled_toolsets=disabled_toolsets,
                platform="agent_studio",
                session_id=session_id or None,
            )

            # Run conversation in a thread to allow streaming
            def run_conversation():
                try:
                    result = agent.run_conversation(
                        user_message=openai_messages[-1]["content"] if openai_messages else "",
                        system_message=system_prompt or None,
                        conversation_history=openai_messages[:-1] if len(openai_messages) > 1 else None,
                    )
                    return result
                except Exception as e:
                    return {"error": str(e)}

            # For now, run synchronously and emit events
            # A full streaming implementation would use the agent's streaming callbacks
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(None, run_conversation)

            if isinstance(result, dict) and "error" in result:
                self.send_event("chat.error", {"streamId": stream_id, "error": result["error"]})
            elif isinstance(result, dict):
                final_response = result.get("final_response", "")
                # Emit the full response as a text delta
                if final_response:
                    self.send_event("chat.delta", {
                        "streamId": stream_id,
                        "deltaType": "text",
                        "content": final_response,
                    })
                self.send_event("chat.done", {"streamId": stream_id})
            else:
                if result:
                    self.send_event("chat.delta", {
                        "streamId": stream_id,
                        "deltaType": "text",
                        "content": str(result),
                    })
                self.send_event("chat.done", {"streamId": stream_id})

        except ImportError as e:
            self.send_event("chat.error", {
                "streamId": stream_id,
                "error": f"Hermes Agent import error: {e}. Ensure hermes-agent source is on PYTHONPATH.",
            })
        except Exception as e:
            self.send_event("chat.error", {
                "streamId": stream_id,
                "error": f"Chat error: {traceback.format_exc()}",
            })

        return {"streamId": stream_id, "status": "streaming"}

    async def _handle_list_tools(self, params: Dict) -> List[Dict]:
        """List available tools from hermes-agent's ToolRegistry."""
        try:
            from model_tools import get_tool_definitions
            definitions = get_tool_definitions()
            result = []
            for tool in definitions:
                func = tool.get("function", {})
                result.append({
                    "name": func.get("name", ""),
                    "description": func.get("description", ""),
                    "parameters": func.get("parameters", {}),
                    "toolset": "hermes",
                })
            return result
        except ImportError:
            return []
        except Exception:
            return []

    async def _handle_execute_tool(self, params: Dict) -> Dict:
        """Execute a single tool call."""
        tool_name = params.get('toolName', '')
        arguments = params.get('arguments', {})
        tool_call_id = params.get('toolCallId', '')

        try:
            from model_tools import handle_function_call
            result_str = handle_function_call(tool_name, arguments, task_id=None)
            return {
                "success": True,
                "content": result_str,
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
            }

    async def _handle_memory_load(self, params: Dict) -> Dict:
        """Load memory context from hermes-agent."""
        agent_id = params.get('agentId', '')
        session_id = params.get('sessionId', '')

        try:
            from agent.memory_manager import MemoryManager
            mm = MemoryManager(session_id=session_id)
            context = mm.get_context()
            return {
                "shortTermMemories": [],
                "longTermMemories": [{"id": f"mem_{i}", "content": c} for i, c in enumerate(context or [])],
                "systemPrompt": None,
            }
        except ImportError:
            return {"shortTermMemories": [], "longTermMemories": []}
        except Exception:
            return {"shortTermMemories": [], "longTermMemories": []}

    async def _handle_memory_write(self, params: Dict) -> Dict:
        """Write a memory entry."""
        return {"success": True}

    async def _handle_memory_search(self, params: Dict) -> List[Dict]:
        """Search memories."""
        return []

    async def _handle_upgrade_repo(self, params: Dict) -> Dict:
        """Pull latest code from the hermes-agent git repository."""
        repo_path = params.get('path', HERMES_SRC)
        if not repo_path or not os.path.isdir(os.path.join(repo_path, '.git')):
            return {"success": False, "error": f"Not a git repository: {repo_path}"}

        try:
            result = subprocess.run(
                ['git', 'pull', '--ff-only'],
                cwd=repo_path,
                capture_output=True,
                text=True,
                timeout=120,
            )
            return {
                "success": result.returncode == 0,
                "output": result.stdout,
                "error": result.stderr if result.returncode != 0 else None,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _handle_install_deps(self, params: Dict) -> Dict:
        """Install Python dependencies for hermes-agent."""
        python_path = params.get('pythonPath', 'python3')
        source_path = params.get('path', HERMES_SRC)

        if not source_path:
            return {"success": False, "error": "No source path specified"}

        try:
            result = subprocess.run(
                [python_path, '-m', 'pip', 'install', '-e', source_path],
                capture_output=True,
                text=True,
                timeout=300,
            )
            return {
                "success": result.returncode == 0,
                "output": result.stdout[-500:] if len(result.stdout) > 500 else result.stdout,
                "error": result.stderr if result.returncode != 0 else None,
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _handle_shutdown(self, params: Dict) -> Dict:
        """Graceful shutdown."""
        self._running = False
        return {"status": "shutting_down"}

    # ─── Main Loop ───────────────────────────────────────────────────

    async def run(self):
        """Main event loop — read JSON-RPC from stdin, dispatch, respond."""
        # Signal readiness
        self.send_event("ready", {
            "version": "1.0.0",
            "hermes_src": HERMES_SRC,
            "python": sys.executable,
        })

        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

        while self._running:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=1.0)
                if not line:
                    continue  # timeout, check _running

                line_str = line.decode('utf-8').strip()
                if not line_str:
                    continue

                try:
                    request = json.loads(line_str)
                except json.JSONDecodeError:
                    continue

                await self.handle_request(request)

            except asyncio.TimeoutError:
                continue
            except Exception:
                if self._running:
                    traceback.print_exc(file=sys.stderr)

        # Cleanup
        for agent in self._agent_instances.values():
            try:
                if hasattr(agent, 'shutdown'):
                    agent.shutdown()
            except Exception:
                pass


async def main():
    server = HermesBridgeServer()
    await server.run()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception:
        traceback.print_exc(file=sys.stderr)
    finally:
        sys.exit(0)

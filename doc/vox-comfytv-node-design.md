# Vox ComfyTV 节点设计方案

> 目标：制作可在 AgentStudio 工作流节点中**编辑参数并真正生成口播视频**的 vox 节点。
> 关联项目：`G:\CustomWorkspaces\AIProjects\vox-ai-motion-graphics-generator`（Agent Skill，Python + MuAPI + ffmpeg）。

---

## 一、现状诊断（为什么现有 vox 节点不可用）

`registry.ts:541-605` 已注册三个 vox 节点：

| 节点 | type | 现状 |
|---|---|---|
| 口播脚本 | `Vox.ScriptStage` | schema 空壳，走 ComfyUI 后端 |
| vox 图像生成 | `Vox.ImageStage` | schema 空壳 |
| vox 视频生成 | `Vox.VideoStage` | schema 空壳 |

**核心问题**：

1. **执行路径错误**：三个节点 `kind='schema'`，走 `runStageWorkflow`（ComfyUI `/prompt` 后端）。但 `builtinWorkflows/voxWorkflows.ts` 里的 `api_json` 是**占位符**（`VoxSaveImages` / `VoxImageToVideo` 等 `class_type` 在 vox 源码里**根本不存在**——vox 是 Python 脚本 + MuAPI，不是 ComfyUI 插件）。
2. **缺两个阶段**：vox 的 B-roll 管道是 `脚本 → 关键帧 → 动效 → 旁白+配乐 → 合成`，现有三节点只映射了前三个，**缺 `audio.py`（旁白 TTS）和 `assemble.py`（合成）**。
3. **参数残缺**：现有 widgets 对齐了图像/视频参数，但**缺口播核心参数**（`voice_id` / `music` / `caption_style` / `speed`）。
4. **无本地执行通道**：vox 真实能力在 `scripts/*.py`（调 MuAPI + ffmpeg），本项目节点没有「调本地 Python 脚本」的路径。

---

## 二、目标

1. 新增**可用**的 vox 节点，在工作流里编辑参数 → 点运行 → 产出 `final.mp4` 口播视频。
2. 复用 vox 现有 Python 管道（`keyframes.py → clips.py → audio.py → assemble.py`），不重写 MuAPI 调用。
3. 复用本项目现有 IPC 通道（`RequestType` + `_dispatch` + 主进程 `child_process.spawn`，已有 `comfy.launch` / `confightml.runTerminal` 先例）。

---

## 三、架构设计

### 3.1 执行路径：本地 Python pipeline（新增 bridge）

```
webview 工作流节点
  │  runNodeOrStage → isVoxDirectorNode → runVoxDirectorNode()
  │
  ├─ 1. 收集参数（widgets + 上游 texts 选题）→ 组装 vox 参数 JSON
  ├─ 2. IPC 请求 'vox.run'（payload: { projectId, topic, params }）
  │       ↓ postMessage
  │   主进程 _dispatch case 'vox.run' → _handleVoxRun()
  │       ├─ 定位 vox 项目路径 + Python 路径 + MUAPI_API_KEY（settings 覆盖，类 comfy.getLaunchPaths）
  │       ├─ 写 out/<projectId>/beats.json
  │       ├─ spawn python scripts/vox_pipeline.py out/<projectId>
  │       ├─ stdout 解析 [PROGRESS] → EventType 'vox.progress' 流式回传
  │       └─ 完成 → return { finalMp4Path, beats, intermediates }
  │       ↓
  ├─ 3. webview 收到 finalMp4Path
  ├─ 4. 归档 COMFYTV_VIDEO 快照（store.put，media.kind='video', ref=finalMp4Path）
  └─ 5. 返回 SingleNodeRunResult（卡片 OUTPUT 显示视频）
```

### 3.2 节点形态：单节点「口播视频导演」+ 保留三节点为高级模式

**主推单节点 `Vox.DirectorStage`**（一个节点 = 一次完整 pipeline）：
- 简单：用户一次配置，一键生成
- 进度清晰：单个 Python 进程串完整管道，`[PROGRESS]` 单调推进
- 中间产物（关键帧海报、旁白 mp3）作为节点 OUTPUT 的次级快照可选展示

**保留现有三节点**（`Vox.ScriptStage / ImageStage / VideoStage`）作为二期「分阶段模式」，通过 `out/<projectId>/beats.json` + 文件系统产物做跨节点状态传递（本次不实现，避免跨进程状态同步复杂度）。

### 3.3 beats.json 由谁生成

vox 的 `beats.json` 原本由 agent（LLM）写。节点场景下有三条来源，按优先级：

1. **上游 `texts` 端口**已接入且是合法 beats JSON → 直接复用（用户可先用 `Saros.Prompt` 节点生成结构化脚本）；
2. 否则用 **topic（选题文本）** → 主进程脚本内用简单模板生成 beats.json（每个 beat = topic 的一个分论点），或调 MuAPI 的 LLM；
3. 兜底：单 beat 模板（topic 作为唯一 narration）。

> 一期采用「topic 模板化生成 beats.json」+「上游 beats JSON 透传」两条路，不引入 LLM 脚本生成（避免依赖额外的 story 模型）。

---

## 四、节点设计

### 4.1 节点定义（`Vox.DirectorStage`）

```ts
registerNodeSpec({
	type: 'Vox.DirectorStage',
	kind: 'schema',                    // 复用 schema 渲染，但执行走 vox 专用分支
	title: '口播视频导演',
	category: 'vox',
	inputs: [{ name: 'texts', type: 'COMFYTV_TEXT' }],   // 选题 / 上游 beats JSON
	outputs: [{ name: 'video', type: 'COMFYTV_VIDEO' }], // final.mp4
	widgets: [ /* 见参数映射 */ ],
	color: '#f97316',
	comfyTV: { stageKind: 'vox-director', workflowKind: 'vox-director' },
});
```

### 4.2 参数映射（widgets → beats.json → vox 脚本）

| 节点 widget | 类型 | 默认 | beats.json 字段 | vox 阶段 |
|---|---|---|---|---|
| `topic`（选题） | TEXT | '' | beats[].narration + scene | 脚本 |
| `beats_count` | INT | 5 (1-12) | beats 数量 | 脚本 |
| `aspect` | COMBO | 9:16 | aspect | keyframes + assemble |
| `language` | COMBO | zh | language | 脚本 + audio |
| `theme` | COMBO | american-retro | theme | keyframes |
| `voice_id` | TEXT | Q19bea09caa6IRAeW7 | voice.voice_id | audio |
| `speed` | FLOAT | 1.0 (0.5-2.0) | voice.speed | audio |
| `music` | TEXT | ''（默认提示词） | music | audio |
| `video_model` | COMBO | veo3.1-image-to-video | video_model | clips |
| `camera_move` | COMBO | static | camera_move | clips |
| `motion_style` | COMBO | calm | motion_style | clips |
| `duration` | INT | 4 (1-12) | duration | clips |
| `caption_style` | COMBO | white | caption_style | assemble |
| `api_key` | TEXT | ''（env 兜底） | env MUAPI_API_KEY | 所有 MuAPI 调用 |

> `theme` 选项从 `vox/scripts/styles.py` 的 `STYLE_BASES` 提取（tang/song/ming/qing/modern/rising + american-retro 等）。

---

## 五、文件清单

### 5.1 vox 项目（`vox-ai-motion-graphics-generator/`）

| 文件 | 动作 | 说明 |
|---|---|---|
| `scripts/vox_pipeline.py` | **新增** | 入口脚本：读 beats.json → 串 keyframes→clips→audio→assemble → `[PROGRESS] <stage> <i>/<n>` 到 stdout |

### 5.2 本项目主进程

| 文件 | 动作 | 说明 |
|---|---|---|
| `browser/messageProtocol.ts` | 改 | RequestType + `'vox.run'`/`'vox.checkDeps'`/`'vox.cancel'`；EventType + `'vox.progress'`；payload 类型 |
| `browser/agentStudioWebviewController.ts` | 改 | `_dispatch` 新增 case + `_handleVoxRun`（spawn + 进度回传 + 路径发现） |
| `browser/vox/voxPipelineRunner.ts` | **新增** | 主进程侧 runner：定位 vox/Python/APIKey、写 beats.json、spawn、解析进度、kill |

### 5.3 本项目 webview

| 文件 | 动作 | 说明 |
|---|---|---|
| `comfyHost/registry.ts` | 改 | 新增 `Vox.DirectorStage` 节点定义 |
| `comfyHost/workflowRun.ts` | 改 | `runNodeOrStage` 新增 `isVoxDirectorNode` 分支 |
| `comfyHost/voxExecutor.ts` | **新增** | webview 侧：组装参数、调 IPC、快照归档 |
| `comfyHost/nodeEditorForm.ts` | 改 | `Vox.DirectorStage` 的编辑表单 |
| `comfyHost/stageCardRegistry.ts` | 改 | 节点 min-height / 隐藏字段 |

---

## 六、实现步骤（分阶段）

### 阶段 1：打通「本地 Python pipeline」执行链路（核心）

1. vox 项目：写 `scripts/vox_pipeline.py`（入口，串 4 阶段 + `[PROGRESS]` stdout）。
2. 本项目主进程：`messageProtocol.ts` 加 `vox.run` / `vox.progress`；`voxPipelineRunner.ts` 封装 spawn；`_dispatch` 接入。
3. 本项目 webview：`voxExecutor.ts` + `runNodeOrStage` 分支 + `registry.ts` 节点定义。

**验收**：工作流放一个 `Vox.DirectorStage`，填 topic + api_key，点运行 → 进度条推进 → OUTPUT 出 `final.mp4`。

### 阶段 2：编辑 UI 打磨

4. `nodeEditorForm.ts` 参数表单 + 主题/音色下拉。
5. 卡片 OUTPUT 视频预览（复用现有 `OutputPreview`）。
6. 进度文案（`关键帧 3/5 → 动效 → 旁白 → 合成`）。

### 阶段 3（可选）：三节点分阶段模式 + 上游 beats JSON 透传

7. 让 `Vox.ScriptStage / ImageStage / VideoStage` 走同一本地 pipeline（按 stage 分段执行），共享 `out/<projectId>/beats.json`。

---

## 七、风险与依赖

| 风险 | 说明 | 缓解 |
|---|---|---|
| **MuAPI APIKey** | vox 所有媒体生成依赖 `MUAPI_API_KEY` | 节点 `api_key` widget + 主进程 settings 持久化（类 `comfy.setLaunchPaths`） |
| **ffmpeg 依赖** | `assemble.py` 依赖 ffmpeg/ffprobe | `vox.checkDeps` 前置检测，缺则节点 UI 红字提示 |
| **Python/vox 路径** | 需定位 vox 项目路径 + Python 解释器 | settings override（`sarosis.vox.pythonPath` / `vox.projectPath`），`vox.checkDeps` 探测 |
| **长耗时** | pipeline 几分钟 | 进度回传 + `vox.cancel`（kill 子进程） |
| **进度解析脆弱** | stdout 格式约定 | `[PROGRESS]` 固定前缀 + 失败打印 stderr 捕获 |
| **beats.json 质量** | 模板化脚本不如 LLM 写的 | 二期接上游 `Saros.Prompt` 结构化输出 + `extractJsonArray` 容错 |

---

## 八、关键结论

1. vox 节点的**正确执行路径是「本地 Python pipeline」**，不是 ComfyUI 后端——现有三节点是占位空壳，需要改造。
2. 本项目已有完整 IPC + 主进程 spawn 先例（`comfy.launch` / `confightml.runTerminal`），新增 `vox.run` 通道是低成本增量。
3. vox 的 Python 脚本（`keyframes/clips/audio/assemble.py`）是完整可复用的管道，只需补一个入口脚本 `vox_pipeline.py`。
4. 参数定义（widgets）基本正确，缺的是「执行路径 + 口播参数 + audio/assemble 阶段」。

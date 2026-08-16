# ComfyTV 使用教程

> 在 VsSaros 工作流编辑器（LiteGraph 画布）中接入 ComfyTV「媒体创作工作台」，支持文生图 / 文生视频 / 文生音频 / 文生文本 / 图批生成、连线数据流、全图一键执行。

---

## 一、环境准备

| 组件 | 位置 / 版本 |
| --- | --- |
| ComfyUI（Comfy Desktop） | 资源根 `D:\Program Files\ComfyUI\resources\ComfyUI`；**用户根 `D:\ComfyUI`**（custom_nodes / models / output / user 都在这里） |
| ComfyTV 自定义节点 | **`D:\ComfyUI\custom_nodes\ComfyTV`**（v1.8.0，已安装——必须装在用户根，装到 resources 内置根不会被加载） |
| 嵌入式 Python | `D:\Program Files\ComfyUI\Comfy Desktop\resources\bootstrap-python\python.exe` |

### 启动 ComfyUI

**方式一（推荐）：** 完整退出并重新打开 **Comfy Desktop** 应用，后端会自动加载 `custom_nodes` 下的 ComfyTV。启动日志中应出现 ComfyTV 加载与节点注册。

**方式二（命令行）：** 直接启动打包实例（保持 Comfy Desktop 未运行，避免抢占 8188）：

```powershell
& "D:\Program Files\ComfyUI\Comfy Desktop\resources\bootstrap-python\python.exe" "D:\Program Files\ComfyUI\resources\ComfyUI\main.py" --base-directory D:\ComfyUI --port 8188
```

> 注：Comfy Desktop 的 worker 由应用托管（uv python + `-s`，`ComfyUI\main.py` 相对于资源根运行）。手动启动若失败，直接重启 Comfy Desktop 应用最可靠。

启动后验证浏览器可访问 <http://127.0.0.1:8188>。

> 若 8188 报「端口被占用」：通常是 Comfy Desktop 与另一个 ComfyUI 实例抢端口。只保留一个，或给其中一个换端口（`--port 8189`）。

---

## 二、在 VsSaros 工作流编辑器中使用

### 1. 连接 Runner

1. 打开一个工作流（LiteGraph 画布）。
2. 打开 **Runner** 面板 → 点击 **探测本地 runner**。
3. 成功后画布加载三类节点：`object_info` 原生节点、**ComfyTV STAGES**（`/comfytv/stages`）、以及 caps 驱动的表单字段（`/comfytv/caps`）。

### 2. 添加媒体节点

- 左侧 **Nodes** 面板 → **COMFYTV STAGES** 分组：
  - 文生图 / 文生视频 / 文生音频 / 文生文本 / 文生图批
- 单击节点即可添加到画布。

### 3. 配置参数（schema 驱动表单）

双击画布上的节点 → 弹出编辑器：

- **提示词（Prompt）**：输入文本，如 `a cat astronaut on the moon, 4k, detailed`。
- **Stage 参数**：字段由 ComfyTV 的 `/comfytv/caps` 动态生成（如 `Stage seed`、`Stage batch size`、`Stage negative`、`Stage duration (s)`…），不再是写死的字段。
- 点 **▶ 生成**：以「完整 workflow」方式提交执行（不是裸 class_type），卡片显示进度条与 OUTPUT。

### 4. 连线与全图执行

- **文生图 ──▶ 文生视频**：连线后，上游图片会以 annotated 路径（`sub/filename [output]`）自动注入下游 workflow 的 `LoadImage`，无需手动传参。
- 工具栏 **▶ Run**：按拓扑序**全图顺序执行**（上游先出图、快照落库、再跑下游），逐节点亮起进度；任一节点失败即中止并在卡片上显示错误横幅。

### 5. 批量出图（batch）

- 双击节点，把 `batch_size`（如 `Stage batch size`）填为 4。
- 运行后卡片 OUTPUT 显示 **4 张缩略图网格**（多图预览）。

### 6. 编排节点 × 媒体融合

- **Prompt 节点**（Saros 编排）连到媒体节点时，它的文本会自动流入下游媒体节点的提示词。
- **Start / End / IfElse / Switch / AskUser** 等仍保持编排语义（由 host 的 Agent 执行引擎驱动），媒体节点负责真正出图/出视频。

---

## 三、ComfyTV 原生工作台（浏览器）

在浏览器打开 <http://127.0.0.1:8188>，添加节点菜单 **ComfyTV** 分类下含 190+ 节点：

- **Project / Input / Generate**：项目、输入加载、文生图/视频/音频
- **Image**：裁剪、旋转、Inpaint、擦除、抠图、放大、宫格、多视角、重打光
- **Panorama**：360° 投影、Card3D、STMap 重映射
- **Video / VideoFX / Keying / Compose**：视频特效、键控合成、分镜拼装
- **Timeline / Audio / AudioFX / Music / 3D / Material / Storyboard / Bridge**：时间线、音频、Score/MIDI 音乐、3D 网格、桥接原生 ComfyUI

**官方文档（中英双语）**：<https://comfytv.org>；项目内中文指南在 `docs/`：
`getting-started`（画布基础、第一次生成、从批量中挑选）、`sidebar`（七页签侧边栏）、`generate`、`image-tools`、`panorama` 等。

---

## 四、常见问题（FAQ）

| 问题 | 解决 |
| --- | --- |
| Runner 探测失败 | 确认 ComfyUI 已启动且端口正确（默认 8188）；换端口后在 Runner 面板添加自定义 runner |
| 端口 8188 被占用 | 只保留一个 ComfyUI 实例（Comfy Desktop 或命令行二选一） |
| 节点不出现（STAGES 为空） | 确认 `custom_nodes\ComfyTV\__init__.py` 在**顶层**（不能嵌套 `ComfyTV\ComfyTV\…`）；**完整重启后端**（不是刷新浏览器） |
| 某节点报 import 错误 | ComfyTV 部分能力是惰性依赖；在 ComfyUI 环境补装，如 `soundfile`、`av`、`opencv-python`、`librosa` |
| 全图执行中途失败 | 失败节点卡片显示错误横幅；修正参数后点 **✕ 重试** |

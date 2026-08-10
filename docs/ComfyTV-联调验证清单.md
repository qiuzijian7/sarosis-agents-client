# ComfyTV × VsSaros 工作流编辑器联调验证清单

> 兼容方案（P0–P4）已全部在浏览器端落地；本清单用于在真机（ComfyUI + ComfyTV）上逐项验证端到端行为。覆盖：节点注册、生成链、fx 链、内嵌编辑器、加载/上传、Bridge、全图执行。

---

## 0. 环境准备

- [ ] 完整重启 **Comfy Desktop**（让 custom_nodes 的 ComfyTV 重新加载；或命令行启动）：
  ```powershell
  & "D:\Program Files\ComfyUI\Comfy Desktop\resources\bootstrap-python\python.exe" "D:\Program Files\ComfyUI\resources\ComfyUI\main.py" --port 8188
  ```
- [ ] 浏览器访问 `http://127.0.0.1:8188` 确认可打开，启动日志出现 ComfyTV 加载。
- [ ] 在 VsSaros 中**重开 workflow 标签页**（webview bundle 每次创建时从磁盘读取）。
- [ ] 打开工作流 → **Runner 面板** → 探测本地 runner，确认 healthy（画布加载 `COMFYTV STAGES` / `COMFYUI NATIVE` 分组）。

> 若右键菜单没有新分组：确认运行的是 dev 构建（`scripts/code.bat`）而非旧安装包 `D:\Program Files\VsSaros`（`Get-Process VsSaros` 看路径）。

---

## 1. 节点注册与画布基础

- [ ] 右键画布 → 菜单含 `SYSTEM`、`COMFYTV STAGES`、`COMFYUI NATIVE`、`comfyRelight`/`comfyPoster`/`comfyLayer` 等内嵌编辑器分组。
- [ ] 添加 `ComfyTV.ImageStage`，节点显示 ComfyUI 风格标题栏（⌄ + 类型徽标）、黄色 pin、深色圆角。
- [ ] 快捷键：`Ctrl+G` 建组、`Ctrl+M`/`Ctrl+B` mute/bypass、`Alt+C` 折叠、`F` 缩放适配、`Ctrl+Enter` 运行、`Ctrl+D` 复制、右键组 → Edit Group。
- [ ] minimap 显示节点矩形与视口框，点击/拖拽可跳转。

## 2. 生成链（P0/P2 核心）

- [ ] `Text Stage`（LLM 文案）→ `Image Stage`（文生图 i2i）连线：Run 后图片快照落库，下游 Image Stage 拿到 annotated 路径注入。
- [ ] 双击 `Image Stage` 弹窗：caps 驱动表单（Stage seed / batch size…），▶ 生成出图，卡片/弹窗预览。
- [ ] `Image Stage`(batch 4) → `Image Picker`：候选网格缩略图，点击即输出选中张（无 Run）。
- [ ] `Image Picker` → `Crop Stage`（即时）：弹窗里设 x/y/width/height → Run → 浏览器裁剪 → 上传 → 快照。
- [ ] `Rotate Stage` / `Mirror Stage` 同链路验证。
- [ ] `Load Image`（加载器）：弹窗 📂 选择文件 → 上传 ComfyUI `input/` → 快照预览。
- [ ] 全图 ▶ Run：按拓扑序逐节点执行，执行中节点蓝框、成功绿框、失败红框+错误横幅。

## 3. fx 链（P1）

- [ ] `Video Stage`(T2V) → `VideoColor Stage` → `VideoTransform Stage` → `FX Chain Stage`：全图 Run。
- [ ] 确认 VideoColor/VideoTransform 各自只 queue 一次（构建 spec），**仅 FX Chain 一次 ffmpeg 渲染**输出成片。
- [ ] 双击 `Corner Pin`：弹窗显示上游视频首帧 + 4 角手柄，拖动后执行（fx 链）得到透视扭曲视频。
- [ ] 双击 `Roto Mask`：在视频首帧上画样条（≥3 点，可拖贝塞尔手柄），feather/invert，执行后输出蒙版视频。

## 4. 内嵌编辑器（P3）

| 编辑器 | 验证点 |
| --- | --- |
| Relight | 灯光球拖灯/预设 → 自动上传参考图 → 执行输出 `light_render` + `light_prompt`（透传） |
| Poster | 上游图选槽 + 标题/副标题文字 + 色块 → 排版 → 自动上传 → 输出海报图 |
| Layer Editor | 画笔/橡皮/矩形/圆形/文字 + 图层显隐/排序 → 自动合成上传 → 输出 |
| Storyboard | 多镜头 tab + 每板画板 + 时长/备注 → 封面合成上传 → 输出 |
| Material | 滑块/PBR 预设 → 材质球自动上传 → 执行输出球图 + 材质 JSON |
| Scene3D | 等距摆场（盒/柱/球拖拽）→ 自动拍摄上传 → 输出 |

## 5. Bridge（P4）

- [ ] 画布放置 `ComfyTV.BridgeToImage`（原生 IMAGE 入桥）与 `BridgeFromImage`（出桥）节点，确认可连线（类型兼容）。
- [ ] 原生节点（如 `LoadImage`/`KSampler`，来自 `/object_info`）能放置、连线、单节点执行。
- [ ] （已知限制）原生图多节点张量链路需原生图全图执行完善，Bridge 完整互通列为后续。

## 6. 排障速查

| 现象 | 排查 |
| --- | --- |
| 右键无 ComfyTV 分组 | Runner 未连上；`/comfytv/stages` 未返回；确认跑的是 dev 构建 |
| Stage Run 报"workflow 未准备" | 该 kind 的 workflow 需在 ComfyUI 的 ComfyTV 工作台打开过一次（`has_api`） |
| 上传无反应 | Runner `fetchApi` 不支持；`/upload/image` 404（确认 8188 可达） |
| fx 链节点 Run 报"needs upstream video" | 弹窗单独运行 fx 构建节点需上游视频（符合 ComfyTV 语义），请走全图执行 |
| 连线不显示 | 已修复（onRender 补画）；仍异常请重开标签页并确认 bundle 版本 |
| 端口 8188 被占 | `netstat -ano` 查占用；Comfy Desktop 与手动实例只留一个 |

---

## 7. 完成度对照

- P0 节点注册/表单/统一执行器 ✅（浏览器端 e2e 覆盖）
- P1 fx_spec 链 ✅（打包/透传/单次渲染；真机 ffmpeg 输出待验证）
- P2 选择器/加载器/即时节点 ✅
- P3 八个内嵌编辑器 ✅（Relight/Poster/Corner Pin/Roto Mask/Layer Editor/Storyboard/Material/Scene3D）
- P4 Bridge 注册 ✅（张量链路后续）
- 待办：本清单 2-5 节真机验证；原生图全图执行完善 Bridge 张量链路；3D Scene 完整 WebGL 化（当前 2.5D MVP）。

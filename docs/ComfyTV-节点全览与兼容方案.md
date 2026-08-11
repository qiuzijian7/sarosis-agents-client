# ComfyTV 节点全览与 VsSaros 兼容方案

> 分析对象：`G:\CustomWorkspaces\AIProjects\ComfyTV`（v1.8.0，ComfyUI 自定义节点包，Vue 前端 + Python 后端）。
> 信息来源：`nodes/stages/*.py`（178 个 stage schema）+ `nodes/bridges.py`（10 个桥）+ `node-docs/*/zh.md`（190 份官方中文文档）+ `workflows/`（19 类 38 个预设）。
> 目的：为 VsSaros 工作流编辑器（LiteGraph）完整兼容 ComfyTV「媒体创作工作台」提供依据。

---

## 一、ComfyTV 架构核心（理解节点的前提）

### 1. 节点 = Stage（阶段）

所有 ComfyTV 节点都是 `io.ComfyNode` + `define_schema()` 声明式定义，字段为 `io.String/Int/Float/Combo/Autogrow/Toggle.Input`，输出为 `io.Custom("COMFYTV_XXX")`。运行时每个节点要么：

- **生成式（generative）**：点 ▶ **Run** → 调用后端子 workflow（`run_stage_workflow` → ComfyUI 队列执行被包裹的 JSON），产出**项目快照**（`/view?` URL）。
- **即时式（instant）**：无 Run，浏览器内实时处理（Crop / Rotate / Mirror / Color Grade / Layer Editor 等），或点击即输出（Asset 加载器 / Picker 选择器）。
- **工具式（tool / media）**：Run 后走 PyAV / FFmpeg / torch 后端直接处理磁盘媒体（Video Clip、Audio EQ、Keyer…），不经过扩散模型。

### 2. 数据流 = 快照（Snapshot）而非张量

ComfyTV stage 之间流动的是**项目快照**（URL 字符串 / JSON），不是 ComfyUI 内存张量。这决定了连线规则：

| 类型 | 内容 | 说明 |
| --- | --- | --- |
| `COMFYTV_TEXT` | 文本字符串（可含快照 URL） | Text/LLM 输出、标签、关键帧、字幕 |
| `COMFYTV_IMAGE` | 单图快照 `subfolder/filename [type]` | 可由 `viewUrlToAnnotated` 转 annotated 注入 |
| `COMFYTV_IMAGES` | 多图批量 JSON `{images:[{index,label,image_url}]}` | 网格预览 + `selected_index` |
| `COMFYTV_VIDEO` | 视频快照 URL | 剪辑/特效链 |
| `COMFYTV_AUDIO` | 音频快照 URL（wav） | TTS/音乐/音轨 |
| `COMFYTV_STORYBOARD` | 分镜 JSON（`shots[]` 16 字段） | LLM 分镜表 |
| `COMFYTV_TIMELINE` | 时间线 JSON（`segments[]/audioSegments[]`） | 多镜剪辑表 |
| `COMFYTV_MODEL` | 3D 模型（GLB） | 3D 工坊链 |
| `COMFYTV_MATERIAL` | PBR 材质 JSON | Material 节点 |
| `COMFYTV_FXSPEC` | FX 规格 JSON（链式传递） | **关键**：Audio/Video FX 节点不各自重编码，输出 fx_spec 沿链传递，由 **FX Chain** 一次 ffmpeg 转码渲染 |
| `COMFYTV_PANORAMA` | 等距柱状全景 | 360° |

**Bridge（10 个）** 是 ComfyTV 与 ComfyUI 原生类型的互转通道：`BridgeTo*`（原生→COMFYTV，Run 时写 bridge 目录）、`BridgeFrom*`（COMFYTV→原生，Queue 时加载内存）。

### 3. 标准输入（`_standard_stage_inputs`）

生成类 stage 普遍携带：`force_run_token`、`project_id`、`parent_output_id`（隐藏）；`workflow`（Combo，选择后端子 workflow）；`main_prompt`（主提示词，可被上游 texts 拼接）；`texts/images/videos`（Autogrow 多模态上下文槽）；`custom_params`（JSON，透传引擎特化参数）。另有 `selected_index`（批量中选择哪一张/段）。

### 4. 预设 workflow（后端能力池，19 类 38 个）

`workflows/` 目录即「生成后端」，每个 stage 的 `workflow` 下拉即指向这里：

- **image/**（6）：local-sd15、local-sd15-i2i、image_ideogram4_t2i、flux2klein-relight、qwen-product-shot、pose-transfer-sd15
- **video/**（7）：local-ltx-2.3-{t2v,i2v,flf2v,ia2v}、local-minimax-h3-{t2v,r2v,flf2v}
- **audio/**（1）：ace-step-v1-song（文生音乐，支持歌词=演唱）
- **text/**（1）：local-qwen3-4b（LLM 文本）
- **speech/**（1）：TTS
- **image-edit/**（2）：flux-canny-edit、qwen-edit-2511
- **inpaint/**（2）：flux-fill-inpaint、fooocus-sdxl-inpaint
- **outpaint/**（2）：flux-fill-outpaint、fooocus-sdxl-outpaint
- **erase/**（1）：lama-erase；**cutout/**（1）：birefnet-cutout
- **upscale/**（1）：ultrasharp-4x；**multiangle/**（1）：qwen-edit-2511-multiangle
- **multiview/**（4）：qwen-3view-{character,face,product}、qwen-9cam
- **sequence/**（2）：qwen-next-scene-{4,25}
- **panorama/**（2）：qwen-edit-2511-img2pano、qwen-image-2512-360
- **split-part/**（2）：sam3-{prompt,text}
- **storyboard/**（1）：local-qwen3-storyboard；**shot-images/**（2）：flux-schnell、local-z-image-turbo
- **material-estimate/**（1）：qwen3vl-estimate（参考图→PBR 参数）

---

## 二、节点全览（178 Stage + 10 Bridge）

### 2.1 分类统计

| 分类 | 数量 | 代表能力 |
| --- | --- | --- |
| ComfyTV/Generate | 9 | 文生图/视频/音乐/语音/文本、分镜、导演、3D 模型、项目根 |
| ComfyTV/Input | 14 | 本地加载、资产库加载、文本、Layer Editor、3D 场景/材质/打光 |
| ComfyTV/AudioFX + Audio | 29 | 音频效果链 + 提取/分离/解复用 |
| ComfyTV/VideoFX | 46 | 视频特效链（torch/ffmpeg） |
| ComfyTV/Video | 21 | 视频工具（PyAV 剪辑/抽帧/混流/字幕） |
| ComfyTV/Image | 14 | 图编辑/生成（含即时节点） |
| ComfyTV/Compose | 12 | 合成/拼接/转场/选择器/时间线 |
| ComfyTV/Keying | 7 | 抠像/键控/去溢色 |
| ComfyTV/3D | 6 | 网格基元/操作/布尔/烘焙/线稿 |
| ComfyTV/Music | 7 | 乐谱/MIDI/伴奏/合成器 |
| ComfyTV/Panorama | 3 | 全景导入/截取 |
| ComfyTV/Utils | 2 | 项目根、蒙版清理 |
| ComfyTV/Bridge | 10 | 与 ComfyUI 原生互通 |

> 注：个别节点按官方分类存在交叉（如 Keying 类节点部分列在 VideoFX 分类下，此处按能力分组）。

### 2.2 Generate（生成，9 个）

| 节点 | 显示名 | 功能 | 关键输入 | 输出 |
| --- | --- | --- | --- | --- |
| `ProjectStage` | Project | 工作流「根节点」，绑定项目 id/name，所有生成结果归入同一项目资产库 | project_id/project_name/schema_version（socketless） | 无 |
| `TextStage` | Text Stage | LLM 文生文本（扩写/场景描述），可接收 texts/images/videos 多模态上下文 | main_prompt、workflow、Autogrow 槽、custom_params | `COMFYTV_TEXT` |
| `ImageStage` | Image Stage | 文生图/图生图，批量 1-8，workflow 选择后端 | main_prompt、workflow、resolution、aspect_ratio、batch_size、images（i2i） | `COMFYTV_IMAGES` + `COMFYTV_IMAGE`(selected) |
| `VideoStage` | Video Stage | 文生视频 T2V/I2V/FLF2V/IA2V（LTX 2.3 / MiniMax H3） | main_prompt、workflow、resolution、aspect_ratio、duration、images(首帧)、first/last frame、audio(IA2V) | `COMFYTV_VIDEO` |
| `AudioStage` | Music Stage | 文生音乐/歌曲（ACE-Step，歌词可选=演唱） | main_prompt(流派/情绪/BPM)、lyrics、duration | `COMFYTV_AUDIO` |
| `SpeechStage` | Speech Stage | TTS 配音/旁白，模型无关（通用参数 + custom_params 透传） | main_prompt(朗读稿)、voice/language/speed | `COMFYTV_AUDIO` |
| `StoryboardStage` | Storyboard | LLM 大纲→结构化分镜表 JSON（每镜 16 字段），含内嵌分镜编辑器 | main_prompt、总时长、镜头数 | `COMFYTV_STORYBOARD` |
| `DirectorStage` | Director | （Generate 分类）AI 导演/编排入口 | — | 多模态 |
| `Model3DStage` | 3D Model Stage | 文生/图生 3D 模型（GLB），被包裹 workflow 须以 SaveGLB 收尾 | main_prompt、参考图/模型、workflow | `COMFYTV_MODEL` + `COMFYTV_IMAGE`(预览) |

### 2.3 Input（输入，14 个）

| 节点 | 显示名 | 功能 | 备注 |
| --- | --- | --- | --- |
| `TextLoaderStage` | Input Text | 多行文本直接作为 `COMFYTV_TEXT` 输出 | 即时，编辑即生效 |
| `ImageLoaderStage` | Load Image | 从 ComfyUI `input/` 选/传图片 → `COMFYTV_IMAGE` | 即时 |
| `VideoLoaderStage` | Load Video | 从 `input/` 选/传视频 → `COMFYTV_VIDEO` | 即时 |
| `AudioLoaderStage` | Load Audio | 从 `input/` 选/传音频 → `COMFYTV_AUDIO` | 即时 |
| `ModelLoaderStage` | Load 3D Model | 从 `input/3d` 加载 GLB/GLTF/FBX/OBJ/PLY 等，可环绕 + 材质绑定部件 | 即时，双输出 MODEL+IMAGE |
| `AssetImageLoaderStage` | Load Image from Asset | 从**项目资产库**（带 lineage 溯源）选图 | 即时，内嵌资产选取器 |
| `AssetVideoLoaderStage` | Load Video from Asset | 同上，视频 | 即时 |
| `AssetAudioLoaderStage` | Load Audio from Asset | 同上，音频 | 即时 |
| `AssetModelLoaderStage` | Load 3D Model from Asset | 同上，3D 模型 | 即时 |
| `LayerEditorStage` | Layer Editor | **浏览器内完整栅格+矢量图像编辑器**（图层/蒙版/选区/画笔/形状/文字）→ 拍平快照 | 即时，输入分类的创作起点 |
| `Scene3DStage` | 3D Scene | **浏览器内 3D 摆场工作台**（角色/基元/模型/灯光/相机），Capture 静帧 / Record 视频 | 即时，多相机批量 |
| `MaterialStage` | Material | **PBR 材质球编辑器**（WebGL 实时），可接参考图→VLM 估参 | 即时，输出 MATERIAL+IMAGE |
| `RelightStage` | Relight | **3D 灯光球编辑器**：摆灯→渲染参考图 + 灯光提示词，接 Image Stage | 即时，双输出 |
| `StoryboardEditorStage` | Storyboard Editor | 逐格绘画板 + 时间线 + 洋葱皮，导出视频/GIF/PDF/PSD | 即时 |

### 2.4 AudioFX（25）+ Audio（4）

**效果链（均可输出 `fx_spec` 供 FX Chain 一次渲染）：**

| 节点 | 功能 |
| --- | --- |
| `AudioDuckStage` | 侧链闪避（旁白响时压低音乐） |
| `AudioCrossfadeStage` | 两轨交叉淡变 |
| `AudioMixStage` | 4 轨迷你调音台（每轨 gain/pan） |
| `AudioSegmentExportStage` | 按静音/JSON 时间表切多段导出 |
| `AudioEchoStage` | 回声/拍击延迟（预设 mountains/robot/doubled） |
| `AudioModulationStage` | 移相/镶边/合唱/颤音/颤幅/脉冲 |
| `AudioStereoStage` | 立体声宽窄/交叉馈送/Haas/单声道/换声道 |
| `AudioTimePitchStage` | 变速/变调（快速 FFmpeg + HQ 相位声码器） |
| `AudioSaturateStage` | 软削波/比特压缩/谐波激励/水晶器 |
| `AudioConvolveStage` | 卷积混响（IR） |
| `MuseReverbStage` | FDN 算法混响 |
| `AudioDynamicsStage` | 压缩器/噪声门/限制器/齿音消除 |
| `AudioEQStage` | 图形 EQ 曲线（peak/highpass/lowpass/shelf 频段） |
| `AudioLoudnessStage` | EBU R128 / 动态 / 峰值归一 |
| `AudioDenoiseStage` | afftdn / anlmdn / 静音裁剪 |
| `AudioRepairStage` | 去咔哒/削波重建/非规格化/小波降噪/哼声陷波 |
| `AudioStemSplitStage` | HDemucs 五轨分离（人声/鼓/贝斯/其余/伴奏） |
| `AudioNoiseReductionStage` | 频谱门控降噪（可接 noise_sample） |
| `AudioMIRStage` | 节拍/起音/音符检测 → 关键帧 + 标签 |
| `AudioReactiveStage` | 频段响度包络 → 平滑动画关键帧 |
| `AudioAnalyzeStage` | LUFS/峰值/统计/静音检测 → 文本报告 |
| `AudioVisualizeStage` | 波形/频谱图渲染为 `COMFYTV_IMAGE` |
| `AudioSweepStage` | 指数正弦扫频生成（ESS，无输入） |
| `AudioDeconvolveStage` | 扫频录音反卷积 → IR |
| `AudioMeterStage` | 电平表叠加烧录进视频 |

**音频工具（无 Run 或独立语义）：**

| 节点 | 功能 |
| --- | --- |
| `AudioExtractBgStage` | ⏳ 路线图：Demucs 伴奏分离（workflow 槽位预留，未实现） |
| `AudioExtractVocalStage` | ⏳ 路线图：Demucs 人声分离（未实现） |
| `AudioVideoDemuxAudioStage` | 从视频容器**提取音轨**（PyAV） |
| `AudioVideoDemuxVideoStage` | **剥离音轨**输出无声视频（PyAV） |

### 2.5 VideoFX（46 个，特效链）

**调色/色彩（ffmpeg 或 torch，多数可输出 fx_spec）：**

`VideoColorStage`（曝光/白平衡/HSL/色阶/三向色轮）、`CDLStage`（ASC-CDL slope/offset/power/sat）、`VideoCurvesStage`（主曲线+通道曲线+电影预设）、`SelectiveColorStage`（9 色族可选颜色）、`HueCorrectStage`（色相环曲线）、`GrayWorldStage`（自动白平衡）、`HistogramEqStage`（直方图均衡+CLAHE）、`VideoLUTStage`（.cube 3D LUT）、`ColorSuppressStage`（六色抑制）、`PseudocolorStage`（假彩色/热力图）、`PosterizeStage`（elbg 色调分离）、`ChromaShiftStage`（RGB 通道分离）、`ChromaticAberrationStage`（径向色差）、`VideoStylizeStage`（暗角/颗粒/像素化/边缘检测/棕褐/单色预设）。

**光学/镜头：** `LensDistortStage`（nuke_k1k2 桶/枕形畸变，可去可加）、`STMapGenStage`（畸变→STMap UV 图）、`STMapStage`（UV 重映射）、`LensFlareStage`（程序化镜头光晕）、`GodRaysStage`（体积光束）、`ZDefocusStage`（景深散焦）。

**风格化/艺术：** `ArtFXStage`（卡通/炭笔/浮雕/半调）、`OldFilmStage`（灰尘/划痕/闪烁/抖动）、`RegrainStage`（三色调胶片颗粒）、`GlowStage`（辉光/泛光）、`FrameBlendStage`（帧混合/运动模糊）、`FeedbackFXStage`（递归视频反馈）、`GlitchFXStage`（datamosh 块位移+RGB 分离）、`SlitScanStage`（狭缝扫描）、`StrobeStage`（频闪）、`KaleidoscopeStage`（万花筒）、`WaveWarpStage`（正弦波扭曲）、`WaterStage`（流体水面模拟）、`LightGraffitiStage`（光绘拖影）、`ParticlesStage`（2D 粒子系统，可蒙版驱动发射）、`PaintStrokeStage`（clone/blur/color 笔触，可接 reveal_video）。

**变换/跟踪：** `VideoTransformStage`（2D 平移/缩放/旋转/斜切 + 关键帧 + 运动模糊）、`Card3DStage`（3D 透视卡片）、`CornerPinStage`（四角单应扭曲 + track 驱动）、`MotionTrackStage`（点跟踪 → 文本数据 + 变换解算）、`MaskPropagateStage`（首帧蒙版沿运动传播）、`RotoMaskStage`（手绘样条→动画蒙版）、`ShapeMaskStage`（程序化渐变/亮度图→蒙版）、`FaceBlurStage`（人脸检测遮挡）、`SpotRemoverStage`（矩形污点修复）、`VideoBlurSharpenStage`（高斯/盒式/双边模糊 + 锐化）、`VideoDenoiseStage`（5 种降噪/去色带）、`VideoInterpolateStage`（运动补偿插帧/慢动作）、`VideoDeinterlaceStage`（反交错）、`VideoStabilizeStage`（deshake 快速稳定）、`VideoStabilizeV2Stage`（两趟相机路径稳定）、`Video360Stage`（360 投影变换 v360）、`Video360StabilizeStage`（360 球面旋转稳定）、`AnnotateStage`（方框/网格/滚动烧录）、`VideoChromaKeyStage`（色度抠像+去溢色）、`MatteMonitorStage`（遮罩质检视图）、`MatteMorphStage`（腐蚀/膨胀/开/闭）、`FXChainStage`（**FX 链渲染端**：解包整条 fx_spec 一次转码，设交付格式）、`MaskCleanup`（MASK 连通域清理，Utils）。

### 2.6 Video（工具，PyAV/ffmpeg）

`VideoClipStage`（按时间段裁剪）、`VideoCropStage`（逐帧矩形裁剪）、`VideoResizeStage`（宽高缩放，-1 保持比例）、`VideoRotateStage`（90° 步进旋转+镜像）、`VideoSpeedStage`（变速/倒放）、`VideoSplitStage`（切两段）、`VideoExtractFrameStage`（抽单帧）、`VideoFramesStage`（按标记抽多帧批量）、`VideoMuxAudioStage`（混入音轨）、`VideoVolumeStage`（音量+淡入淡出）、`ContactSheetStage`（审片宫格）、`SceneDetectStage`（切镜点检测→缩略图/片段池）、`MakeProxyStage`（生成代理预览副本）、`KenBurnsStage`（图→平移缩放视频）、`SubtitleStage`（SRT/WebVTT 硬字幕烧录）、`SubtitleGenStage`（语音转字幕 STT）、`TitleStage`（标题烧录，支持时间码占位符）、`TimeRemapStage`（速度关键帧/定格）、`VideoUpscaleStage`（⏳ 路线图，未实现）。

### 2.7 Image（14 个）

`ColorGradeStage`（即时 GLSL 调色）、`CropStage`（即时裁剪框）、`RotateStage`（即时旋转）、`MirrorStage`（即时镜像）、`GridSplitStage`（即时九宫格切分→批量）、`UpscaleStage`（AI 4x 放大）、`CutoutStage`（AI 抠图→透明 PNG）、`InpaintStage`（蒙版+prompt 重绘）、`EraseStage`（蒙版擦除，LaMa 填充）、`OutpaintStage`（扩图填充）、`ImageEditStage`（自然语言整图编辑，Flux Canny Edit）、`ImageVariationsStage`（多机位/序列批量）、`MultiangleStage`（3D 相机 widget 新视角重渲染）、`SplitPartStage`（SAM 部件分割，点/框/文字提示）、`PosterStage`（**浏览器引擎排版海报**：模板+拖拽元素，AI 素材+真排版）。

### 2.8 Compose（合成/编排，12 个）

`ImagePickerStage`（多图缩略图→选中单图 + 操作工具栏）、`VideoPickerStage`（多视频→选中单段）、`AudioPickerStage`（多音频→选中单轨）、`CompareStage`（A/B 滑条对比，无输出）、`VideoConcatStage`（≤12 段拼接+重排）、`VideoTransitionStage`（xfade 数十种转场）、`VideoLumaWipeStage`（亮度划像）、`VideoCompositeStage`（混合模式/透明度/2D 变换/蒙版/关键帧合成）、`SequenceStage`（≤12 段入出点+转场组装）、`ShotImagesStage`（分镜表逐镜出图批量）、`DirectorTimelineStage`（浏览器时间线编排→`COMFYTV_TIMELINE`）、`TimelineVideoStage`（时间线渲染导出成片）。

### 2.9 Keying（抠像/键控，7 个）

`KeyerStage`（亮度/颜色/幕布抠像曲线+去溢色）、`PIKStage`（IBK/Primatte 风格背景板抠像+垃圾遮罩）、`Select0rStage`（三维颜色选区体 box/ellipsoid/octahedron）、`DespillStage`（去绿/蓝溢色）、`KeyMixStage`（蒙版混合两视频）、`MatteMonitorStage`（遮罩质检）、`ColorSuppressStage`（六色抑制，兼归 VideoFX）。

### 2.10 3D（6 个）

`MeshPrimitiveStage`（立方体/球/柱/锥/平面/圆环生成）、`MeshOpStage`（8 种操作：decimate/remesh/weld/fill holes/smooth normals/subdivide/unwrap/export）、`MeshBooleanStage`（CSG union/difference/intersect + gizmo 摆放）、`MeshBakeMapsStage`（高模细节烘焙到低模：法线/AMB）、`LineArtStage`（模型→ControlNet 线稿渲染）。

### 2.11 Music（乐谱/音乐，7 个）

`ScoreStage`（MusicXML 校验/刻谱，OSMD 渲染）、`ScoreEditorStage`（拍域钢琴卷帘→MusicXML）、`ScoreToMidiStage`（乐谱→拟人化演奏 MIDI）、`SF2SynthStage`（SoundFont 演奏→音频）、`ChordAccompStage`（和弦进行→伴奏/琶音+MIDI）、`ClickTrackStage`（节拍器，速度/拍号/标签驱动）、`MidiEditorStage`（秒域 MIDI 钢琴卷帘→.mid）。

### 2.12 Panorama（3 个）

`PanoramaStage`（360° 全景入口：上传 HDRI/图生全景/文生全景）、`PanoramaCurrentViewStage`（全景中瞄准视口→平面截图）、`PanoramaMultiViewStage`（等间距多视角批量）。

### 2.13 Bridge（10 个，ComfyUI 互通）

| 节点 | 方向 | 转换 |
| --- | --- | --- |
| `BridgeToImage` | IMAGE → COMFYTV_IMAGE | Run 时存 PNG→快照 URL |
| `BridgeToImages` | IMAGE batch → COMFYTV_IMAGES | 逐帧存 PNG + selected 单张 |
| `BridgeToVideo` | VIDEO → COMFYTV_VIDEO | Run 时存 mp4 |
| `BridgeToAudio` | AUDIO → COMFYTV_AUDIO | Run 时写 wav |
| `BridgeToText` | STRING → COMFYTV_TEXT | Run 时注册快照（不落盘） |
| `BridgeFromImage` | COMFYTV_IMAGE → IMAGE | Queue 时从磁盘加载 |
| `BridgeFromMask` | COMFYTV_IMAGE → MASK | 提取 alpha（1-alpha） |
| `BridgeFromVideo` | COMFYTV_VIDEO → VIDEO | Queue 时包装 mp4 |
| `BridgeFromAudio` | COMFYTV_AUDIO → AUDIO | Queue 时 torchaudio 加载 |
| `BridgeFromText` | COMFYTV_TEXT → STRING | 原样字符串 |

---

## 三、VsSaros 兼容方案

### 3.0 现状（已实现基线，2026-08-10）

| 能力 | 实现 |
| --- | --- |
| 节点注册 | `/comfytv/stages` 拉取 stage 清单，按 `node_id` 注册 LiteGraph 节点（ComfyTV.* 类型），分类进右键菜单 |
| schema 表单 | `/comfytv/caps`（capsLoader）按 io 类型（String/Int/Float/Combo/Toggle/Autogrow）动态生成节点编辑器表单 |
| 预设列表 | `/comfytv/workflows?kind=` + config 下拉（`pickDefaultWorkflowLabel`） |
| 执行 | `runNodeOrStage` 统一执行器：ComfyTV.* → `runStageWorkflow`（fetchApi 包裹，`StageWorkflowUnavailableError` 降级）；原生 ComfyUI 节点 → `runComfyWorkflow` |
| 数据流 | 上游快照以 `upstream_<kind>[:annotated|value|masked][idx]` 注入；`viewUrlToAnnotated` 生成 `subfolder/filename [type]` 注入下游 LoadImage |
| 批量 | `COMFYTV_IMAGES` 网格预览 + `selected_index` |
| 画布 | minimap、右键节点菜单、ComfyUI 风格样式/状态边框、节点快捷键（Ctrl+M/B/G/D/Alt+C/F/Ctrl+Enter）、Group |

### 3.1 兼容目标与分层（P0–P5）

**P0 节点注册与基础执行（已完成）**：178 stage 全部按 `/comfytv/stages` 注册；表单由 caps 驱动；生成类（Image/Video/Audio/Text/Speech/Storyboard/3D Model）与 Input 加载类可用；全图拓扑执行 + 状态可视化。

**P1 数据流语义补齐**：
- `COMFYTV_TEXT`：文本直接以字符串传递（当前已支持），关键帧/标签 JSON 透传。
- `COMFYTV_AUDIO/VIDEO/MODEL`：快照 URL 直接连线；下游 Binding 时把 URL 转 annotated 注入对应 Load 节点（Audio Loader / VHS Load Video / LoadGLB）。
- `selected_index`：选择器/批量节点统一语义——`images[i]`/`videos[i]` 取选中项。
- **fx_spec 链**：AudioFX/VideoFX 节点执行后输出 `COMFYTV_FXSPEC`（合并上游链）；`FXChainStage` 聚合整链**一次 ffmpeg/torch 渲染**（新增 `runFxChain` executor；无上游视频时纯 fx 链也可渲染到 pattern 生成）。这是「不逐节点重编码」的关键，否则 46 个 VideoFX 节点各自重编码会慢一个量级。

**P2 特殊执行语义**：
- **无 Run 节点**：Input 加载器（Load Image/Video/Audio/Model + Asset 版）、Text Loader、Picker（Image/Video/Audio）、Compare——执行时直接透传选择值/文件引用，不入队。
- **即时节点**（Crop/Rotate/Mirror/ColorGrade/GridSplit）：浏览器端 Canvas/GLSL 处理，输出新快照 URL（或直接透传原图 + 参数），不调后端。
- **工具节点**：PyAV/ffmpeg 后端起的是 ComfyTV 自己的 runner（`/comfytv/stages/run` 或 runner API），在 VsSaros 中统一走 `runStageWorkflow` 的 fetchApi 通道，无需区分。

**P3 内嵌编辑器节点（工作量最大）**：Layer Editor、Storyboard Editor、MIDI/Score Editor、3D Scene、Material、Relight、Corner Pin、Paint Stroke、Roto Mask、Poster、Director Timeline——这些节点主体是复杂交互组件。方案：webview 内实现轻量等价组件（Canvas 2D / WebGL），数据以 JSON 存入 `node.data`（与 ComfyTV 的隐藏字段一致），渲染管线对齐。建议按「对现有工作流价值」排序：Poster（排版）> Relight（打光）> Crop/ColorGrade（已有即时能力）> RotoMask > Layer Editor。

**P4 Bridge 互通**：BridgeTo*/BridgeFrom* 需要 ComfyUI 原生 object_info 节点共存于画布。VsSaros 已有 `/object_info` 注册；Bridge 节点执行路由：
- `BridgeTo*`：Run → 调 ComfyUI 原生子图执行（把上游 IMAGE/VIDEO 输入桥入子图）→ 写 bridge 目录 → 注册快照。
- `BridgeFrom*`：Queue 原生图时把 COMFYTV URL 解析为磁盘路径绑定到 Load 节点。

**P5 音乐/3D 纵深**：Music 链（Score→Performer→Synth）、3D 工坊（Primitive→Ops→Boolean→Bake→LineArt）、Panorama 链——需要对应后端 runner 与 WebGL 预览。优先级最低（依赖 ComfyTV 已实现的后端与前端组件）。

### 3.2 节点注册映射（LiteGraph 侧）

```
/object_info  ──► ComfyUI 原生节点（LOADER/KSAMPLER/SAVE…）
/comfytv/stages ──► ComfyTV.* 节点（178）
/caps ──► 表单字段（io.String/Int/Float/Combo/Toggle/Autogrow → 控件）
类型映射：
  COMFYTV_IMAGE    → pin 类型 "COMFYTV_IMAGE"（绿，可接收原生 IMAGE 经 Bridge）
  COMFYTV_IMAGES   → "COMFYTV_IMAGES"
  COMFYTV_VIDEO/AUDIO/TEXT/MODEL/MATERIAL/FXSPEC/STORYBOARD/TIMELINE → 各自类型
  STRING/IMAGE/VIDEO/AUDIO/MASK（ComfyUI 原生）→ 现有原生类型
连线规则：isValidConnection 按类型名匹配 + "*" 通配 + COMFYTV_* 与原生类型禁止直连（提示插入 Bridge）
```

### 3.3 执行路由（`runNodeOrStage` 扩展）

```
nodeId 前缀：
  ComfyTV. → runStageWorkflow（fetchApi，kind 由 nodeId 映射：ImageStage→image…）
     - 携带 upstream 快照绑定（annotated 路径注入）
     - fx 链节点 → 聚合 fx_spec，链尾 FXChain 渲染
     - 无 Run 节点 → 直接出快照/透传
  ComfyTV.BridgeTo*/From* → 原生子图桥接
  其他 → runComfyWorkflow（object_info 原生图）
```

### 3.4 优先落地建议（增量路线）

1. **fx_spec 链**（P1 关键项）：选择 5 个高频 VideoFX（VideoColor/BlurSharpen/Transform/Glow/ChromaShift）打通「fx 链一次渲染」。
2. **无 Run 节点**：加载器 + 三个 Picker 的「即点即用」交互（卡内缩略图条）。
3. **Bridge 互通**：Image/Text 两个最高频方向的 To/From。
4. **内嵌编辑器**：Relight → Poster → RotoMask 逐步引入。

### 3.5 风险与注意

- `COMFYTV_IMAGES`/`COMFYTV_VIDEO` 批量语义与 `selected_index` 需在 store 的 edge 上传递（数组索引），现有快照注入需支持 `[idx]` 后缀（`upstream_images[2]`）。
- 部分节点（ExtractVocal/ExtractBg/VideoUpscale/SubtitleErase 两个）是**占位节点**（Run 抛 `StageNotImplemented`）——画布注册时应标记「路线图/未实现」，避免误导。
- ComfyTV 后端依赖 ComfyUI 实例（8188）运行，VsSaros 侧所有执行走 Runner 探测 + fetchApi，断连时保持现有降级提示。
- fx_spec 链与全图拓扑执行的冲突：fx 链节点间是「参数依赖」而非「媒体依赖」，拓扑序需特殊处理（链节点不强制先于 FXChain 渲染，全部链节点无媒体输入时由 FXChain 聚合）。

### 3.6 落地进度核对（截至 2026-08-11）

> 与第 3.1 分层的逐项核对（✅=完成 / 🟡=部分 / ⬜=未做）。

| 分层 | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| P0 | 节点注册 + 表单 + 全图拓扑执行 | ✅ | 178 stage 全注册；caps 表单；`runGraphExecution` 串行拓扑 |
| P1 | `COMFYTV_TEXT/IMAGE/VIDEO/AUDIO/MODEL` 快照连线 | ✅ | annotated 注入 + `upstream_<kind>[:annotated]` 绑定 |
| P1 | `selected_index` 批量语义 | ✅ | `COMFYTV_IMAGES` 网格 + 选中项 |
| P1 | **fx_spec 链一次渲染** | ✅ | `comfyHost/fxChain.ts`（pack/unpack/isFxBuildNode）+ `runNodeOrStage` 链尾 FXChainStage 渲染；79 个 FX 节点（VideoFX 54 + AudioFX 25）全部接入 |
| P2 | 无 Run 节点（Loader/Picker/Compare/Text Loader） | ✅ | 即点即用透传，不入队 |
| P2 | 即时节点（Crop/Rotate/Mirror/ColorGrade/GridSplit） | ✅ | instantNodes + 浏览器端处理 |
| P2 | 工具节点统一 `runStageWorkflow` fetchApi 通道 | ✅ | StageWorkflowUnavailableError 降级 |
| P3 | 内嵌编辑器 8 个：relight/poster/cornerPin/rotoMask/layer/storyboard/material/scene3d | ✅ | `*Editor.ts`（纯函数）+ `*Executor.ts` + `*Editor.tsx`，kind='native'，接入 NodeEditorPopup |
| P4 | Bridge 节点注册 | ✅ | registry 注册 10 个 Bridge |
| P4 | **BridgeTo*/BridgeFrom* 执行路由（原生子图桥接）** | 🟡 | provider→Comfy `LoadImage` 上传桥（imageGenToComfyBridge）已通；**原生张量子图级 To/From 执行待验证** |
| P5 | Music 链（Score→Performer→Synth） | ⬜ | 依赖后端 runner，优先级最低 |
| P5 | 3D 工坊（Primitive→Ops→Boolean→Bake→LineArt） | ⬜ | 仅 Scene3D 摆场编辑器落地 |
| P5 | Panorama 链（导入/截取） | ⬜ | 未接入 |
| — | 占位节点标记（ExtractVocal/VideoUpscale 等） | ⬜ | 应标记「路线图/未实现」，避免误执行 |

### 3.7 配套测试计划（覆盖已落地项 + 未落地项验收）

| 功能 | 测试文件 | 关键用例 |
| --- | --- | --- |
| fx_spec 链 | `workflowFxChain.test.ts` | pack/unpack 往返；链尾一次渲染（非逐节点）；无上游视频纯 fx；链参数合并优先级 |
| 内嵌编辑器纯函数 | `workflowComfyNodeEditorForm.test.ts` 等（已有 8 组） | 编辑器 `*Editor.ts` 纯函数已覆盖；补 executor 快照归属断言 |
| Bridge provider→Comfy 上传 | `workflowImageGenBackend.test.ts` / `workflowComfyMediaSnapshot.test.ts` | `imageGenToComfyBridge` 上传路径（已有 15）；**补 LoadImage 失败降级与 annotated 注入** |
| 批量 selected_index | `workflowComfyMediaSnapshot.test.ts` | `[idx]` 后缀取批量项；越界回退 0 |
| 即时节点 | `workflowComfyNodeStyle.test.ts` | 浏览器端处理不调后端（mock runner 断言未调用） |
| P4/P5 未落地项验收 | 待实现时补 | BridgeTo 原生子图执行；Music/3D/Panorama 链的 `runStageWorkflow` 集成 |

---

## 附：节点功能速查（一句话）

**Generate（9）**：Project=项目根；Text=LLM 文案；Image=文生图/图生图；Video=T2V/I2V/FLF2V/IA2V；Music=文生歌；Speech=TTS；Storyboard=LLM 分镜表；Director=导演编排；3D Model=文生/图生 3D。

**Input（14）**：Load Image/Video/Audio/3D Model（input/ 目录）+ Asset 版（资产库）；Input Text；Layer Editor=内置图像编辑器；3D Scene=内置 3D 摆场；Material=PBR 材质球；Relight=3D 打光；Storyboard Editor=逐格分镜板。

**Audio（29）**：Duck 闪避 / Crossfade 交叉淡变 / Mix 调音台 / Echo 回声 / Modulation 调制 / Stereo 立体声 / TimePitch 变速变调 / Saturate 饱和 / Convolve 卷积混响 / MuseReverb 混响 / Dynamics 动态 / EQ 均衡 / Loudness 响度 / Denoise 降噪 / Repair 修复 / StemSplit 分轨 / NoiseReduction 频谱降噪 / MIR 节拍检测 / Reactive 频段响应 / Analyze 测量 / Visualize 波形图 / Sweep 扫频 / Deconvolve 反卷积 / Meter 电平表 / SegmentExport 分段导出 / ExtractBg·Vocal ⏳ / Demux 分离音轨/画面。

**VideoFX（46）**：Color 一级校色 / CDL / Curves 曲线 / SelectiveColor 可选颜色 / HueCorrect 色相环 / GrayWorld 白平衡 / HistogramEq 直方图 / LUT / ColorSuppress 抑制 / Pseudocolor 假彩 / Posterize 色调分离 / ChromaShift 色偏 / ChromaticAberration 色差 / Stylize 预设 / LensDistort 畸变 / STMapGen+STMap UV 重映射 / LensFlare 光晕 / GodRays 神光 / ZDefocus 散焦 / ArtFX 艺术化 / OldFilm 老片 / Regrain 颗粒 / Glow 辉光 / FrameBlend 帧混 / FeedbackFX 反馈 / GlitchFX 故障 / SlitScan 狭缝 / Strobe 频闪 / Kaleidoscope 万花筒 / WaveWarp 波形 / Water 水面 / LightGraffiti 光绘 / Particles 粒子 / PaintStroke 笔触 / Transform 2D 变换 / Card3D 3D 卡片 / CornerPin 四角 / MotionTrack 跟踪 / MaskPropagate 蒙版传播 / RotoMask 样条蒙版 / ShapeMask 形状蒙版 / FaceBlur 人脸 / SpotRemover 污点 / BlurSharpen / Denoise / Interpolate 插帧 / Deinterlace / Stabilize+Pro / 360+Stabilize / Annotate 标注 / ChromaKey / MatteMonitor+MatteMorph / FXChain 链渲染。

**Video（21）**：Clip 裁剪 / Crop 裁框 / Resize 缩放 / Rotate 旋转 / Speed 变速 / Split 切分 / ExtractFrame 抽帧 / Frames 多帧 / MuxAudio 混流 / Volume 音量 / ContactSheet 宫格 / SceneDetect 切点 / MakeProxy 代理 / KenBurns / Subtitle 字幕 / SubtitleGen STT / Title 标题 / TimeRemap 时间重映射 / VideoUpscale ⏳。

**Image（14）**：ColorGrade 调色 / Crop 裁剪 / Rotate 旋转 / Mirror 镜像 / GridSplit 切格 / Upscale 放大 / Cutout 抠图 / Inpaint 重绘 / Erase 擦除 / Outpaint 扩图 / ImageEdit 指令编辑 / ImageVariations 变体 / Multiangle 新机位 / SplitPart 部件分割 / Poster 排版。

**Compose（12）**：Image/Video/Audio Picker 选择器 / Compare 对比 / Concat 拼接 / Transition 转场 / LumaWipe 划像 / Composite 合成 / Sequence 组装 / ShotImages 分镜出图 / DirectorTimeline 时间线 / TimelineRender 渲染。

**Keying（7）**：Keyer / PIK / Select0r / Despill / KeyMix / MatteMonitor / ColorSuppress。

**3D（6）**：MeshPrimitive 基元 / MeshOp 操作 / MeshBoolean 布尔 / MeshBakeMaps 烘焙 / LineArt 线稿。

**Music（7）**：Score 乐谱 / ScoreEditor 卷帘 / ScoreToMidi 演奏 / SF2Synth 合成 / ChordAccomp 伴奏 / ClickTrack 节拍器 / MidiEditor。

**Panorama（3）**：Panorama 全景 / CurrentView 单视口 / MultiView 多视角。

**Bridge（10）**：To Image/Images/Video/Audio/Text（原生→ComfyTV）、From Image/Mask/Video/Audio/Text（ComfyTV→原生）。

# ComfyUI「去背景」环境安装指南

> 适用对象：想在 Saros 客户端使用「AI 去背景」（表情包抠图 / RemoveBg 节点）的用户。
> 去背景由 **ComfyUI 自定义节点 `saros_cutout`**（`SarosBiRefNetCutout`）执行，Saros 本体不再内置模型。

## 它是怎么工作的

```
Saros 客户端 ──HTTP──> ComfyUI (/upload/image → 三节点工作流 → /view)
                          └─ saros_cutout 节点（onnxruntime，GPU/CPU 自动）
                               └─ models/onnx/BiRefNet-general-epoch_244.onnx
```

| 组件 | 说明 |
|------|------|
| ComfyUI | 任意可访问的部署（本机 / 局域网 / 云端均可） |
| `saros_cutout` 节点 | 源码随 Saros 分发：`resources/comfy-custom-nodes/saros_cutout/`（仓库内：`scripts/comfy-custom-nodes/saros_cutout/`） |
| BiRefNet-general 模型 | `BiRefNet-general-epoch_244.onnx`（972 MB），放入 ComfyUI 的 `models/onnx/` |
| Python 依赖 | 仅 `onnxruntime`（N 卡可装 `onnxruntime-gpu`）；torch/numpy/Pillow 随 ComfyUI 自带 |

---

## 方案 A：一键脚本（推荐）

适合 Windows 用户。脚本做四件事：定位 ComfyUI → 安装节点 → 下载模型 → 安装 onnxruntime。

```powershell
# 1. 若尚未安装 ComfyUI：到 https://github.com/comfyanonymous/ComfyUI/releases/latest
#    下载 ComfyUI_windows_portable_nvidia.7z 并解压（如 D:\ComfyUI_windows_portable）

# 2. 运行脚本（位于 Saros 安装目录 scripts/comfy-setup/）
powershell -ExecutionPolicy Bypass -File setup-saros-cutout.ps1 [-ComfyRoot "D:\ComfyUI_windows_portable\ComfyUI"] [-CpuOnly] [-SkipModel]
```

参数说明：

| 参数 | 作用 |
|------|------|
| `-ComfyRoot <路径>` | 指定 ComfyUI 目录（含 `main.py`）。省略时自动探测常见位置 |
| `-CpuOnly` | 强制 CPU 版 onnxruntime（默认检测到 N 卡时装 GPU 版） |
| `-SkipModel` | 跳过 972 MB 模型下载（已手动放置模型时用） |

完成后启动 ComfyUI，在浏览器验证：

```powershell
powershell -Command "(Invoke-WebRequest 'http://127.0.0.1:8188/object_info').Content -match 'SarosBiRefNetCutout'"
# 输出 True 即成功
```

然后在 Saros 的工作流面板连接 `http://127.0.0.1:8188`（或你的 ComfyUI 地址）即可使用。

## 方案 B：手动安装（无脚本环境 / 其他平台）

> Linux/macOS 用户把路径换为对应位置即可，其余步骤相同。

1. **安装 ComfyUI**（已装可跳过）：参照 [官方仓库](https://github.com/comfyanonymous/ComfyUI) portable 或 `git clone + pip install -r requirements.txt`。
2. **安装节点**：把 `saros_cutout/` 整个目录拷贝到 `ComfyUI/custom_nodes/`：
   ```
   ComfyUI/
   ├─ custom_nodes/
   │   └─ saros_cutout/
   │       └─ __init__.py
   └─ models/
       └─ onnx/
   ```
3. **下载模型**（任选其一，下载后放入 `ComfyUI/models/onnx/`）：
   - GitHub：`https://github.com/ZhengPeng7/BiRefNet/releases/download/v1/BiRefNet-general-epoch_244.onnx`（972 MB）
   - 轻量替代：`BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx`（224 MB，质量略低，节点会自动枚举出该文件名可选）
4. **安装依赖**：
   ```
   # portable 用自带 python：
   ComfyUI\python_embeded\python.exe -m pip install onnxruntime-gpu   # N 卡
   ComfyUI\python_embeded\python.exe -m pip install onnxruntime       # 其他
   ```
5. **启动并验证**：启动 ComfyUI → 打开 `http://127.0.0.1:8188` → 确认无红色报错，`/object_info` 含 `SarosBiRefNetCutout`。

## 方案 C：离线整合包（内网/无外网）

内网管理员操作，普通用户跳过此节：

1. 在有外网的机器上执行方案 A，然后打包以下内容：
   - ComfyUI portable 解压目录（或仅 `custom_nodes/saros_cutout/` + `models/onnx/*.onnx`）
2. 分发到内网机器解压。用户侧只需在 Saros 工作流面板填内网 ComfyUI 地址。

## 方案 E：共享远程 ComfyUI（无 GPU / 不想本地装）

团队部署一台 GPU 机器跑 ComfyUI（按方案 B 配好节点和模型），成员只需：

1. 在 Saros 的工作流面板把 runner 地址填为团队 ComfyUI（如 `http://10.x.x.x:8188`）。
2. 注意：图片会上传到该机器，**敏感图请勿使用共享实例**；多人并发会排队。

---

## 常见问题（Saros 客户端内的三级诊断）

Saros 在去背景失败时按以下顺序给出原因，可对照处理：

| 客户端报错 | 原因 | 处理 |
|------------|------|------|
| `ComfyUI 未连接` | 工作流面板没有可用 runner | 连接一个 ComfyUI 地址（本机默认 `http://127.0.0.1:8188`） |
| `ComfyUI 缺少去背景节点` | 已连接但未装 `saros_cutout`，或节点加载报错 | 按方案 A/B 安装节点；查看 ComfyUI 启动日志有无 import error |
| `ComfyUI 缺少去背景模型` | 节点已装但 `models/onnx/` 里没有 `BiRefNet-general-epoch_244.onnx` | 下载模型放入该目录（见方案 B 第 3 步）；或重跑脚本补模型 |
| 抠图很慢 | 无 GPU 走 CPU 推理 | 正常现象（每张数秒）；有 N 卡可换 `onnxruntime-gpu` |
| `BiRefNet model not found: ...` | 模型文件名不匹配 | 确认文件名完整、在 `models/onnx/` 下、扩展名为 `.onnx` |

## 版本一致性

模型文件名（`DEFAULT_MODEL`）在三处必须一致，升级模型时同步修改：

1. 节点源码：`scripts/comfy-custom-nodes/saros_cutout/__init__.py`
2. 客户端：`webview/src/features/workflowEditor/comfyHost/comfyCutout.ts`（`DEFAULT_CUTOUT_MODEL_FILE`）
3. 安装脚本：`scripts/comfy-setup/setup-saros-cutout.ps1`（`$MODEL_FILE` / `$MODEL_URL`）

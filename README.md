# FastCut 快速剪辑

基于 Electron 的桌面小工具，支持两种视频剪辑方式：

1. **本地文件剪辑** —— 选择本地视频/音频，用 ffmpeg 无损切片导出。
2. **B站外链剪辑** —— 粘贴 B站视频链接（BV 号或 av 号），在程序内加载官方外链播放器，掐点后**内录**片段。

---

## 功能

### 本地文件模式
- 点「选择文件」加载本地视频（mp4 / mkv / mov / avi / webm 等）。
- 播放 / 暂停，点「设为开始」「设为结束」抓取当前时间点。
- 「预览片段」在片段区间循环播放。
- 「导出剪辑」调用 ffmpeg 子进程按 `[-ss, -to]` 无损切片（`-c copy`），落盘到原文件同目录，文件名形如 `原名_clip_起-止.mp4`。

### B站外链模式
- 支持 `BVxxxx`、`av12345`、纯数字 aid，以及含 `bvid` / `aid` 的各种链接。
- 「加载播放器」加载 `player.bilibili.com` 官方外链播放器。
- 「设为开始 / 结束」：Electron 向播放器 iframe 注入 JS，读取内部真实播放时间（绕过跨域限制）。
- 「预览片段」：注入控制播放器跳到开始时间播放，到结束时间暂停。
- 「录制片段（内录）」：在播放器内部对 `<video>` 元素调用 `captureStream()`，直接录制其**音视频流**（不录屏幕、不录其他窗口、声音天然在内），按视频原始分辨率录制（选什么清晰度就录什么清晰度）。到结束时间自动停止并弹出保存对话框。

### 字幕生成
- 本地：ffmpeg 分离音频落 cache wav；在线：取流 API 拿 audioUrl，ffmpeg 直拉流转 cache wav。
- 前台弹出 CLI 窗口跑 Qwen3-ASR-GGUF（`--prec int4`）生成字幕，完成后在视频右侧展示含时间戳的字幕列表，点击可跳转。
- 字幕引擎上游项目：https://github.com/HaujetZhao/Qwen3-ASR-GGUF/

### AI 高能片段
- 右上角「设置」配置 OpenAI 兼容接口（预设 OpenAI / DeepSeek / OpenRouter / 自定义），Key 仅存本地，可一键拉取模型列表。
- 「AI 分析字幕」挖掘有趣直播内容，结果可预览或一键设为剪辑区。

### 其他
- 「登录 B站」按钮：在程序内弹窗打开 `passport.bilibili.com` 登录页，登录后刷新播放器即可使用高画质。
- 已移除默认菜单栏。

---

## 自行编译

### 1. 便携 Python 3.12.3（含 pip）

项目自带与系统隔离的便携 Python（`python/` 目录，供 AI 接口与 Qwen3-ASR-GGUF 共用），二选一安装：

```bat
:: 方案 A：一键脚本（便携 Python + pip + 依赖 + ffmpeg + Qwen 模型全自动）
tools\setup-portable-python.bat
:: 跳过某一步：powershell -ExecutionPolicy Bypass -File tools\setup-portable-python.ps1 -SkipModels
```

```powershell
# 方案 B：手动执行（与脚本等价）
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.12.3/python-3.12.3-embed-amd64.zip" -OutFile "$env:TEMP\py312embed.zip"
Expand-Archive -Path "$env:TEMP\py312embed.zip" -DestinationPath "python" -Force
# 放开 python\python312._pth 中的 import site，再追加一行 ..\Qwen3-ASR-GGUF
# （embed 版是隔离路径，不会自动加载脚本目录，必须加这一行 transcribe 才能被 import）
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile "$env:TEMP\get-pip.py"
.\python\python.exe "$env:TEMP\get-pip.py" --no-warn-script-location
.\python\python.exe -m pip install -U pip setuptools wheel
```

pip 依赖分两组安装：

```bat
:: AI 接口依赖（openai / requests）
.\python\python.exe -m pip install -r python\requirements-ai.txt

:: Qwen3-ASR-GGUF 依赖（去掉 torch；accelerate 用 --no-deps 避免把 torch 拖回来，
:: torch/accelerate 只在 export/ 模型转换脚本里用，转录推理不需要）
.\python\python.exe -m pip install "transformers==4.57.6" onnxruntime-directml gguf nagisa librosa soundfile onnxscript srt sentencepiece typer rich
.\python\python.exe -m pip install accelerate --no-deps
.\python\python.exe -m pip install psutil
```

验证：

```bat
.\python\python.exe --version
:: 应输出 Python 3.12.3
.\python\python.exe Qwen3-ASR-GGUF\transcribe.py --help
```

### 2. ffmpeg

从 https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip 下载 essentials 包，
解压出 `bin/ffmpeg.exe` 放到 `electron/ffmpeg/ffmpeg.exe`（一键脚本会自动做这步）。

### 3. Qwen3-ASR-GGUF 配置

字幕引擎上游项目：https://github.com/HaujetZhao/Qwen3-ASR-GGUF/

1. 把上游仓库内容放到项目根下的 `Qwen3-ASR-GGUF/`（本仓库 `.gitignore` 已排除该目录，需自行放置）。
2. 下载下面两个模型包，解压到 `Qwen3-ASR-GGUF/model/`（一键脚本会自动做这步）：
   - https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-0.6B-gguf.zip
   - https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ForceAligner-0.6B-gguf.zip
3. 最终文件名须与代码期望一致：
   - `qwen3_asr_encoder_frontend.int4.onnx` / `qwen3_asr_encoder_backend.int4.onnx`
   - `qwen3_aligner_encoder_frontend.int4.onnx` / `qwen3_aligner_encoder_backend.int4.onnx`
   - `qwen3_asr_llm.q5_k.gguf` / `qwen3_aligner_llm.q5_k.gguf`
   - 注意：程序调用时传 `--prec int4`；若下载的是 `q4_k` 精度的 gguf，把文件名改成 `q5_k` 即可（loader 只读文件头，名字不影响加载）。
4. 程序按以下顺序查找 Qwen 目录：`FASTCUT_QWEN_DIR` 环境变量 → 项目根下 → 打包后 `resources/` 内 → 安装目录旁，找不到则字幕功能不可用。

### 4. 前端编译与打包

```bash
# 安装依赖（国内建议设置镜像加速 Electron 下载）
npm install

# 开发预览（不打包，直接跑）
npm run start

# 打包成安装程序（nsis），输出 release/FastCut Setup x.x.x.exe
# Qwen3-ASR-GGUF（含 model）与 python/ 会作为 extraResources 打进安装包
npm run dist
```

> 打包使用 `electron-builder`。若 Electron 运行时下载缓慢，可先设置镜像：
> ```bash
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```
> （`npm run dist` 已内置这两个镜像变量。）

> ffmpeg 会在打包时自动复制到 `electron/ffmpeg/`，并作为 `extraResources` 打进安装包，最终用户无需自行安装 ffmpeg。

---

## 已知限制

- **本地文件导出**走 ffmpeg `-c copy` 无损切片，速度快；若需要重新编码可改 `electron/main.js` 的 `export-clip` 参数。
- **B站内录**录制的是播放器实际播放的内容（受当前清晰度、是否有版权限制等影响）。某些加密/特殊渲染的视频可能无法通过 `captureStream` 正常捕获。
- 首次使用「录制片段」时，Windows 可能会弹出屏幕/媒体录制权限请求，需点击允许。
- 外链为在线流，无法像本地文件那样直接切割，因此采用内录方案。

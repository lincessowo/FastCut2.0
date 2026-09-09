# FastCut 一键环境安装脚本（PowerShell）
# 内容：便携 Python 3.12.3 + pip + 依赖 / ffmpeg / Qwen3-ASR-GGUF 模型
# 用法：powershell -ExecutionPolicy Bypass -File tools\setup-portable-python.ps1 [-SkipPython] [-SkipFfmpeg] [-SkipModels]
param([switch]$SkipPython, [switch]$SkipFfmpeg, [switch]$SkipModels)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$PyDir = Join-Path $Root "python"
$Py = Join-Path $PyDir "python.exe"

function Download-File($Url, $Out) {
  Write-Host "下载 $Url ..."
  Invoke-WebRequest -Uri $Url -OutFile $Out
}

# ---------- 1. 便携 Python 3.12.3 ----------
if (-not $SkipPython) {
  $Version = "3.12.3"
  $ZipUrl = "https://www.python.org/ftp/python/$Version/python-$Version-embed-amd64.zip"
  New-Item -ItemType Directory -Force -Path $PyDir | Out-Null
  $zip = Join-Path $env:TEMP "python-$Version-embed.zip"
  if (!(Test-Path $Py)) {
    Download-File $ZipUrl $zip
    Expand-Archive -Path $zip -DestinationPath $PyDir -Force
    Remove-Item $zip -Force
  }
  # 放开 import site，并追加 ..\Qwen3-ASR-GGUF
  # （embed 版是隔离路径，不会自动加载脚本目录，必须加这一行 transcribe 才能被 import；
  #  打包后 python 位于 resources\python，相对路径同样指向 resources\Qwen3-ASR-GGUF）
  $pth = Join-Path $PyDir "python312._pth"
  if (Test-Path $pth) {
    $c = (Get-Content $pth) -replace "^#import site", "import site"
    if ($c -notcontains "..\Qwen3-ASR-GGUF") { $c += "..\Qwen3-ASR-GGUF" }
    $c | Set-Content $pth
  }
  # 安装 pip
  $getPip = Join-Path $env:TEMP "get-pip.py"
  if (!(Test-Path (Join-Path $PyDir "Scripts\pip.exe"))) {
    Download-File "https://bootstrap.pypa.io/get-pip.py" $getPip
    & $Py $getPip --no-warn-script-location
  }
  & $Py -m pip install -U pip setuptools wheel
  & $Py -m pip install -r (Join-Path $Root "python\requirements-ai.txt")
  # Qwen3-ASR-GGUF 依赖（去掉 torch；accelerate 用 --no-deps 避免把 torch 拖回来；
  # torch/accelerate 只在 export/ 模型转换脚本里用，转录推理不需要）
  & $Py -m pip install "transformers==4.57.6" onnxruntime-directml gguf nagisa librosa soundfile onnxscript srt sentencepiece typer rich
  & $Py -m pip install accelerate --no-deps
  & $Py -m pip install psutil
  Write-Host "便携 Python 就绪：$Py"
}

# ---------- 2. ffmpeg ----------
if (-not $SkipFfmpeg) {
  $ffmpegDir = Join-Path $Root "electron\ffmpeg"
  $ffmpegExe = Join-Path $ffmpegDir "ffmpeg.exe"
  New-Item -ItemType Directory -Force -Path $ffmpegDir | Out-Null
  if (!(Test-Path $ffmpegExe)) {
    $zip = Join-Path $env:TEMP "ffmpeg-release-essentials.zip"
    Download-File "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip
    $tmp = Join-Path $env:TEMP "ffmpeg-extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $found = Get-ChildItem $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    if (!$found) { throw "解压包中未找到 ffmpeg.exe" }
    Copy-Item $found.FullName $ffmpegExe -Force
    Remove-Item $zip -Force
    Remove-Item $tmp -Recurse -Force
    Write-Host "ffmpeg 就绪：$ffmpegExe"
  } else {
    Write-Host "ffmpeg 已存在，跳过。"
  }
}

# ---------- 3. Qwen3-ASR-GGUF 模型 ----------
if (-not $SkipModels) {
  $modelDir = Join-Path $Root "Qwen3-ASR-GGUF\model"
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  $urls = @(
    "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ASR-0.6B-gguf.zip",
    "https://github.com/HaujetZhao/Qwen3-ASR-GGUF/releases/download/models/Qwen3-ForceAligner-0.6B-gguf.zip"
  )
  $need = !(Get-ChildItem $modelDir -Filter "*.gguf" -ErrorAction SilentlyContinue)
  if ($need) {
    foreach ($u in $urls) {
      $zip = Join-Path $env:TEMP ([System.IO.Path]::GetFileName(($u -split "\?")[0]))
      Download-File $u $zip
      Expand-Archive -Path $zip -DestinationPath $modelDir -Force
      Remove-Item $zip -Force
    }
    # 压平：若解压出单层子目录，把内容搬到 model 根目录
    $subs = Get-ChildItem $modelDir -Directory
    $topFiles = Get-ChildItem $modelDir -File
    if ($subs.Count -eq 1 -and $topFiles.Count -eq 0) {
      Get-ChildItem $subs[0].FullName | Move-Item -Destination $modelDir -Force
      Remove-Item $subs[0].FullName -Force
    }
    Write-Host "模型已解压到：$modelDir"
  } else {
    Write-Host "模型已存在，跳过下载。"
  }
  # 兜底：代码按 q5_k 文件名查找，若包内是 q4_k 则改名（loader 只读文件头，名字不影响加载）
  foreach ($pair in @(@("qwen3_asr_llm", $modelDir), @("qwen3_aligner_llm", $modelDir))) {
    $q5 = Join-Path $pair[1] ($pair[0] + ".q5_k.gguf")
    $q4 = Join-Path $pair[1] ($pair[0] + ".q4_k.gguf")
    if (!(Test-Path $q5) -and (Test-Path $q4)) {
      Rename-Item -LiteralPath $q4 -NewName ($pair[0] + ".q5_k.gguf")
      Write-Host ("已改名 " + [System.IO.Path]::GetFileName($q4) + " -> " + [System.IO.Path]::GetFileName($q5))
    }
  }
}

Write-Host ""
Write-Host "Done. Run npm run dist to build."

import { app, BrowserWindow, ipcMain, dialog, Menu, desktopCapturer, session } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { getBiliStream, setSessdata, isLoggedIn, getSessdata } from "./bili-api.js";
import { analyzeSubtitles, loadAiConfig, saveAiConfig, fetchModels } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 处理 B站 视频/音轨 CDN 请求：
// 1) 注入 Referer/User-Agent（防盗链/签名校验需要）
// 2) 重写 CORS 响应头为 *（规避 file:// 或 localhost Origin 不匹配导致的跨域卡缓冲）
// 3) 诊断日志，便于排查转圈
function setupBiliRequestHooks() {
  const isBiliMedia = (u) => /bilivideo\.cn|bilivideo\.com|bilibili\.com\/x\/player/i.test(u || "");
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (isBiliMedia(details.url)) {
      details.requestHeaders["Referer"] = "https://www.bilibili.com";
      details.requestHeaders["Origin"] = "https://www.bilibili.com";
      details.requestHeaders["User-Agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const h = details.responseHeaders || {};
    if (isBiliMedia(details.url)) {
      h["Access-Control-Allow-Origin"] = ["*"];
      h["Access-Control-Allow-Methods"] = ["GET, HEAD, OPTIONS"];
      h["Access-Control-Allow-Headers"] = ["*"];
      console.log(`[BILIREQ] ${details.statusCode} ${details.resourceType} ${details.url.slice(0, 70)}`);
    }
    callback({ responseHeaders: h, status: details.status });
  });
}

// 尝试定位 ffmpeg：优先使用打包时附带的，否则用系统 PATH 中的
function findFfmpeg() {
  const candidates = [
    path.join(process.resourcesPath || "", "ffmpeg", "ffmpeg.exe"),
    path.join(__dirname, "..", "ffmpeg", "ffmpeg.exe"),
    "ffmpeg",
  ];
  for (const c of candidates) {
    try {
      if (c === "ffmpeg" || fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return "ffmpeg";
}

const FFMPEG = findFfmpeg();

// Qwen3-ASR-GGUF 目录（不打包进安装包，需外置：开发环境在项目根下，
// 打包后放在安装目录旁的 Qwen3-ASR-GGUF 文件夹，或用环境变量 FASTCUT_QWEN_DIR 指定）
function findQwenDir() {
  let exeDir = "";
  try { exeDir = path.dirname(app.getPath("exe")); } catch {}
  const cands = [
    process.env.FASTCUT_QWEN_DIR || "",
    path.join(__dirname, "..", "Qwen3-ASR-GGUF"),
    path.join(process.resourcesPath || "", "Qwen3-ASR-GGUF"),
    exeDir ? path.join(exeDir, "Qwen3-ASR-GGUF") : "",
    "D:\\vibe\\fastcut2.0\\Qwen3-ASR-GGUF",
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(path.join(c, "transcribe.py"))) return c; } catch {}
  }
  return cands[0];
}
const QWEN_DIR = findQwenDir();

function findPython() {
  const cands = [
    path.join(__dirname, "..", "python", "python.exe"), // 便携 Python 3.12.3（优先）
    path.join(process.resourcesPath || "", "python", "python.exe"), // 打包后
    path.join(QWEN_DIR, ".venv", "Scripts", "python.exe"),
    "D:\\anaconda3\\python.exe",
    "python",
  ];
  for (const c of cands) {
    try { if (c === "python" || fs.existsSync(c)) return c; } catch {}
  }
  return "python";
}
const PYTHON = findPython();

function asrWorkDir() {
  const d = path.join(app.getPath("temp"), "fastcut-asr");
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

function ffmpegToWav(input, wavOut) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", wavOut]);
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(wavOut) : reject(new Error("ffmpeg 分离音频失败\n" + err.slice(-500)))));
  });
}

// 在线音频流 → cache wav：ffmpeg 自带 Referer/UA/Cookie 拉流边下边转，
// 直接落盘为完整 wav（转文字项目不支持流式输入，后续 transcribe 只读本地文件）
function ffmpegStreamToWav(url, wavOut, onTick) {
  return new Promise((resolve, reject) => {
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
    let headers = "Referer: https://www.bilibili.com\r\nOrigin: https://www.bilibili.com\r\n";
    try { const s = getSessdata(); if (s) headers += `Cookie: SESSDATA=${s}\r\n`; } catch {}
    const proc = spawn(FFMPEG, [
      "-y",
      "-user_agent", UA,
      "-headers", headers,
      "-i", url,
      "-vn", "-ac", "1", "-ar", "16000",
      wavOut,
    ]);
    let err = "";
    proc.stderr.on("data", (d) => {
      err += d.toString();
      const m = err.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (m && onTick) {
        const parts = m[m.length - 1].replace("time=", "").split(":");
        onTick((+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(wavOut) : reject(new Error("音频流提取失败\n" + err.slice(-500)))));
  });
}

// 前台弹出 CLI 窗口跑 transcribe.py，同时等待完成。Windows 下用 CREATE_NEW_CONSOLE 新开可见控制台。
// Qwen 为外置目录：用 -c 包一层把 QWEN_DIR 插入 sys.path（便携 python 是隔离路径，不读 cwd/PYTHONPATH）
function runTranscribe(wavFile, event) {
  return new Promise((resolve, reject) => {
    const script = path.join(QWEN_DIR, "transcribe.py");
    const runner = `import sys,runpy;sys.path.insert(0,${JSON.stringify(QWEN_DIR)});sys.argv=[${JSON.stringify(script)},${JSON.stringify(wavFile)},"--prec","int4","-y"];runpy.run_path(${JSON.stringify(script)},run_name="__main__")`;
    const args = ["-c", runner];
    const send = (msg) => { try { event.sender.send("asr-progress", String(msg)); } catch {} };
    send("启动识别窗口：python transcribe.py " + path.basename(wavFile));
    const proc = spawn(PYTHON, args, {
      cwd: QWEN_DIR,
      windowsHide: false,
      creationFlags: 0x10, // CREATE_NEW_CONSOLE：前台显示 CLI 窗口
      env: { ...process.env, KMP_DUPLICATE_LIB_OK: "TRUE", PYTHONIOENCODING: "utf-8" },
    });
    let log = "";
    const onData = (d) => {
      const s = d.toString();
      log += s;
      const lines = s.split(/\r?\n/).filter(Boolean).slice(-3);
      for (const l of lines) send(l.slice(0, 200));
    };
    proc.stdout && proc.stdout.on("data", onData);
    proc.stderr && proc.stderr.on("data", onData);
    proc.on("error", (e) => reject(new Error("无法启动 python（" + PYTHON + "）：" + e.message)));
    proc.on("close", (code) => (code === 0 ? resolve(log) : reject(new Error("字幕生成失败，退出码 " + code + "\n" + log.slice(-800)))));
  });
}

// 移除默认菜单栏
Menu.setApplicationMenu(null);

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    backgroundColor: "#14161a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (fs.existsSync(path.join(__dirname, "..", "dist", "index.html"))) {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    win.loadURL("http://localhost:5173");
  }

  // 拦截 B站播放器内 window.open / target=_blank（切换清晰度等会试图开新窗口），
  // 改为把目标 URL 重定向回我们的播放器 iframe，避免跑出程序。
  const redirectToIframe = (url) => {
    if (!/bilibili\.com/i.test(url)) return false;
    win.webContents
      .executeJavaScript(
        `var f=document.getElementById('bili-iframe'); if(f){ f.src=${JSON.stringify(url)}; }`
      )
      .catch(() => {});
    return true;
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (redirectToIframe(url)) return { action: "deny" };
    return { action: "allow" };
  });

  win.webContents.on("new-window", (event, url) => {
    if (redirectToIframe(url)) event.preventDefault();
  });
}

app.whenReady().then(() => {
  setupBiliRequestHooks();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ---------- IPC ---------- */

ipcMain.handle("pick-file", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "媒体文件", extensions: ["mp4", "mkv", "mov", "avi", "webm", "mp3", "m4a"] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("get-ffmpeg-path", () => FFMPEG);

// 在 B站外链子 frame 中注入 JS 读取播放器内部时间。
// 外链播放器基于 DPlayer，window.player.video.currentTime 即当前播放秒数。
// Electron 不受浏览器同源策略限制，可对任意 frame 执行脚本。
ipcMain.handle("get-bili-time", async (event) => {
  const wc = event.sender;
  const frames = wc.mainFrame ? wc.mainFrame.frames : [];
  for (const frame of frames) {
    try {
      const url = frame.url || "";
      if (!/player\.bilibili\.com/.test(url)) continue;
      const res = await frame.executeJavaScript(
        "(function(){var v=document.querySelector('video');if(v)return v.currentTime;if(window.player&&window.player.video)return window.player.video.currentTime;return 0;})()"
      );
      return typeof res === "number" ? res : 0;
    } catch (e) {
      // 某些 frame 可能尚未就绪，忽略
    }
  }
  return 0;
});

// 找到 B站播放器子 frame
function findBiliFrame(wc) {
  const frames = wc.mainFrame ? wc.mainFrame.frames : [];
  return frames.find((f) => /player\.bilibili\.com/.test(f.url || "")) || null;
}

// 注入控制 B站播放器：seek / play / pause
ipcMain.handle("control-bili", async (event, action, value) => {
  const frame = findBiliFrame(event.sender);
  if (!frame) return false;
  try {
    if (action === "seek") {
      await frame.executeJavaScript(
        `(function(){var v=document.querySelector('video');if(v){v.currentTime=${value};}if(window.player&&window.player.seek){window.player.seek(${value});}})()`
      );
    } else if (action === "play") {
      await frame.executeJavaScript(
        `(function(){var v=document.querySelector('video');if(v)v.play();if(window.player&&window.player.play)window.player.play();})()`
      );
    } else if (action === "pause") {
      await frame.executeJavaScript(
        `(function(){var v=document.querySelector('video');if(v)v.pause();if(window.player&&window.player.pause)window.player.pause();})()`
      );
    }
    return true;
  } catch (e) {
    return false;
  }
});

// 在 B站播放器 frame 内注入钩子：拦截 window.open / 新窗口跳转，
// 改为通过 postMessage 通知父页面，由父页面把 URL 重定向回 iframe（避免弹出新窗口）。
ipcMain.handle("inject-bili-hooks", async (event) => {
  const frame = findBiliFrame(event.sender);
  if (!frame) return false;
  const script = `
    (function(){
      function hook(openFn){
        try {
          openFn = function(url){ parent.postMessage({ type:'bili-open', url: url }, '*'); return null; };
        } catch(e){}
      }
      try {
        var orig = window.open;
        window.open = function(url){ parent.postMessage({ type:'bili-open', url: url }, '*'); return null; };
        if (window.top && window.top !== window) {
          try { window.top.open = function(url){ parent.postMessage({ type:'bili-open', url: url }, '*'); return null; }; } catch(e){}
        }
        if (window.parent && window.parent !== window) {
          try { window.parent.open = function(url){ parent.postMessage({ type:'bili-open', url: url }, '*'); return null; }; } catch(e){}
        }
        // 拦截 <a target=_blank> 点击
        document.addEventListener('click', function(e){
          var a = e.target && e.target.closest ? e.target.closest('a') : null;
          if (a && (a.target === '_blank' || a.getAttribute('target') === '_blank') && a.href) {
            e.preventDefault(); e.stopPropagation();
            parent.postMessage({ type:'bili-open', url: a.href }, '*');
          }
        }, true);
      } catch(e){}
    })();
  `;
  try {
    await frame.executeJavaScript(script);
    return true;
  } catch (e) {
    return false;
  }
});

// 在 app 内用独立窗口打开 B站登录页（避免 shell.openExternal 在某些环境无反应）
ipcMain.handle("open-login", async (_event, url) => {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    title: "登录 B站",
    parent: BrowserWindow.fromWebContents(_event.sender) || undefined,
    modal: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  const grabCookie = () => {
    // SESSDATA 在 .bilibili.com 域下；带 url 过滤更可靠
    session.defaultSession.cookies
      .get({ url: "https://www.bilibili.com" })
      .then((cs) => {
        const s = cs.find((c) => c.name === "SESSDATA");
        if (s) {
          setSessdata(s.value);
          console.log("[LOGIN] SESSDATA 已抓取，长度", s.value.length);
        } else {
          console.log("[LOGIN] 未找到 SESSDATA（可能尚未登录）");
        }
      })
      .catch((e) => console.log("[LOGIN] 抓取失败", e.message));
  };
  // 登录成功后（跳转到主站首页）自动关闭窗口
  win.webContents.on("will-navigate", (e, u) => {
    if (/bilibili\.com\/?($|\?|#)/.test(u) && !/passport/.test(u)) {
      grabCookie();
      setTimeout(() => win.close(), 800);
    }
  });
  win.on("closed", () => {
    grabCookie(); // 兜底抓取（应对已登录直接关闭的情况）
    try {
      _event.sender.send("login-closed");
    } catch {
      /* ignore */
    }
  });
  return true;
});

ipcMain.handle("get-login-state", () => isLoggedIn());

// 根据 bvid/avid 取流：返回可选清晰度列表 + 视频直链 + 音轨直链
ipcMain.handle("bili-get-stream", async (_event, { bvid, avid, page, qn }) => {
  try {
    const stream = await getBiliStream({ bvid, avid, page, qn });
    return { ok: true, ...stream };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 列出可录屏的桌面源（用于内部录屏）
ipcMain.handle("get-sources", async () => {
  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

// 把录制得到的 Blob 数据落盘（弹保存对话框，主进程写文件）
ipcMain.handle("save-recording-to", async (event, bytes, defaultName) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: "视频", extensions: ["webm", "mp4"] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, Buffer.from(bytes));
  return res.filePath;
});

// 在 B站播放器 frame 内直接录制 <video> 的 captureStream（音视频同源，不录屏幕/其他窗口）。
// 注入脚本：seek 到 start 播放，到 end 停止，把 Blob 通过 postMessage 回传父页面。
ipcMain.handle("record-bili", async (event, start, end) => {
  const frame = findBiliFrame(event.sender);
  if (!frame) return { ok: false, error: "未找到播放器" };
  const script = `
    (function(){
      var v = document.querySelector('video');
      if(!v) return parent.postMessage({type:'rec-error', msg:'no video'}, '*');
      var stream = v.captureStream ? v.captureStream(30) : (v.mozCaptureStream ? v.mozCaptureStream(30) : null);
      if(!stream) return parent.postMessage({type:'rec-error', msg:'no captureStream'}, '*');
      var rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      var chunks = [];
      rec.ondataavailable = function(e){ if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function(){
        var blob = new Blob(chunks, { type: 'video/webm' });
        blob.arrayBuffer().then(function(buf){
          parent.postMessage({ type:'rec-done', buf: Array.from(new Uint8Array(buf)) }, '*');
        });
      };
      window.__recEnd = ${end};
      var watch = setInterval(function(){
        if(v.currentTime >= window.__recEnd){ clearInterval(watch); rec.stop(); }
      }, 200);
      v.currentTime = ${start};
      setTimeout(function(){ v.play(); rec.start(200); }, 300);
    })();
  `;
  try {
    await frame.executeJavaScript(script);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// AI 配置存取（key 落盘在 userData/ai-config.json）
ipcMain.handle("ai-load-config", () => loadAiConfig());
ipcMain.handle("ai-save-config", (_e, cfg) => saveAiConfig(cfg || {}));
ipcMain.handle("ai-list-models", async (_e, opts = {}) => {
  try {
    const saved = loadAiConfig();
    const models = await fetchModels({
      baseUrl: opts.baseUrl || saved.baseUrl,
      apiKey: opts.apiKey ?? saved.apiKey,
    });
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// AI 分析字幕 → 有趣直播片段（OpenAI 兼容接口，主进程转发避开 CORS）
ipcMain.handle("ai-analyze", async (_e, opts = {}) => {
  try {
    const saved = loadAiConfig();
    const clips = await analyzeSubtitles({
      baseUrl: opts.baseUrl || saved.baseUrl,
      apiKey: opts.apiKey ?? saved.apiKey,
      model: opts.model || saved.model,
      segments: opts.segments || [],
      extra: opts.extra || "",
      duration: opts.duration || 0,
      onProgress: (done, total) => {
        try { _e.sender.send("ai-progress", { done, total }); } catch {}
      },
    });
    return { ok: true, clips };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 生成字幕：本地=ffmpeg分离音频落cache wav；在在线=取流API拿audioUrl，ffmpeg直拉流转cache wav；
// 统一读本地 wav 前台CLI跑Qwen生成
ipcMain.handle("gen-subtitles", async (event, opts = {}) => {
  const work = asrWorkDir();
  const tag = Date.now();
  try {
    const wav = path.join(work, `asr_${tag}.wav`);
    event.sender.send("asr-progress", "准备音频…");
    if (opts.mode === "bili") {
      const stream = await getBiliStream({ bvid: opts.bvid, avid: opts.avid, page: opts.page || 1, qn: opts.qn || 80 });
      if (!stream.audioUrl) throw new Error("该视频无分离音轨（durl 直链），请换清晰度或分P重试");
      event.sender.send("asr-progress", "拉取音频流…");
      await ffmpegStreamToWav(stream.audioUrl, wav, (sec) => {
        try { event.sender.send("asr-progress", `音频流转码缓存中…${sec.toFixed(0)}s`); } catch {}
      });
    } else {
      if (!opts.input || !fs.existsSync(opts.input)) throw new Error("本地文件不存在");
      event.sender.send("asr-progress", "ffmpeg 分离音频…");
      await ffmpegToWav(opts.input, wav);
    }
    event.sender.send("asr-progress", "弹出识别窗口，正在生成字幕…");
    await runTranscribe(wav, event);
    const base = wav.replace(/\.wav$/i, "");
    let segments = [];
    const jsonFile = base + ".json";
    if (fs.existsSync(jsonFile)) {
      try { segments = JSON.parse(fs.readFileSync(jsonFile, "utf-8")); } catch {}
    }
    let srt = "";
    const srtFile = base + ".srt";
    if (fs.existsSync(srtFile)) srt = fs.readFileSync(srtFile, "utf-8");
    if (!segments.length && !srt) throw new Error("未生成字幕结果，请查看识别窗口报错");
    return { ok: true, segments, srt, wav, srtFile, jsonFile, title: opts.title || "" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 用 ffmpeg 子进程裁剪，通过 stdout 解析进度
ipcMain.handle("export-clip", (event, { input, start, end, output }) => {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss", String(start),
      "-to", String(end),
      "-i", input,
      "-c", "copy",
      "-y",
      output,
    ];
    const proc = spawn(FFMPEG, args);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      // 解析 Duration / time= 进度
      const m = stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/g);
      if (m) {
        const last = m[m.length - 1];
        const parts = last.replace("time=", "").split(":");
        const sec = (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
        const total = end - start;
        const pct = Math.min(100, Math.max(0, (sec / total) * 100));
        event.sender.send("export-progress", pct.toFixed(1));
      }
    });
    proc.on("error", (e) => reject(e));
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error("ffmpeg 退出码 " + code + "\n" + stderr.slice(-500)));
    });
  });
});

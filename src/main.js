const video = document.getElementById("video");
const pickLocal = document.getElementById("pick-local");
const loadLocalBtn = document.getElementById("load-local");
const fileName = document.getElementById("file-name");
const biliUrl = document.getElementById("bili-url");
const loadBiliBtn = document.getElementById("load-bili");
const btnBiliLogin = document.getElementById("btn-bili-login");
const loginState = document.getElementById("login-state");

async function refreshLoginState() {
  try {
    const ok = await window.api.getLoginState();
    loginState.textContent = ok ? "已登录（可高画质）" : "未登录";
    loginState.classList.toggle("on", !!ok);
  } catch {
    loginState.textContent = "未登录";
  }
}
const biliIframe = document.getElementById("bili-iframe");
const biliCurrent = document.getElementById("bili-current");

const startTime = document.getElementById("start-time");
const endTime = document.getElementById("end-time");
const btnSetStart = document.getElementById("btn-set-start");
const btnSetEnd = document.getElementById("btn-set-end");
const btnPreview = document.getElementById("btn-preview");
const btnExport = document.getElementById("btn-export");
const exportStatus = document.getElementById("export-status");

const modeLocal = document.getElementById("mode-local");
const modeBili = document.getElementById("mode-bili");
const viewLocal = document.getElementById("view-local");
const viewBili = document.getElementById("view-bili");

let currentFile = null;
let localObjectUrl = null;

// B站模式状态
let biliStream = null; // 取流结果：{ videoUrl, audioUrl, qualities, ... }
let biliVideoUrl = null;
let biliTime = 0; // 来自播放器 iframe 的当前时间
let biliParsed = null; // 当前解析出的 { type, id, page }

/* ---------- 模式切换 ---------- */
function setMode(mode) {
  const isLocal = mode === "local";
  modeLocal.classList.toggle("active", isLocal);
  modeBili.classList.toggle("active", !isLocal);
  viewLocal.classList.toggle("hidden", !isLocal);
  viewBili.classList.toggle("hidden", isLocal);
  btnExport.disabled = isLocal ? !currentFile : true;
  if (isLocal) stopBiliSync();
  else startBiliSync();
}
modeLocal.addEventListener("click", () => setMode("local"));
modeBili.addEventListener("click", () => setMode("bili"));

/* ---------- 本地文件：系统对话框选择 ---------- */
pickLocal.addEventListener("click", async () => {
  const p = await window.api.pickFile();
  if (!p) return;
  currentFile = p;
  fileName.textContent = p.split(/[\\/]/).pop();
  loadLocalBtn.disabled = false;
  btnExport.disabled = false;
});

loadLocalBtn.addEventListener("click", () => {
  if (!currentFile) return;
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
  localObjectUrl = "file:///" + currentFile.replace(/\\/g, "/");
  video.src = localObjectUrl;
  video.load();
  exportStatus.textContent = "";
});

// 登录窗口关闭后：SESSDATA 已被主进程抓取，刷新播放器以应用登录态（高画质）
window.api.onLoginClosed && window.api.onLoginClosed(() => {
  refreshLoginState();
  if (!viewLocal.classList.contains("hidden")) return;
  if (biliUrl.value) loadBiliBtn.click();
});

/* ---------- 解析 B站视频 ID ---------- */
function parseVideoId(input) {
  const s = input.trim();
  if (!s) return null;
  let m = s.match(/\bBV[0-9A-Za-z]+\b/i);
  if (m) return { type: "bvid", id: m[0] };
  m = s.match(/\b(?:av(\d+)|(\d{4,}))\b/i);
  if (m) return { type: "aid", id: m[1] || m[2] };
  m = s.match(/[?&]bvid=(BV[0-9A-Za-z]+)/i);
  if (m) return { type: "bvid", id: m[1] };
  m = s.match(/[?&]aid=(\d+)/i);
  if (m) return { type: "aid", id: m[1] };
  m = s.match(/\/(BV[0-9A-Za-z]+)/i);
  if (m) return { type: "bvid", id: m[1] };
  m = s.match(/\/av(\d+)/i);
  if (m) return { type: "aid", id: m[1] };
  return null;
}

btnBiliLogin.addEventListener("click", () => {
  window.api.openLogin("https://passport.bilibili.com/login");
});
refreshLoginState();

// 加载 B站视频：取流 API 拿到直链，用自有播放器（bili-player.html）播放
async function loadBili() {
  if (!biliParsed) {
    const parsed = parseVideoId(biliUrl.value);
    if (!parsed) {
      alert("无法从输入中解析出 BV 号或 av 号，请确认格式。");
      return;
    }
    biliParsed = parsed;
    biliParsed.page = parseInt((biliUrl.value.match(/[?&]p=(\d+)/i) || [])[1] || "1", 10);
  }
  const qn = parseInt(document.getElementById("bili-quality").value, 10) || 80;
  exportStatus.textContent = "获取视频流…";
  loadBiliBtn.disabled = true;
  const res = await window.api.getBiliStream({
    bvid: biliParsed.type === "bvid" ? biliParsed.id : undefined,
    avid: biliParsed.type === "aid" ? biliParsed.id : undefined,
    page: biliParsed.page,
    qn,
  });
  loadBiliBtn.disabled = false;
  if (!res || !res.ok) {
    alert("获取视频流失败：" + ((res && res.error) || "未知错误") + "\n（720P+ 需要登录后重试）");
    exportStatus.textContent = "失败";
    return;
  }
  biliStream = res;
  biliVideoUrl = res.videoUrl;
  // 加载自有播放器页面（本地），再把 MPD 通过 postMessage 传进去
  biliIframe.src = "bili-player.html";
  const onReady = () => {
    biliIframe.removeEventListener("load", onReady);
    setTimeout(() => {
      biliIframe.contentWindow &&
        biliIframe.contentWindow.postMessage({ type: "bili-load", mpd: res.mpd }, "*");
    }, 400);
  };
  biliIframe.addEventListener("load", onReady, { once: true });
  // 填充分P/清晰度提示
  const qnList = (res.qualities || []).map((q) => `qn${q.id}`).join(", ");
  exportStatus.textContent =
    `已加载《${(res.title || "").slice(0, 20)}》 可选清晰度: ${qnList || "默认"}（解析中…）`;
  btnExport.disabled = true; // B站模式走内录
}

loadBiliBtn.addEventListener("click", () => {
  biliParsed = null; // 重新解析输入
  loadBili();
});

// 切换清晰度：用已解析的 id 重新取流（无需重新输入链接）
document.getElementById("bili-quality").addEventListener("change", () => {
  if (biliParsed) loadBili();
});

/* ---------- 时间获取 ---------- */
function isBiliMode() {
  return viewLocal.classList.contains("hidden");
}

async function getCurrentTime() {
  if (!viewLocal.classList.contains("hidden")) {
    return video.currentTime;
  }
  return biliTime;
}

btnSetStart.addEventListener("click", async () => {
  startTime.value = (await getCurrentTime()).toFixed(1);
});
btnSetEnd.addEventListener("click", async () => {
  endTime.value = (await getCurrentTime()).toFixed(1);
});

// 同步 B站播放进度展示
let syncTimer = null;
function startBiliSync() {
  stopBiliSync();
  syncTimer = setInterval(() => {
    if (viewLocal.classList.contains("hidden") && !isNaN(biliTime)) {
      biliCurrent.textContent = biliTime.toFixed(1) + "s";
    }
  }, 250);
}
function stopBiliSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

// 向播放器 iframe 发控制指令
function biliControl(type, payload) {
  biliIframe.contentWindow &&
    biliIframe.contentWindow.postMessage({ type, ...payload }, "*");
}

btnPreview.addEventListener("click", async () => {
  const s = parseFloat(startTime.value) || 0;
  const e = parseFloat(endTime.value) || 0;
  if (s >= e) {
    alert("结束时间必须大于开始时间");
    return;
  }
  if (!isBiliMode()) {
    video.currentTime = s;
    video.play();
    const stop = () => {
      if (video.currentTime >= e) {
        video.pause();
        video.removeEventListener("timeupdate", stop);
      }
    };
    video.addEventListener("timeupdate", stop);
    return;
  }
  // B站模式：自有播放器 seek+play
  biliControl("bili-seek", { time: s });
  biliControl("bili-play");
  const watch = setInterval(async () => {
    if (biliTime >= e) {
      biliControl("bili-pause");
      clearInterval(watch);
    }
  }, 300);
  setTimeout(() => clearInterval(watch), (e - s) * 1000 + 15000);
});

/* ---------- 本地文件导出（ffmpeg 裁剪） ---------- */
btnExport.addEventListener("click", async () => {
  if (isBiliMode()) {
    alert("B站模式请使用「录制片段（内录）」按钮。");
    return;
  }
  if (!currentFile) return;
  const s = parseFloat(startTime.value) || 0;
  const e = parseFloat(endTime.value) || 0;
  if (s >= e) {
    alert("结束时间必须大于开始时间");
    return;
  }
  const outPath = currentFile.replace(/(\.[^.]+)?$/, `_clip_${s}-${e}.mp4`);
  btnExport.disabled = true;
  exportStatus.textContent = "裁剪中 0%";
  const off = window.api.onExportProgress((p) => {
    exportStatus.textContent = `裁剪中 ${p}%`;
  });
  try {
    const res = await window.api.exportClip({
      input: currentFile,
      start: s,
      end: e,
      output: outPath,
    });
    exportStatus.textContent = "完成：" + res;
  } catch (err) {
    console.error(err);
    alert("导出失败：" + err.message);
    exportStatus.textContent = "失败";
  } finally {
    off && off();
    btnExport.disabled = false;
  }
});

setMode("local");

/* ---------- 接收播放器 iframe 消息 ---------- */
window.addEventListener("message", async (ev) => {
  const d = ev.data;
  if (!d) return;
  // 播放器定期回报当前时间
  if (d.type === "bili-time") {
    biliTime = d.time || 0;
    return;
  }
  // 播放器已就绪（MPD 解析完成、拿到时长）
  if (d.type === "bili-ready") {
    const qnList = (biliStream && biliStream.qualities || []).map((q) => `qn${q.id}`).join(", ");
    exportStatus.textContent =
      `已加载《${(biliStream && biliStream.title || "").slice(0, 20)}》 清晰度: ${qnList || "默认"}`;
    return;
  }
  if (d.type === "bili-error") {
    exportStatus.textContent = "播放错误：" + (d.msg || "");
    return;
  }
  // 录制结果
  if (d.type === "rec-done" && pendingRecord) {
    pendingRecord = false;
    exportStatus.textContent = "保存中…";
    try {
      const finalPath = await window.api.saveRecordingTo(
        d.buf,
        `fastcut_bili_${pendingS}-${pendingE}.webm`
      );
      exportStatus.textContent = "完成：" + finalPath;
    } catch (err) {
      exportStatus.textContent = "保存失败：" + err.message;
    }
    btnRecord.disabled = false;
  } else if (d.type === "rec-error" && pendingRecord) {
    pendingRecord = false;
    alert("录制失败：" + d.msg);
    exportStatus.textContent = "失败";
    btnRecord.disabled = false;
  }
});

let pendingRecord = false;
let pendingS = 0;
let pendingE = 0;

const btnRecord = document.getElementById("btn-record");
btnRecord.addEventListener("click", async () => {
  if (!isBiliMode()) {
    alert("内录仅用于 B站模式。");
    return;
  }
  if (!biliStream) {
    alert("请先加载 B站视频。");
    return;
  }
  const s = parseFloat(startTime.value) || 0;
  const e = parseFloat(endTime.value) || 0;
  if (s >= e) {
    alert("结束时间必须大于开始时间");
    return;
  }
  pendingRecord = true;
  pendingS = s;
  pendingE = e;
  btnRecord.disabled = true;
  exportStatus.textContent = "录制中…（内录自有播放器音视频）";
  // 交给 iframe 内的播放器自己录制 captureStream
  biliControl("bili-record-start", { start: s, end: e });
});

/* ---------- 字幕生成 + 右侧展示 ---------- */
const btnAsr = document.getElementById("btn-asr");
const asrStatus = document.getElementById("asr-status");
const subList = document.getElementById("sub-list");
const subCount = document.getElementById("sub-count");
let subSegments = [];

function fmtT(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(4, "0")}`;
}

function renderSubs(segs) {
  subSegments = segs || [];
  subCount.textContent = subSegments.length ? `共 ${subSegments.length} 条` : "";
  subList.innerHTML = "";
  if (!subSegments.length) {
    subList.innerHTML = `<div class="sub-empty">未识别到语音</div>`;
    return;
  }
  for (let i = 0; i < subSegments.length; i++) {
    const g = subSegments[i];
    const b = document.createElement("button");
    b.className = "sub-item";
    b.dataset.i = i;
    b.innerHTML = `<div class="t">${fmtT(g.start)} → ${fmtT(g.end)}</div><div class="c"></div>`;
    b.querySelector(".c").textContent = g.text || "";
    b.addEventListener("click", () => seekTo(g.start));
    subList.appendChild(b);
  }
}

function seekTo(t) {
  if (!isBiliMode()) { video.currentTime = t; video.play().catch(() => {}); }
  else { biliControl("bili-seek", { time: t }); biliControl("bili-play"); }
}

function markActive(cur) {
  const items = subList.querySelectorAll(".sub-item");
  if (!items.length) return;
  let hit = -1;
  for (let i = 0; i < subSegments.length; i++) {
    if (cur >= subSegments[i].start && cur <= subSegments[i].end) { hit = i; break; }
  }
  items.forEach((el) => el.classList.toggle("active", +el.dataset.i === hit));
  if (hit >= 0 && items[hit]) items[hit].scrollIntoView({ block: "nearest" });
}
video.addEventListener("timeupdate", () => { if (!isBiliMode()) markActive(video.currentTime); });
setInterval(() => { if (isBiliMode()) markActive(biliTime); }, 500);

btnAsr.addEventListener("click", async () => {
  const bili = isBiliMode();
  let opts;
  if (bili) {
    if (!biliParsed) { alert("请先粘贴链接并加载 B站视频。"); return; }
    opts = { mode: "bili", bvid: biliParsed.type === "bvid" ? biliParsed.id : undefined, avid: biliParsed.type === "aid" ? biliParsed.id : undefined, page: biliParsed.page || 1, qn: parseInt(document.getElementById("bili-quality").value, 10) || 80 };
  } else {
    if (!currentFile) { alert("请先选择本地文件。"); return; }
    opts = { mode: "local", input: currentFile };
  }
  btnAsr.disabled = true;
  asrStatus.textContent = "开始生成…（将弹出 CLI 识别窗口）";
  window.api.onAsrProgress((p) => { asrStatus.textContent = p; });
  try {
    const res = await window.api.genSubtitles(opts);
    if (!res || !res.ok) { alert("生成失败：" + ((res && res.error) || "未知错误")); asrStatus.textContent = "失败"; return; }
    renderSubs(res.segments);
    asrStatus.textContent = `完成：${res.segments.length} 条${res.srtFile ? "（" + res.srtFile + "）" : ""}`;
  } catch (e) {
    alert("生成失败：" + e.message);
    asrStatus.textContent = "失败";
  } finally {
    btnAsr.disabled = false;
  }
});

/* ---------- 设置弹窗（AI 服务商 / Key / 模型） ---------- */
const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  custom: { baseUrl: "http://localhost:11434/v1", model: "" },
};
const settingsModal = document.getElementById("settings-modal");
const aiBase = document.getElementById("ai-base");
const aiModel = document.getElementById("ai-model");
const aiModelList = document.getElementById("ai-model-list");
const aiKey = document.getElementById("ai-key");
const btnModels = document.getElementById("btn-models");
const btnAiSave = document.getElementById("btn-ai-save");
const settingsStatus = document.getElementById("settings-status");
const providerBtns = [...document.querySelectorAll(".provider-btn")];
let aiProvider = "openai";

function markProvider(p) {
  aiProvider = p;
  providerBtns.forEach((b) => b.classList.toggle("active", b.dataset.provider === p));
}
providerBtns.forEach((b) => b.addEventListener("click", () => {
  markProvider(b.dataset.provider);
  const d = PROVIDERS[aiProvider];
  aiBase.value = d.baseUrl;
  if (d.model) aiModel.value = d.model;
  settingsStatus.textContent = "";
}));

document.getElementById("btn-settings").addEventListener("click", () => settingsModal.classList.remove("hidden"));
document.getElementById("btn-settings-close").addEventListener("click", () => settingsModal.classList.add("hidden"));
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.classList.add("hidden"); });

function readAiCfg() {
  return { provider: aiProvider, baseUrl: aiBase.value.trim(), model: aiModel.value.trim(), apiKey: aiKey.value.trim() };
}

(async () => {
  try {
    const cfg = await window.api.aiLoadConfig();
    if (cfg) {
      markProvider(cfg.provider || "openai");
      aiBase.value = cfg.baseUrl || "";
      aiModel.value = cfg.model || "";
      aiKey.value = cfg.apiKey || "";
    } else markProvider("openai");
  } catch { markProvider("openai"); }
})();

btnAiSave.addEventListener("click", async () => {
  await window.api.aiSaveConfig(readAiCfg());
  settingsStatus.textContent = "已保存到本地";
  setTimeout(() => settingsModal.classList.add("hidden"), 500);
});

btnModels.addEventListener("click", async () => {
  btnModels.disabled = true;
  settingsStatus.textContent = "拉取模型列表…";
  try {
    const res = await window.api.aiListModels({ baseUrl: aiBase.value.trim(), apiKey: aiKey.value.trim() });
    if (!res || !res.ok) { settingsStatus.textContent = "获取失败：" + ((res && res.error) || "未知错误"); return; }
    aiModelList.innerHTML = "";
    for (const id of res.models) {
      const o = document.createElement("option");
      o.value = id;
      aiModelList.appendChild(o);
    }
    if (res.models.includes(aiModel.value.trim())) { /* 已选模型仍有效 */ }
    else if (PROVIDERS[aiProvider] && res.models.includes(PROVIDERS[aiProvider].model)) aiModel.value = PROVIDERS[aiProvider].model;
    else aiModel.value = res.models[0];
    settingsStatus.textContent = `共 ${res.models.length} 个模型，可在输入框下拉选择`;
  } catch (e) {
    settingsStatus.textContent = "获取失败：" + e.message;
  } finally {
    btnModels.disabled = false;
  }
});

/* ---------- AI 分析字幕 → 有趣直播片段 ---------- */
const aiExtra = document.getElementById("ai-extra");
const btnAi = document.getElementById("btn-ai");
const aiStatus = document.getElementById("ai-status");
const aiList = document.getElementById("ai-list");

function applyClip(c, hint) {
  startTime.value = c.start.toFixed(1);
  endTime.value = c.end.toFixed(1);
  seekTo(c.start);
  aiStatus.textContent = hint || `已设为剪辑区：${fmtT(c.start)} → ${fmtT(c.end)}，可预览/导出`;
}

function renderClips(clips) {
  aiList.innerHTML = "";
  if (!clips.length) { aiList.innerHTML = `<div class="sub-empty">AI 未找到有趣片段，换个要求重试</div>`; return; }
  clips.forEach((c, i) => {
    const singing = c.type === "singing";
    const d = document.createElement("div");
    d.className = "ai-item";
    d.innerHTML = `<div class="ai-title"><span class="score">#${i + 1} ${c.score}分</span><span class="ai-type ${singing ? "singing" : ""}">${singing ? "唱歌" : "高能"}</span></div>
      <div class="ai-time clickable" title="点击应用到剪辑区"></div>
      <div class="ai-reason"></div>
      <div class="ai-ops"><button data-a="play">预览</button></div>`;
    d.querySelector(".ai-title").append(document.createTextNode(c.title));
    d.querySelector(".ai-time").textContent = `${fmtT(c.start)} → ${fmtT(c.end)}`;
    d.querySelector(".ai-reason").textContent = c.reason || "";
    d.querySelector('[data-a="play"]').addEventListener("click", () => seekTo(c.start));
    d.querySelector(".ai-time").addEventListener("click", () => applyClip(c));
    aiList.appendChild(d);
  });
}

window.api.onAiProgress && window.api.onAiProgress(({ done, total }) => {
  aiStatus.textContent = total > 1 ? `AI 分析中 ${done}/${total} 段…` : "AI 分析中…";
});

btnAi.addEventListener("click", async () => {
  if (!subSegments.length) { alert("请先生成字幕。"); return; }
  const cfg = readAiCfg();
  if (!cfg.apiKey) { alert("请先点右上角“设置”填写 API Key。"); settingsModal.classList.remove("hidden"); return; }
  if (!cfg.model) { alert("请先到设置里选择模型。"); settingsModal.classList.remove("hidden"); return; }
  await window.api.aiSaveConfig(cfg);
  btnAi.disabled = true;
  aiStatus.textContent = "AI 分析中…";
  try {
    const res = await window.api.aiAnalyze({
      baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey,
      extra: aiExtra.value.trim(), segments: subSegments,
    });
    if (!res || !res.ok) { alert("AI 分析失败：" + ((res && res.error) || "未知错误")); aiStatus.textContent = "失败"; return; }
    renderClips(res.clips);
    aiStatus.textContent = `完成：${res.clips.length} 个高能片段`;
  } catch (e) {
    alert("AI 分析失败：" + e.message);
    aiStatus.textContent = "失败";
  } finally {
    btnAi.disabled = false;
  }
});

setMode("local");

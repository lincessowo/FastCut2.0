import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

// OpenAI 兼容接口：分析字幕，挖掘直播有趣/高能片段
// 支持官方 OpenAI、DeepSeek、通义、Ollama、vLLM 等任何 /v1/chat/completions 兼容服务

const SYSTEM_PROMPT = `你是直播切片助手。用户给你带绝对时间戳的字幕（秒，格式 [开始-结束] 文本，字幕可能分多次发来，每次会注明是第几段），请从中挖掘两类内容：
1. 高能片段：搞笑名场面、高能操作、情绪爆发、金句、反转、观众爱看的梗。
2. 唱歌片段：主播唱歌/哼歌的时间段。只根据字幕判断（歌词、语气词、观众反应等）；不知道歌名时 title 写“唱歌（未知歌曲）”之类，绝对不要编造歌名。
要求：
1. 只基于字幕内容，不编造事件和时间；时间戳直接使用字幕中的绝对时间，不要偏移。
2. 合并相邻相关字幕为一个片段，单个片段 15~180 秒。
3. 每个片段给出 start/end（秒，数字）、title（≤16字）、reason（≤40字，说明发生了什么）、score（0~100）、type（高能填 "highlight"，唱歌填 "singing"）。
4. 按 score 从高到低排序，最多 20 个。
5. 只输出纯 JSON 数组，不要 markdown、不要解释。例如：
[{"start":12.5,"end":48.0,"title":"主播破防名场面","reason":"连续口误引发弹幕狂欢","score":95,"type":"highlight"},{"start":120.0,"end":200.0,"title":"唱歌（未知歌曲）","reason":"连续歌词，观众刷好听","score":88,"type":"singing"}]`;

// 15万上下文 - 2万输出预留 - 提示词余量，单次输入预算
const MAX_INPUT_TOKENS = 128000;

function estimateTokens(s) {
  let cjk = 0, other = 0;
  for (const ch of String(s || "")) {
    if (/[\u3040-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

// 按 token 预算把字幕切分成多段（时间戳保持绝对时间，无需回算偏移）
function chunkSegments(segments) {
  const chunks = [];
  let cur = [], curTok = 0;
  for (const s of segments || []) {
    const line = `[${Number(s.start || 0).toFixed(1)}-${Number(s.end || 0).toFixed(1)}] ${(s.text || "").trim()}`;
    if (!line.trim()) continue;
    const t = estimateTokens(line) + 1;
    if (cur.length && curTok + t > MAX_INPUT_TOKENS) { chunks.push(cur); cur = []; curTok = 0; }
    cur.push({ start: Number(s.start || 0), end: Number(s.end || 0), text: (s.text || "").trim(), line });
    curTok += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function extractJson(text) {
  if (!text) return [];
  let t = String(text).trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("[");
  const b = t.lastIndexOf("]");
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  const arr = JSON.parse(t);
  return Array.isArray(arr) ? arr : [];
}

function normalizeClips(arr, duration = 0) {
  return (arr || [])
    .map((c) => ({
      start: Math.max(0, Number(c.start) || 0),
      end: Math.max(0, Number(c.end) || 0),
      title: String(c.title || c.name || "未命名片段").slice(0, 30),
      reason: String(c.reason || c.desc || "").slice(0, 80),
      score: Math.min(100, Math.max(0, Number(c.score) || 80)),
      type: c.type === "singing" ? "singing" : "highlight",
    }))
    .filter((c) => c.end > c.start && c.end - c.start <= 600);
}

// 分段结果合并：重叠过半只留高分者，最后按分排序取前 20
function dedupeClips(clips) {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.start < last.end) {
      const overlap = Math.min(c.end, last.end) - Math.max(c.start, last.start);
      const minLen = Math.min(c.end - c.start, last.end - last.start);
      if (minLen > 0 && overlap / minLen > 0.5) {
        if (c.score > last.score) out[out.length - 1] = c;
        continue;
      }
    }
    out.push(c);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 20);
}

function configPath() {
  return path.join(app.getPath("userData"), "ai-config.json");
}

export const PROVIDERS = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  custom: { name: "自定义", baseUrl: "http://localhost:11434/v1", model: "" },
};

export function loadAiConfig() {
  try {
    if (fs.existsSync(configPath())) return { provider: "openai", ...JSON.parse(fs.readFileSync(configPath(), "utf-8")) };
  } catch {}
  return { provider: "openai", ...PROVIDERS.openai, apiKey: "" };
}

export function saveAiConfig(cfg) {
  const cur = loadAiConfig();
  const next = { ...cur, ...cfg };
  fs.writeFileSync(configPath(), JSON.stringify({ ...next, apiKey: next.apiKey || "" }, null, 2));
  return next;
}

export async function analyzeSubtitles({ baseUrl, apiKey, model, segments, extra = "", duration = 0, onProgress }) {
  if (!apiKey) throw new Error("请先到设置里填写 API Key");
  if (!segments || !segments.length) throw new Error("暂无字幕，请先生成字幕");
  if (!model) throw new Error("请先到设置里选择模型");
  const url = String(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "") + "/chat/completions";
  const chunks = chunkSegments(segments);
  if (!chunks.length) throw new Error("字幕为空");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 600000);
  const post = (userText, withJsonMode) =>
    fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
        temperature: 0.3,
        ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  try {
    const all = [];
    for (let i = 0; i < chunks.length; i++) {
      const multi = chunks.length > 1;
      const head = `字幕（共${segments.length}条${multi ? `，这是第 ${i + 1}/${chunks.length} 段` : ""}，时间戳为绝对时间，请直接使用）：\n`;
      const userText = head + chunks[i].map((s) => s.line).join("\n") + (extra ? `\n补充要求：${extra}` : "");
      let res = await post(userText, true);
      let data = await res.json().catch(() => ({}));
      // 部分渠道/模型不支持 response_format：降级重试一次
      if (!res.ok && /response_format|json mode|json_object/i.test(data?.error?.message || "") && res.status === 400) {
        res = await post(userText, false);
        data = await res.json().catch(() => ({}));
      }
      if (!res.ok) throw new Error(`第 ${i + 1}/${chunks.length} 段失败：${data?.error?.message || `HTTP ${res.status}`}`);
      let content = data?.choices?.[0]?.message?.content || "";
      // 兼容 json_object 包一层 {"clips":[...]}
      try {
        const obj = JSON.parse(content);
        if (obj && !Array.isArray(obj)) content = JSON.stringify(obj.clips || obj.data || obj.results || []);
      } catch {}
      for (const c of normalizeClips(extractJson(content), duration)) all.push(c);
      try { onProgress && onProgress(i + 1, chunks.length); } catch {}
    }
    return dedupeClips(all);
  } finally {
    clearTimeout(timer);
  }
}

// 通过 OpenAI 兼容的 GET /models 拉取可用模型列表
export async function fetchModels({ baseUrl, apiKey }) {
  if (!apiKey) throw new Error("请先填写 API Key 再获取列表");
  const url = String(baseUrl || "https://api.openai.com/v1").replace(/\/$/, "") + "/models";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    const ids = (data?.data || []).map((m) => m.id).filter(Boolean).sort();
    if (!ids.length) throw new Error("该接口未返回模型列表");
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

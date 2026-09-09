import { net } from "electron";
import crypto from "node:crypto";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

// 主进程向 B站 API 发请求（渲染进程受 CORS 限制，必须在主进程请求）。
// 登录态通过 SESSDATA cookie 携带：720P+ 需要登录。

let cachedSessdata = "";

export function setSessdata(s) {
  if (s) cachedSessdata = s;
}
export function getSessdata() {
  return cachedSessdata;
}
export function isLoggedIn() {
  return !!cachedSessdata && cachedSessdata.length > 0;
}

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 57, 56, 30, 4, 22, 25, 54, 21, 6, 63, 36, 20, 34, 44, 52, 11,
  60, 62, 59, 51, 23, 6, 6, 6,
];

function getMixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  let key = "";
  for (const i of MIXIN_KEY_ENC_TAB) key += orig[i];
  return key.slice(0, 32);
}

function signWbi(params, mixinKey) {
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  return crypto
    .createHash("md5")
    .update(query + mixinKey)
    .digest("hex");
}

function httpGet(url, cookies) {
  return new Promise((resolve, reject) => {
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      Referer: "https://www.bilibili.com",
      Origin: "https://www.bilibili.com",
    };
    if (cookies) headers["Cookie"] = cookies;
    const req = net.request({ url, headers, method: "GET" });
    let data = "";
    req.on("response", (res) => {
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          fs.appendFileSync(
            path.join(app.getPath("userData"), "bili-debug.log"),
            `[${new Date().toISOString()}] ${res.statusCode} ${url}\n${data.slice(0, 600)}\n\n`
          );
        } catch {}
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("JSON 解析失败: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let mixinKeyCache = null;
async function fetchMixinKey() {
  if (mixinKeyCache) return mixinKeyCache;
  const cookies = cachedSessdata ? `SESSDATA=${cachedSessdata}` : "";
  const nav = await httpGet("https://api.bilibili.com/x/web-interface/nav", cookies);
  const wbi = nav.data && nav.data.wbi_img;
  if (!wbi) throw new Error("获取 Wbi 密钥失败，可能未登录或网络异常");
  const imgKey = path.basename(wbi.img_url).split(".")[0];
  const subKey = path.basename(wbi.sub_url).split(".")[0];
  mixinKeyCache = getMixinKey(imgKey, subKey);
  return mixinKeyCache;
}

async function playUrl({ bvid, avid, cid, qn, fnval }) {
  const mixinKey = await fetchMixinKey();
  const params = {};
  if (bvid) params.bvid = bvid;
  if (avid) params.aid = String(avid);
  params.cid = String(cid);
  params.qn = String(qn || 80);
  params.fnval = String(fnval || 4048);
  params.fnver = "0";
  params.fourk = "1";
  params.wts = String(Math.floor(Date.now() / 1000));
  const w_rid = signWbi(params, mixinKey);
  params.w_rid = w_rid;
  const query = Object.keys(params)
    .map((k) => `${k}=${encodeURIComponent(params[k])}`)
    .join("&");
  const cookies = cachedSessdata ? `SESSDATA=${cachedSessdata}` : "";
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${query}`;
  return httpGet(url, cookies);
}

// 取得视频所有分P信息（cid 列表）
async function viewInfo({ bvid, avid }) {
  const cookies = cachedSessdata ? `SESSDATA=${cachedSessdata}` : "";
  const params = bvid ? `bvid=${bvid}` : `aid=${avid}`;
  return httpGet(`https://api.bilibili.com/x/web-interface/view?${params}`, cookies);
}

// 用 Range 请求拉取直链前 256KB，解析 fragmented mp4 的
// moov（初始化段）与 sidx（索引段）偏移，用于构造 DASH SegmentBase。
async function probeRanges(url) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    Referer: "https://www.bilibili.com",
    Origin: "https://www.bilibili.com",
    Range: "bytes=0-262143",
  };
  if (cachedSessdata) headers["Cookie"] = `SESSDATA=${cachedSessdata}`;
  const res = await fetch(url, { headers });
  const buf = Buffer.from(await res.arrayBuffer());
  // 解析 box 树（前几个顶层 box）
  let off = 0;
  let moovEnd = 0;
  let sidxRange = null;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (size < 8) break;
    const end = off + size;
    if (type === "moov") moovEnd = end;
    if (type === "sidx") sidxRange = [off, end - 1];
    off = end;
  }
  if (!moovEnd) moovEnd = 4096; // 兜底
  return { initRange: `0-${moovEnd - 1}`, indexRange: sidxRange ? `${sidxRange[0]}-${sidxRange[1]}` : null };
}

// 对外：根据输入解析出分P列表与每个P的可选清晰度、直链 + MPD
export async function getBiliStream({ bvid, avid, page = 1, qn = 80 }) {
  const view = await viewInfo({ bvid, avid });
  if (view.code !== 0) throw new Error(`view code=${view.code}: ${view.message}`);
  const pages = view.data.pages || [];
  const cid = (pages[page - 1] && pages[page - 1].cid) || (pages[0] && pages[0].cid);
  if (!cid) throw new Error("未找到分P信息");
  const res = await playUrl({ bvid, avid, cid, qn, fnval: 4048 });
  if (res.code !== 0) throw new Error(`playurl code=${res.code}: ${res.message}`);

  const data = res.data;
  const qualities = [];
  let chosenV = null;
  let audioUrl = null;
  let aCodec = "mp4a.40.2";
  let aBand = 0;
  if (data.dash) {
    const vs = data.dash.video || [];
    for (const v of vs) {
      qualities.push({ id: v.id, desc: v.codecs || `qn${v.id}`, url: v.baseUrl, bandwidth: v.bandwidth });
    }
    // 优先选 AVC(h264) 编码（兼容性最好，HEVC 在部分环境无法硬解）
    const avc = vs.filter((v) => /avc1/i.test(v.codecs || ""));
    const pickFrom = avc.length ? avc : vs;
    chosenV = pickFrom.find((v) => v.id === qn) || pickFrom.sort((a, b) => b.id - a.id)[0];
    const as = (data.dash.audio || []).slice().sort((a, b) => b.bandwidth - a.bandwidth);
    if (as[0]) {
      audioUrl = as[0].baseUrl;
      aCodec = as[0].codecs || aCodec;
      aBand = as[0].bandwidth || 0;
    }
  } else if (data.durl) {
    for (const q of data.accept_quality || []) {
      qualities.push({ id: q, desc: "mp4", url: data.durl[0].url, bandwidth: 0 });
    }
    chosenV = { baseUrl: data.durl[0].url, id: data.accept_quality ? data.accept_quality[0] : 0, codecs: "avc1.640028", bandwidth: 0 };
    audioUrl = null; // 老 MP4 已含音轨
  }

  if (!chosenV) throw new Error("未获取到可播放的视频直链");
  const videoUrl = chosenV.baseUrl;
  const vCodec = chosenV.codecs || "avc1.640028";
  const vBand = chosenV.bandwidth || 1000000;
  const duration = (data.dash && data.dash.duration) || 0;

  // 构造 MPD（视频 + 音轨分离）
  const mpd = await buildMpdString({ videoUrl, audioUrl, vCodec, aCodec, vBand, aBand, duration });

  return {
    title: view.data.title,
    cid,
    page,
    totalPages: pages.length,
    qualities,
    videoUrl,
    audioUrl,
    mpd,
    // 直链有效期约 120 分钟
  };
}

// XML 转义（直链含 & 等字符会破坏 MPD 解析）
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function buildMpdString({ videoUrl, audioUrl, vCodec, aCodec, vBand, aBand, duration }) {
  // 探测用原始 URL；写入 XML 时需转义
  const vRanges = await probeRanges(videoUrl).catch(() => ({ initRange: "0-4095", indexRange: null }));
  let aRanges = null;
  if (audioUrl) {
    aRanges = await probeRanges(audioUrl).catch(() => ({ initRange: "0-4095", indexRange: null }));
  }
  const vUrlXml = xmlEscape(videoUrl);
  const aUrlXml = audioUrl ? xmlEscape(audioUrl) : null;
  const durAttr = duration ? ` mediaPresentationDuration="PT${duration}S"` : "";
  const videoAS = `
    <AdaptationSet id="1" contentType="video" segmentAlignment="true" startWithSAP="1">
      <Representation id="v" mimeType="video/mp4" codecs="${vCodec}" bandwidth="${vBand}">
        <BaseURL>${vUrlXml}</BaseURL>
        <SegmentBase indexRange="${vRanges.indexRange || "0-0"}">
          <Initialization range="${vRanges.initRange}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>`;
  const audioAS = audioUrl
    ? `
    <AdaptationSet id="2" contentType="audio" segmentAlignment="true" startWithSAP="1">
      <Representation id="a" mimeType="audio/mp4" codecs="${aCodec}" bandwidth="${aBand}">
        <BaseURL>${aUrlXml}</BaseURL>
        <SegmentBase indexRange="${aRanges.indexRange || "0-0"}">
          <Initialization range="${aRanges.initRange}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:mpeg:dash:schema:mpd:2011 DASH-MPD.xsd" type="static"${durAttr} minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-main:2011">
  <Period>
    ${videoAS}${audioAS}
  </Period>
</MPD>`;
}


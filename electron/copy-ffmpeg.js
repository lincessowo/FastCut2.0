import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const destDir = path.join(__dirname, "ffmpeg");
mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, "ffmpeg.exe");

if (!existsSync(dest)) {
  // 优先使用系统 PATH 中的 ffmpeg，否则尝试常见安装路径
  let src = "ffmpeg";
  try {
    src = execSync("where ffmpeg").toString().split("\r\n")[0].trim();
  } catch {
    const guesses = [
      "C:/ffmpeg/bin/ffmpeg.exe",
      "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
    ];
    src = guesses.find((g) => existsSync(g)) || src;
  }
  if (src && src !== "ffmpeg") {
    copyFileSync(src, dest);
    console.log("已复制 ffmpeg 到", dest);
  } else {
    console.warn("未找到系统 ffmpeg，打包时不会包含；运行时将依赖用户 PATH。");
  }
}

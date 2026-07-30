import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 单文件打包会把 KaTeX 引用到的所有字体（woff2 / woff / ttf）都内联成 data URI，
 * 而现代浏览器只用 woff2 即可。这里在打包前把 KaTeX CSS 里的 woff / truetype
 * 字体来源剔除，只保留 woff2，避免 index.html 体积翻倍（约省 1.3MB）。
 */
function stripKatexLegacyFonts() {
  return {
    name: "strip-katex-legacy-fonts",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("katex") || !id.endsWith(".css")) return null;
      const out = code
        .replace(/,\s*url\([^)]+\)\s*format\((["']?)woff\1\)/g, "")
        .replace(/,\s*url\([^)]+\)\s*format\((["']?)truetype\1\)/g, "");
      return { code: out, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [stripKatexLegacyFonts(), react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});

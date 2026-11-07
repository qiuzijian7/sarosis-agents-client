// vite.config.js —— 多页入口（MPA）。
// 项目含两个独立 HTML 入口：index.html（标准版）/ pixel.html（像素版）。
// Vite 默认只构建 index.html，显式列出 rollupOptions.input 才能让 build 同时产出 pixel.html。
// 不改动任何已有的标准版行为；仅新增 pixel 入口。
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pixel: resolve(__dirname, "pixel.html"),
      },
    },
  },
});

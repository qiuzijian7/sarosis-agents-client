// vite.config.js —— 多页入口（MPA）。
// 项目含四个独立 HTML 入口：index.html（标准版）/ pixel.html（像素版）/ cartoon.html（卡通版）/ anime.html（二次元版）。
// Vite 默认只构建 index.html，显式列出 rollupOptions.input 才能让 build 同时产出各入口。
// 不改动任何已有的标准版行为；仅新增 pixel / cartoon / anime 入口。
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pixel: resolve(__dirname, "pixel.html"),
        cartoon: resolve(__dirname, "cartoon.html"),
        anime: resolve(__dirname, "anime.html"),
      },
    },
  },
});

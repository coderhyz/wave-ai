/** @type {import('next').NextConfig} */
const nextConfig = {
  // PDF 解析使用 Node 原生 Canvas 和 Worker，不能由 Next 打包为浏览器模块。
  serverExternalPackages: [
    "pdf-parse",
    "@napi-rs/canvas",
    "mammoth",
    "turndown",
    "turndown-plugin-gfm",
    "yauzl",
    "jszip",
    "ali-oss",
  ],
}

export default nextConfig

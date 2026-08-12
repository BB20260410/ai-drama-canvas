/**
 * Core 与 Renderer 共用的纯数据合同。
 *
 * 此模块禁止导入 Node/Electron 依赖，避免剪辑台为了读取上限而把 editor.ts、sharp
 * 和文件系统实现打进浏览器 bundle。
 */
export const MAX_EDIT_TIMELINE_SECONDS = 6 * 60 * 60;

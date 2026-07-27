import { createApp } from "vue";
import App from "./App.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import "./design-tokens.css";
import "./styles.css";
import { readManagedCanvasTheme, syncDocumentCanvasTheme } from "./managed-canvas-theme";

// P29：启动时把已存主题同步到 <html data-theme>，全局 token 层与画布同肤。
syncDocumentCanvasTheme(readManagedCanvasTheme());

createApp(App).mount("#app");

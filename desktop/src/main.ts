import { createApp } from "vue";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "./style.css";
import App from "./App.vue";
import { invoke, listen } from "./lib/bridge";
import { applyUiTheme } from "./lib/settings";
import { flushBeforeExit, openProject } from "./lib/store";
import { installMenuBar } from "./lib/menu";

function report(level: "error" | "warn" | "info", message: string) {
  void invoke("frontend_log", { level, message }).catch(() => undefined);
}
window.addEventListener("error", (e) => report("error", `${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener("unhandledrejection", (e) => report("error", `Unhandled rejection: ${String(e.reason)}`));

applyUiTheme();
void installMenuBar();
const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  report("error", `${err instanceof Error ? err.stack ?? err.message : String(err)} [${info}]`);
  console.error(err);
};
app.mount("#app");
report("info", "frontend mounted");

// Never lose the last keystrokes: saving happens before the app quits. Closing the window
// (titlebar button, ⌘W) and quitting (⌘Q) are held by the main process until `confirm_exit`;
// `app://exit-requested` asks the UI to save first.
window.addEventListener("blur", () => void flushBeforeExit().catch(() => undefined));
void listen("app://exit-requested", async () => {
  await flushBeforeExit().catch(() => undefined);
  await invoke("confirm_exit").catch(() => undefined);
}).catch(() => undefined);

void invoke<string | null>("initial_project").then((path) => {
  if (path) void openProject(path);
});

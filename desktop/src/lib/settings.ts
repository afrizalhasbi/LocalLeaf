// Editor preferences (Overleaf's Settings modal), persisted per machine.
import { reactive, watch } from "vue";
import { readStored, writeStored } from "./storage";

export type OverallTheme = "dark" | "light" | "system";
export type EditorThemeId = "overleaf-dark" | "overleaf-light" | "textmate" | "solarized-dark" | "monokai";
export type Keybindings = "default" | "vim" | "emacs";
export type FontFamily = "jetbrains" | "monaco" | "menlo" | "sf-mono" | "courier";
export type LineHeight = "compact" | "normal" | "wide";

export interface Settings {
  /** Schema version, used to migrate saved preferences. */
  version: number;
  overallTheme: OverallTheme;
  editorTheme: EditorThemeId | "auto";
  fontSize: number;
  fontFamily: FontFamily;
  lineHeight: LineHeight;
  keybindings: Keybindings;
  lineWrapping: boolean;
  autoComplete: boolean;
  autoCloseBrackets: boolean;
  highlightActiveLine: boolean;
  /** System spell checker in the editor (it also flags LaTeX commands, hence off by default). */
  spellCheck: boolean;
}

const SETTINGS_VERSION = 2;

const DEFAULTS: Settings = {
  version: SETTINGS_VERSION,
  overallTheme: "dark",
  editorTheme: "auto",
  fontSize: 14,
  fontFamily: "jetbrains",
  lineHeight: "normal",
  keybindings: "default",
  lineWrapping: true,
  autoComplete: true,
  autoCloseBrackets: true,
  highlightActiveLine: true,
  spellCheck: false,
};

export const FONT_FAMILIES: Record<FontFamily, { label: string; css: string }> = {
  jetbrains: { label: "JetBrains Mono", css: '"JetBrains Mono", Menlo, Monaco, monospace' },
  monaco: { label: "Monaco / Menlo", css: 'Monaco, Menlo, "Ubuntu Mono", Consolas, monospace' },
  menlo: { label: "Menlo", css: "Menlo, Monaco, Consolas, monospace" },
  "sf-mono": { label: "SF Mono", css: '"SF Mono", ui-monospace, Menlo, monospace' },
  courier: { label: "Courier", css: '"Courier New", Courier, monospace' },
};

export const LINE_HEIGHTS: Record<LineHeight, { label: string; value: number }> = {
  compact: { label: "Compact", value: 1.33 },
  normal: { label: "Normal", value: 1.6 },
  wide: { label: "Wide", value: 2 },
};

const KEY = "settings";

function load(): Settings {
  try {
    const raw = readStored(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const saved = { ...DEFAULTS, ...parsed } as Settings;
      // v2: JetBrains Mono became the default code font.
      if ((parsed.version ?? 1) < 2) saved.fontFamily = "jetbrains";
      saved.version = SETTINGS_VERSION;
      return saved;
    }
  } catch {
    /* storage unavailable: fall back to defaults */
  }
  return { ...DEFAULTS };
}

export const settings = reactive<Settings>(load());

watch(
  settings,
  (value) => {
    try {
      writeStored(KEY, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
  { deep: true },
);

const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

export function isDarkUi(): boolean {
  return settings.overallTheme === "system" ? systemDark.matches : settings.overallTheme === "dark";
}

export function effectiveEditorTheme(): EditorThemeId {
  if (settings.editorTheme !== "auto") return settings.editorTheme;
  return isDarkUi() ? "overleaf-dark" : "overleaf-light";
}

/** Keeps the `dark` class on <html> in sync with the overall theme. */
export function applyUiTheme() {
  const update = () => document.documentElement.classList.toggle("dark", isDarkUi());
  watch(() => settings.overallTheme, update, { immediate: true });
  systemDark.addEventListener("change", update);
}

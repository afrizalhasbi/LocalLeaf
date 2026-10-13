// CodeMirror 6 configuration for LaTeX: themes, autocompletion and Overleaf shortcuts.
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { EditorSelection, type Extension } from "@codemirror/state";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { EditorThemeId } from "./settings";
import { COMMANDS, ENVIRONMENTS, PACKAGES, dirname } from "./latex";
import { allFiles, projectBibKeys, projectLabels, recentlyRan, state } from "./store";
import { toggleComment } from "@codemirror/commands";

export const latexLanguage = StreamLanguage.define(stex);

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

interface Palette {
  dark: boolean;
  bg: string;
  fg: string;
  gutterBg: string;
  gutterFg: string;
  gutterBorder: string;
  activeLine: string;
  activeGutter: string;
  selection: string;
  cursor: string;
  command: string;
  math: string;
  arg: string;
  bracket: string;
  comment: string;
  number: string;
  matchBracket: string;
  searchMatch: string;
}

const PALETTES: Record<EditorThemeId, Palette> = {
  "overleaf-dark": {
    dark: true, bg: "#1e2530", fg: "#e7e9ee", gutterBg: "#1e2530", gutterFg: "#677283", gutterBorder: "#2f3a4c",
    activeLine: "#262f3c", activeGutter: "#2f3a4c", selection: "#3a4d6b", cursor: "#f4f5f6",
    command: "#7aa5f0", math: "#f0b86c", arg: "#9ad38c", bracket: "#c3c9d4", comment: "#7d8796", number: "#e88f8f",
    matchBracket: "#4a5a72", searchMatch: "#6b5a1e",
  },
  "overleaf-light": {
    dark: false, bg: "#ffffff", fg: "#1b222c", gutterBg: "#f4f5f6", gutterFg: "#8a94a5", gutterBorder: "#e7e9ee",
    activeLine: "#f4f8ff", activeGutter: "#e7e9ee", selection: "#c9daf8", cursor: "#1b222c",
    command: "#2457b8", math: "#a3531c", arg: "#1e7b34", bracket: "#495365", comment: "#7c8698", number: "#b83a33",
    matchBracket: "#d6e4ff", searchMatch: "#fde68a",
  },
  textmate: {
    dark: false, bg: "#ffffff", fg: "#000000", gutterBg: "#ebebeb", gutterFg: "#333333", gutterBorder: "#ebebeb",
    activeLine: "#f5f5f5", activeGutter: "#dcdcdc", selection: "#b5d5ff", cursor: "#000000",
    command: "#0000ff", math: "#a020f0", arg: "#318495", bracket: "#000000", comment: "#236e24", number: "#0000cd",
    matchBracket: "#c0c0c0", searchMatch: "#fffb7a",
  },
  "solarized-dark": {
    dark: true, bg: "#002b36", fg: "#93a1a1", gutterBg: "#01313f", gutterFg: "#586e75", gutterBorder: "#01313f",
    activeLine: "#073642", activeGutter: "#073642", selection: "#0f4a5a", cursor: "#d30102",
    command: "#268bd2", math: "#cb4b16", arg: "#859900", bracket: "#93a1a1", comment: "#586e75", number: "#d33682",
    matchBracket: "#1f5563", searchMatch: "#584b0e",
  },
  monokai: {
    dark: true, bg: "#272822", fg: "#f8f8f2", gutterBg: "#2f3129", gutterFg: "#8f908a", gutterBorder: "#2f3129",
    activeLine: "#3e3d32", activeGutter: "#3e3d32", selection: "#49483e", cursor: "#f8f8f0",
    command: "#66d9ef", math: "#e6db74", arg: "#a6e22e", bracket: "#f8f8f2", comment: "#75715e", number: "#ae81ff",
    matchBracket: "#55554a", searchMatch: "#6b5f1e",
  },
};

export const EDITOR_THEMES: { id: EditorThemeId; label: string }[] = [
  { id: "overleaf-light", label: "Overleaf Light" },
  { id: "overleaf-dark", label: "Overleaf Dark" },
  { id: "textmate", label: "Textmate" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "monokai", label: "Monokai" },
];

export function editorTheme(id: EditorThemeId, fontSize: number, fontFamily: string, lineHeight: number): Extension {
  const p = PALETTES[id];
  const theme = EditorView.theme(
    {
      "&": { color: p.fg, backgroundColor: p.bg, height: "100%", fontSize: `${fontSize}px` },
      ".cm-scroller": { fontFamily, lineHeight: String(lineHeight) },
      ".cm-content": { caretColor: p.cursor, padding: "4px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: p.cursor, borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: p.selection },
      ".cm-activeLine": { backgroundColor: p.activeLine },
      ".cm-gutters": { backgroundColor: p.gutterBg, color: p.gutterFg, borderRight: `1px solid ${p.gutterBorder}` },
      ".cm-activeLineGutter": { backgroundColor: p.activeGutter, color: p.fg },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "36px" },
      ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer" },
      "&.cm-focused .cm-matchingBracket": { backgroundColor: p.matchBracket, outline: "none" },
      ".cm-searchMatch": { backgroundColor: p.searchMatch },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: p.selection },
      ".cm-panels": { backgroundColor: p.gutterBg, color: p.fg, borderColor: p.gutterBorder },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${p.gutterBorder}` },
      ".cm-tooltip": { backgroundColor: p.bg, color: p.fg, border: `1px solid ${p.gutterBorder}`, borderRadius: "4px" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#098842", color: "#fff" },
      ".cm-tooltip-autocomplete > ul": { fontFamily, maxHeight: "16em" },
      ".cm-completionDetail": { opacity: "0.65", fontStyle: "normal", marginLeft: "1em" },
      ".cm-texcraft-flash": { backgroundColor: p.dark ? "#3d4f2a" : "#fff3b0", transition: "background-color 1s" },
    },
    { dark: p.dark },
  );
  const highlight = HighlightStyle.define([
    { tag: t.tagName, color: p.command },
    { tag: t.keyword, color: p.math, fontWeight: "600" },
    { tag: t.atom, color: p.arg },
    { tag: t.bracket, color: p.bracket },
    { tag: t.comment, color: p.comment, fontStyle: "italic" },
    { tag: t.number, color: p.number },
    { tag: [t.string, t.special(t.variableName)], color: p.math },
    { tag: t.invalid, color: p.fg },
  ]);
  return [theme, syntaxHighlighting(highlight)];
}

// ---------------------------------------------------------------------------
// Autocompletion
// ---------------------------------------------------------------------------

const CITE_CMDS = /^(cite|citep|citet|citeauthor|citeyear|parencite|textcite|autocite|footcite|nocite|Cite|Citep|Citet)$/;
const REF_CMDS = /^(ref|eqref|autoref|cref|Cref|pageref|nameref|vref)$/;

function commandCompletions(): Completion[] {
  const cmds = COMMANDS.map((c) =>
    c.snippet
      ? snippetCompletion(c.snippet, { label: `\\${c.name}`, type: "keyword", detail: c.info })
      : { label: `\\${c.name}`, type: "keyword" },
  );
  const envs = ENVIRONMENTS.filter((e) => e !== "document").map((env) => {
    const body = env === "itemize" || env === "enumerate" ? "\t\\item #{}" : env.startsWith("figure")
      ? "\t\\centering\n\t\\includegraphics[width=\\linewidth]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}"
      : env.startsWith("table") ? "\t\\centering\n\t\\begin{tabular}{#{c c}}\n\t\t#{}\n\t\\end{tabular}\n\t\\caption{#{}}"
      : "\t#{}";
    return snippetCompletion(`\\begin{${env}}\n${body}\n\\end{${env}}`, {
      label: `\\begin{${env}}`,
      type: "class",
      detail: "environment",
    });
  });
  return [...cmds, ...envs];
}

let cachedCommands: Completion[] | null = null;

export function latexCompletions(ctx: CompletionContext): CompletionResult | null {
  // Inside an argument: \cite{a, b|}, \ref{|}, \begin{|}, \includegraphics{|} ...
  const arg = ctx.matchBefore(/\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^}{]*)$/);
  if (arg) {
    const m = /\\([a-zA-Z]+)\*?(?:\[[^\]]*\])*\{([^}{]*)$/.exec(arg.text)!;
    const cmd = m[1];
    const inside = m[2];
    const partial = inside.slice(inside.lastIndexOf(",") + 1).trimStart();
    const from = ctx.pos - partial.length;
    let options: Completion[] = [];
    if (CITE_CMDS.test(cmd)) {
      options = projectBibKeys().map((b) => ({ label: b.key, type: "text", detail: b.info.slice(0, 60) }));
    } else if (REF_CMDS.test(cmd)) {
      options = projectLabels().map((l) => ({ label: l, type: "variable" }));
    } else if (cmd === "begin" || cmd === "end") {
      options = ENVIRONMENTS.map((e) => ({ label: e, type: "class" }));
    } else if (cmd === "usepackage" || cmd === "RequirePackage") {
      options = PACKAGES.map((p) => ({ label: p, type: "namespace" }));
    } else if (cmd === "includegraphics") {
      options = relativeFiles(/\.(png|jpe?g|pdf|eps|svg)$/i, false);
    } else if (cmd === "input" || cmd === "include" || cmd === "subfile") {
      options = relativeFiles(/\.tex$/i, cmd === "include");
    } else if (cmd === "bibliography" || cmd === "addbibresource") {
      options = relativeFiles(/\.bib$/i, cmd === "bibliography");
    } else {
      return null;
    }
    return { from, options, validFor: /^[^,}\s]*$/ };
  }

  const word = ctx.matchBefore(/\\[a-zA-Z*]*/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  cachedCommands ??= commandCompletions();
  return { from: word.from, options: cachedCommands, validFor: /^\\[a-zA-Z*{]*$/ };
}

/** Project files relative to the open file's folder, as LaTeX expects them. */
function relativeFiles(pattern: RegExp, stripExt: boolean): Completion[] {
  const base = dirname(state.openPath ?? "");
  return allFiles(state.tree)
    .filter((p) => pattern.test(p))
    .map((p) => {
      let rel = base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
      if (stripExt) rel = rel.replace(/\.[^.]+$/, "");
      return { label: rel, type: "text" };
    });
}

// ---------------------------------------------------------------------------
// Overleaf keyboard shortcuts
// ---------------------------------------------------------------------------

export function wrapSelection(before: string, after: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => ({
        changes: [
          { from: range.from, insert: before },
          { from: range.to, insert: after },
        ],
        range: EditorSelection.range(range.from + before.length, range.to + before.length),
      })),
    );
    return true;
  };
}

export function overleafKeymap(actions: { compile: () => void; save: () => void }): KeyBinding[] {
  return [
    { key: "Mod-Enter", run: () => (actions.compile(), true), preventDefault: true },
    { key: "Mod-s", run: () => (actions.save(), actions.compile(), true), preventDefault: true },
    // Also reachable from the menu bar; `recentlyRan` keeps one keypress from applying twice.
    { key: "Mod-b", run: (v) => recentlyRan("bold") || wrapSelection("\\textbf{", "}")(v) },
    { key: "Mod-i", run: (v) => recentlyRan("italic") || wrapSelection("\\textit{", "}")(v) },
    { key: "Mod-/", run: (v) => recentlyRan("comment") || toggleComment(v) },
  ];
}

export { keymap };

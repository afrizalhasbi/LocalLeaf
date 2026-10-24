<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import {
  autocompletion,
  closeBracketsKeymap,
  completionKeymap,
  snippet,
  startCompletion,
} from "@codemirror/autocomplete";
import { gotoLine, highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { toggleComment } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { emacs } from "@replit/codemirror-emacs";
import {
  editorTheme,
  latexAutoClose,
  latexCompletions,
  latexLanguage,
  overleafKeymap,
  reliableDragSelection,
  tabAcceptsCompletion,
  wrapSelection,
} from "../lib/editor";
import { FONT_FAMILIES, LINE_HEIGHTS, effectiveEditorTheme, isDarkUi, settings } from "../lib/settings";
import { compile, editorBridge, recentlyRan, save, state, updateContent, type EditorCommand } from "../lib/store";

const host = ref<HTMLDivElement>();
let view: EditorView | null = null;

const themeConf = new Compartment();
const keybindingsConf = new Compartment();
const wrapConf = new Compartment();
const completeConf = new Compartment();
const bracketsConf = new Compartment();
const activeLineConf = new Compartment();
const spellConf = new Compartment();

function themeExt(): Extension {
  return editorTheme(
    effectiveEditorTheme(),
    settings.fontSize,
    FONT_FAMILIES[settings.fontFamily].css,
    LINE_HEIGHTS[settings.lineHeight].value,
  );
}
const keybindingsExt = (): Extension =>
  settings.keybindings === "vim" ? vim() : settings.keybindings === "emacs" ? emacs() : [];
const wrapExt = (): Extension => (settings.lineWrapping ? EditorView.lineWrapping : []);
const completeExt = (): Extension =>
  settings.autoComplete ? autocompletion({ override: [latexCompletions], icons: false }) : [];
const bracketsExt = (): Extension => (settings.autoCloseBrackets ? latexAutoClose() : []);
const spellExt = (): Extension =>
  EditorView.contentAttributes.of({ spellcheck: settings.spellCheck ? "true" : "false", autocorrect: "off", autocapitalize: "off" });
const activeLineExt = (): Extension => (settings.highlightActiveLine ? [highlightActiveLine(), highlightActiveLineGutter()] : []);
// WebKitGTK (Tauri's Linux webview) fails to repaint CodeMirror's drawn selection
// layer, so on Linux we keep the browser's own selection rendering instead.
const isLinux = navigator.userAgent.includes("Linux");

// Briefly highlights the line we jumped to (SyncTeX, log entries, outline).
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-texcraft-flash" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function extensions(): Extension[] {
  return [
    // Vim/Emacs must win over the default keymaps.
    Prec.highest(keybindingsConf.of(keybindingsExt())),
    Prec.high(keymap.of(overleafKeymap({ compile: () => void compile(), save: () => void save() }))),
    tabAcceptsCompletion,
    reliableDragSelection(),
    lineNumbers(),
    highlightSpecialChars(),
    history(),
    isLinux ? [] : drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    indentUnit.of("    "),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightSelectionMatches(),
    latexLanguage,
    flashField,
    activeLineConf.of(activeLineExt()),
    bracketsConf.of(bracketsExt()),
    completeConf.of(completeExt()),
    wrapConf.of(wrapExt()),
    themeConf.of(themeExt()),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
    spellConf.of(spellExt()),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) updateContent(u.state.doc.toString());
      if (u.selectionSet || u.docChanged) {
        const head = u.state.selection.main.head;
        const line = u.state.doc.lineAt(head);
        state.cursor = { line: line.number, col: head - line.from + 1 };
      }
    }),
  ];
}

function setContent(text: string) {
  if (!view) return;
  // A fresh state per file gives each file its own undo history, like switching docs in Overleaf.
  view.setState(EditorState.create({ doc: text, extensions: extensions() }));
  state.cursor = { line: 1, col: 1 };
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function goto(lineNumber: number, column = 1) {
  if (!view) return;
  const doc = view.state.doc;
  const line = doc.line(Math.min(Math.max(1, lineNumber), doc.lines));
  const pos = Math.min(line.from + Math.max(0, column - 1), line.to);
  view.dispatch({
    selection: { anchor: pos },
    effects: [EditorView.scrollIntoView(pos, { y: "center" }), flashEffect.of(line.from)],
  });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => view?.dispatch({ effects: flashEffect.of(null) }), 1500);
}

function runCommand(cmd: EditorCommand) {
  if (!view) return;
  view.focus();
  switch (cmd) {
    case "find":
      openSearchPanel(view);
      break;
    case "replace":
      openSearchPanel(view);
      requestAnimationFrame(() => view?.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus());
      break;
    case "gotoLine":
      gotoLine(view);
      break;
    case "comment":
      if (!recentlyRan("comment")) toggleComment(view);
      break;
    case "bold":
      if (!recentlyRan("bold")) wrapSelection("\\textbf{", "}")(view);
      break;
    case "italic":
      if (!recentlyRan("italic")) wrapSelection("\\textit{", "}")(view);
      break;
  }
}

function insertSnippet(template: string, complete = false) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  // Wrap the selection: it becomes the content of the first empty field.
  const tpl = selected && template.includes("#{}") ? template.replace("#{}", selected.replace(/[#$]\{/g, "\\$&")) : template;
  snippet(tpl)(view, { label: "" }, from, to);
  view.focus();
  if (complete) requestAnimationFrame(() => view && startCompletion(view));
}

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({ doc: state.content, extensions: extensions() }),
  });
  editorBridge.setContent = setContent;
  editorBridge.goto = goto;
  editorBridge.focus = () => view?.focus();
  editorBridge.command = runCommand;
  editorBridge.insert = insertSnippet;
  view.focus();
});

onBeforeUnmount(() => {
  editorBridge.setContent = editorBridge.goto = editorBridge.focus = undefined;
  editorBridge.command = editorBridge.insert = undefined;
  view?.destroy();
  view = null;
});

function reconfigure(conf: Compartment, ext: () => Extension) {
  view?.dispatch({ effects: conf.reconfigure(ext()) });
}
watch(
  () => [settings.editorTheme, settings.fontSize, settings.fontFamily, settings.lineHeight, settings.overallTheme, isDarkUi()],
  () => reconfigure(themeConf, themeExt),
);
watch(() => settings.keybindings, () => reconfigure(keybindingsConf, keybindingsExt));
watch(() => settings.lineWrapping, () => reconfigure(wrapConf, wrapExt));
watch(() => settings.autoComplete, () => reconfigure(completeConf, completeExt));
watch(() => settings.autoCloseBrackets, () => reconfigure(bracketsConf, bracketsExt));
watch(() => settings.highlightActiveLine, () => reconfigure(activeLineConf, activeLineExt));
watch(() => settings.spellCheck, () => reconfigure(spellConf, spellExt));
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden" />
</template>

<style scoped>
:deep(.cm-editor) {
  height: 100%;
}
:deep(.cm-editor.cm-focused) {
  outline: none;
}
:deep(.cm-vim-panel),
:deep(.cm-vim-panel input) {
  font-family: Menlo, monospace;
  font-size: 13px;
}
</style>

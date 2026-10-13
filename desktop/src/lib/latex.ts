// Lightweight LaTeX source analysis: outline, word count and completion data.

export interface OutlineItem {
  level: number;
  command: string;
  title: string;
  line: number;
  children: OutlineItem[];
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

/** Removes a `%` comment from a line, honouring `\%`. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "%") return line.slice(0, i);
  }
  return line;
}

/** Reads a balanced `{...}` group starting at `start` (which must be `{`). */
function readGroup(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return null;
}

const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(\[[^\]]*\])?\s*\{/g;

/** Builds the nested document outline shown in the "File outline" panel. */
export function parseOutline(text: string): OutlineItem[] {
  const flat: OutlineItem[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, idx) => {
    const line = stripComment(raw);
    SECTION_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SECTION_RE.exec(line))) {
      const braceAt = m.index + m[0].length - 1;
      // Titles may span lines; join a few following lines to read the group.
      const tail = [line.slice(braceAt), ...lines.slice(idx + 1, idx + 4).map(stripComment)].join(" ");
      const title = readGroup(tail, 0) ?? line.slice(braceAt + 1);
      flat.push({
        level: SECTION_LEVELS[m[1]],
        command: m[1],
        title: cleanTitle(title),
        line: idx + 1,
        children: [],
      });
    }
  });

  const roots: OutlineItem[] = [];
  const stack: OutlineItem[] = [];
  for (const item of flat) {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(item);
    else roots.push(item);
    stack.push(item);
  }
  return roots;
}

function cleanTitle(title: string): string {
  return title
    .replace(/\\(label|index)\{[^}]*\}/g, "")
    .replace(/\\[a-zA-Z]+\*?\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "(untitled)";
}

/** Labels declared with `\label{...}`. */
export function extractLabels(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const m of stripComment(line).matchAll(/\\label\{([^}]+)\}/g)) out.push(m[1].trim());
  }
  return out;
}

/** Citation keys from a .bib file. */
export function extractBibKeys(text: string): { key: string; info: string }[] {
  const out: { key: string; info: string }[] = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const title = /title\s*=\s*[{"]([^}"]*)/i.exec(m[3])?.[1] ?? "";
    out.push({ key: m[2], info: title });
  }
  return out;
}

/** Files pulled in with `\input`/`\include`/`\subfile`, resolved to project paths. */
export function extractIncludes(text: string, fromDir: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    for (const m of stripComment(line).matchAll(/\\(?:input|include|subfile)\{([^}]+)\}/g)) {
      let p = m[1].trim();
      if (!p.endsWith(".tex")) p += ".tex";
      out.push(joinPath(fromDir, p));
    }
  }
  return out;
}

export function joinPath(dir: string, rel: string): string {
  const parts = (dir ? dir.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface WordCount {
  words: number;
  headers: number;
  mathInline: number;
  mathDisplay: number;
  files: number;
}

const NON_TEXT_ENVS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "displaymath", "eqnarray", "eqnarray*", "figure", "figure*", "table", "table*", "tikzpicture", "verbatim", "lstlisting", "minted"];

/** texcount-style word count over the main document and everything it includes. */
export function countWords(main: string, texts: Record<string, string>): WordCount {
  const result: WordCount = { words: 0, headers: 0, mathInline: 0, mathDisplay: 0, files: 0 };
  const visited = new Set<string>();

  const visit = (path: string, inBody: boolean) => {
    if (visited.has(path) || texts[path] === undefined) return;
    visited.add(path);
    result.files++;
    let src = texts[path].split("\n").map(stripComment).join("\n");
    const begin = src.indexOf("\\begin{document}");
    if (!inBody) {
      if (begin < 0) return;
      src = src.slice(begin + "\\begin{document}".length);
    }
    const end = src.indexOf("\\end{document}");
    if (end >= 0) src = src.slice(0, end);

    for (const inc of extractIncludes(src, dirname(path))) visit(inc, true);

    for (const env of NON_TEXT_ENVS) {
      const escaped = env.replace("*", "\\*");
      const re = new RegExp(`\\\\begin\\{${escaped}\\}[\\s\\S]*?\\\\end\\{${escaped}\\}`, "g");
      src = src.replace(re, (block) => {
        if (/equation|align|gather|multline|displaymath|eqnarray/.test(env)) result.mathDisplay++;
        // Captions still count as text.
        const captions = [...block.matchAll(/\\caption\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
        return ` ${captions} `;
      });
    }
    src = src.replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, () => {
      result.mathDisplay++;
      return " ";
    });
    src = src.replace(/\\\([\s\S]*?\\\)|\$[^$]+\$/g, () => {
      result.mathInline++;
      return " ";
    });
    src = src.replace(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, (_m, title: string) => {
      result.headers++;
      return ` ${title} `;
    });
    // Drop commands whose arguments are not prose, then remaining command names.
    src = src
      .replace(/\\(?:label|ref|eqref|autoref|cref|Cref|cite\w*|includegraphics|input|include|bibliography\w*|usepackage|documentclass|begin|end|url|vspace|hspace|pageref)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, " ")
      .replace(/\\[a-zA-Z@]+\*?/g, " ")
      .replace(/[{}[\]&~\\]/g, " ");
    const words = src.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    result.words += words?.length ?? 0;
  };

  visit(main, false);
  return result;
}

// ---------------------------------------------------------------------------
// Completion data
// ---------------------------------------------------------------------------

export const ENVIRONMENTS = [
  "abstract", "align", "align*", "alignat", "array", "bmatrix", "cases", "center", "description",
  "document", "enumerate", "equation", "equation*", "figure", "figure*", "flushleft", "flushright",
  "frame", "gather", "itemize", "lstlisting", "matrix", "minipage", "multline", "pmatrix", "proof",
  "quotation", "quote", "split", "subfigure", "tabular", "tabularx", "table", "table*", "thebibliography",
  "theorem", "tikzpicture", "titlepage", "verbatim", "vmatrix", "wrapfigure",
];

export const PACKAGES = [
  "amsmath", "amssymb", "amsthm", "babel", "biblatex", "booktabs", "caption", "cleveref", "csquotes",
  "enumitem", "fancyhdr", "float", "fontenc", "fontspec", "geometry", "graphicx", "hyperref", "inputenc",
  "listings", "lmodern", "mathtools", "microtype", "minted", "multirow", "natbib", "parskip", "pgfplots",
  "setspace", "siunitx", "subcaption", "tabularx", "tikz", "titlesec", "url", "xcolor", "xparse",
];

/** Commands offered after typing `\`, with an optional snippet (`#{}` marks fields). */
export const COMMANDS: { name: string; snippet?: string; info?: string }[] = [
  { name: "section", snippet: "\\section{#{title}}" },
  { name: "subsection", snippet: "\\subsection{#{title}}" },
  { name: "subsubsection", snippet: "\\subsubsection{#{title}}" },
  { name: "chapter", snippet: "\\chapter{#{title}}" },
  { name: "paragraph", snippet: "\\paragraph{#{title}}" },
  { name: "section*", snippet: "\\section*{#{title}}" },
  { name: "textbf", snippet: "\\textbf{#{}}" },
  { name: "textit", snippet: "\\textit{#{}}" },
  { name: "emph", snippet: "\\emph{#{}}" },
  { name: "underline", snippet: "\\underline{#{}}" },
  { name: "texttt", snippet: "\\texttt{#{}}" },
  { name: "textsc", snippet: "\\textsc{#{}}" },
  { name: "label", snippet: "\\label{#{}}" },
  { name: "ref", snippet: "\\ref{#{}}" },
  { name: "eqref", snippet: "\\eqref{#{}}" },
  { name: "autoref", snippet: "\\autoref{#{}}" },
  { name: "cref", snippet: "\\cref{#{}}" },
  { name: "pageref", snippet: "\\pageref{#{}}" },
  { name: "cite", snippet: "\\cite{#{}}" },
  { name: "citep", snippet: "\\citep{#{}}" },
  { name: "citet", snippet: "\\citet{#{}}" },
  { name: "footnote", snippet: "\\footnote{#{}}" },
  { name: "url", snippet: "\\url{#{}}" },
  { name: "href", snippet: "\\href{#{url}}{#{text}}" },
  { name: "includegraphics", snippet: "\\includegraphics[width=#{\\linewidth}]{#{}}" },
  { name: "caption", snippet: "\\caption{#{}}" },
  { name: "centering" },
  { name: "item" },
  { name: "input", snippet: "\\input{#{}}" },
  { name: "include", snippet: "\\include{#{}}" },
  { name: "usepackage", snippet: "\\usepackage{#{}}" },
  { name: "documentclass", snippet: "\\documentclass{#{article}}" },
  { name: "title", snippet: "\\title{#{}}" },
  { name: "author", snippet: "\\author{#{}}" },
  { name: "date", snippet: "\\date{#{\\today}}" },
  { name: "maketitle" },
  { name: "tableofcontents" },
  { name: "newpage" },
  { name: "clearpage" },
  { name: "today" },
  { name: "bibliography", snippet: "\\bibliography{#{refs}}" },
  { name: "bibliographystyle", snippet: "\\bibliographystyle{#{plain}}" },
  { name: "addbibresource", snippet: "\\addbibresource{#{refs.bib}}" },
  { name: "printbibliography" },
  { name: "newcommand", snippet: "\\newcommand{\\#{name}}[#{1}]{#{}}" },
  { name: "renewcommand", snippet: "\\renewcommand{\\#{name}}{#{}}" },
  { name: "frac", snippet: "\\frac{#{}}{#{}}" },
  { name: "sqrt", snippet: "\\sqrt{#{}}" },
  { name: "sum", snippet: "\\sum_{#{}}^{#{}}" },
  { name: "int", snippet: "\\int_{#{}}^{#{}}" },
  { name: "lim", snippet: "\\lim_{#{}}" },
  { name: "mathbb", snippet: "\\mathbb{#{}}" },
  { name: "mathcal", snippet: "\\mathcal{#{}}" },
  { name: "mathrm", snippet: "\\mathrm{#{}}" },
  { name: "mathbf", snippet: "\\mathbf{#{}}" },
  { name: "text", snippet: "\\text{#{}}" },
  { name: "left(", snippet: "\\left( #{} \\right)" },
  { name: "alpha" }, { name: "beta" }, { name: "gamma" }, { name: "delta" }, { name: "epsilon" },
  { name: "lambda" }, { name: "mu" }, { name: "pi" }, { name: "sigma" }, { name: "theta" }, { name: "omega" },
  { name: "infty" }, { name: "partial" }, { name: "nabla" }, { name: "cdot" }, { name: "times" },
  { name: "leq" }, { name: "geq" }, { name: "neq" }, { name: "approx" }, { name: "rightarrow" },
  { name: "hline" }, { name: "toprule" }, { name: "midrule" }, { name: "bottomrule" },
  { name: "vspace", snippet: "\\vspace{#{1em}}" },
  { name: "hspace", snippet: "\\hspace{#{1em}}" },
  { name: "noindent" },
  { name: "linewidth" },
  { name: "textwidth" },
];

// ---------------------------------------------------------------------------
// Engine detection & log hints
// ---------------------------------------------------------------------------

/** Engine a document needs, judging from its preamble, or null if any engine will do. */
export function requiredEngine(text: string): "lualatex" | "xelatex" | null {
  const src = text.split("\n").map(stripComment).join("\n");
  if (/onchar\s*=|\\directlua|\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:luacode|luatexja|lua-ul|luamplib)\b/.test(src)) {
    return "lualatex";
  }
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK|mathspec)\b|\\babelfont|\\setmainfont/.test(src)) {
    return "xelatex";
  }
  return null;
}

export interface LogHint {
  text: string;
  /** Engine to switch to, offered as a one-click fix. */
  switchTo?: "lualatex" | "xelatex";
}

/** Overleaf-style explanations for the most common local compile failures. */
export function hintFor(message: string, engine: string, mainText: string, projectFiles: string[]): LogHint | null {
  const needs = requiredEngine(mainText);
  if (/requires either XeTeX or LuaTeX|fontspec.*XeTeX|Fatal Package fontspec Error/.test(message) && engine === "pdflatex") {
    return {
      text: "This document loads fontspec, which only works with XeLaTeX or LuaLaTeX. On Overleaf the project's compiler is probably set to one of them.",
      switchTo: needs ?? "lualatex",
    };
  }
  const font = /The font "([^"]+)" cannot be found/.exec(message);
  if (font) {
    const slug = font[1].toLowerCase().replace(/\s+/g, "-");
    return {
      text: `The font “${font[1]}” is not installed on this computer (Overleaf ships it with its TeX Live). Install it, e.g. \`brew install --cask font-${slug}\` or \`tlmgr install noto\`, or change the font in the preamble.`,
    };
  }
  const missing = /File [`']([^`']+)' not found/.exec(message);
  if (missing) {
    const name = missing[1];
    const alt = name.replace(/:/g, "_");
    if (name.includes(":") && projectFiles.some((p) => p.endsWith(alt))) {
      return {
        text: `“${name}” contains “:”, which macOS replaces with “_” when files are downloaded. The project has “${alt}”: update the reference in the source.`,
      };
    }
    return { text: `“${name}” is not in the project. Upload it or fix the path (paths are case-sensitive and relative to the main document).` };
  }
  if (needs && engine !== needs && (engine === "pdflatex" || needs === "lualatex")) {
    return {
      text: `The preamble needs ${needs === "lualatex" ? "LuaLaTeX" : "XeLaTeX"} (fontspec/babel font options), but the compiler is ${engine}.`,
      switchTo: needs,
    };
  }
  return null;
}

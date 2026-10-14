import { describe, expect, it } from "vitest";
import {
  countWords,
  extractBibKeys,
  extractIncludes,
  extractLabels,
  hintFor,
  joinPath,
  parseOutline,
  requiredEngine,
  stripComment,
} from "./latex";

describe("stripComment", () => {
  it("removes comments but keeps escaped percent signs", () => {
    expect(stripComment("text % comment")).toBe("text ");
    expect(stripComment("50\\% of it % note")).toBe("50\\% of it ");
    expect(stripComment("no comment")).toBe("no comment");
  });
});

describe("parseOutline", () => {
  it("nests sections and keeps line numbers", () => {
    const outline = parseOutline(
      ["\\section{Intro}", "text", "\\subsection{Details}", "\\section*{Results}", "% \\section{Hidden}"].join("\n"),
    );
    expect(outline.map((o) => o.title)).toEqual(["Intro", "Results"]);
    expect(outline[0].children.map((o) => [o.title, o.line])).toEqual([["Details", 3]]);
    expect(outline[1].line).toBe(4);
  });

  it("reads titles with nested braces, optional arguments and labels", () => {
    const [item] = parseOutline("\\section[Short]{The \\emph{big} idea\\label{sec:big}}");
    expect(item.title).toBe("The big idea");
  });

  it("reads titles that continue on the next line", () => {
    const [item] = parseOutline("\\section{A long\ntitle}");
    expect(item.title).toBe("A long title");
  });
});

describe("labels, citations and includes", () => {
  it("extracts labels outside comments", () => {
    expect(extractLabels("\\label{a} % \\label{b}\n\\label{ c }")).toEqual(["a", "c"]);
  });

  it("extracts BibTeX keys with titles, skipping @string/@comment", () => {
    const bib = "@string{x = {y}}\n@book{knuth, title={The TeXbook}, year=1984}\n@article{lamport94,\n  title = \"LaTeX\"\n}";
    expect(extractBibKeys(bib)).toEqual([
      { key: "knuth", info: "The TeXbook" },
      { key: "lamport94", info: "LaTeX" },
    ]);
  });

  it("resolves \\input and \\include relative to the including file", () => {
    expect(extractIncludes("\\input{intro}\n\\include{../shared/notation.tex}", "chapters")).toEqual([
      "chapters/intro.tex",
      "shared/notation.tex",
    ]);
    expect(joinPath("a/b", "./c/../d.tex")).toBe("a/b/d.tex");
  });
});

describe("countWords", () => {
  it("counts body text across included files, separating headers and math", () => {
    const texts = {
      "main.tex": [
        "\\documentclass{article}",
        "\\title{Not counted}",
        "\\begin{document}",
        "\\section{Two words}",
        "One two three $x+y$ four.",
        "\\[ e^{i\\pi} = -1 \\]",
        "\\input{chap}",
        "\\end{document}",
      ].join("\n"),
      "chap.tex": "Five six % seven\n\\cite{knuth} eight",
    };
    const count = countWords("main.tex", texts);
    expect(count.headers).toBe(1);
    expect(count.mathInline).toBe(1);
    expect(count.mathDisplay).toBe(1);
    expect(count.files).toBe(2);
    // "Two words" + "One two three four" + "Five six eight"
    expect(count.words).toBe(9);
  });
});

describe("requiredEngine", () => {
  it("detects the engine a preamble needs", () => {
    expect(requiredEngine("\\usepackage{amsmath}")).toBeNull();
    expect(requiredEngine("\\usepackage{fontspec}")).toBe("xelatex");
    expect(requiredEngine("\\babelfont{rm}{Noto Sans}")).toBe("xelatex");
    expect(requiredEngine("\\babelprovide[import, onchar=ids fonts]{italian}")).toBe("lualatex");
    expect(requiredEngine("% \\usepackage{fontspec}")).toBeNull();
  });
});

describe("hintFor", () => {
  const files = ["main.tex", "sup1_x.png"];
  it("suggests a Unicode engine for fontspec under pdfLaTeX", () => {
    const hint = hintFor("Fatal Package fontspec Error: The fontspec package requires either XeTeX or LuaTeX.", "pdflatex", "\\usepackage{fontspec}", files);
    expect(hint?.switchTo).toBe("xelatex");
  });

  it("explains missing fonts", () => {
    const hint = hintFor('Package fontspec Error: The font "Noto Sans" cannot be found.', "xelatex", "", files);
    expect(hint?.text).toContain("font-noto-sans");
  });

  it("recognises files renamed by macOS (':' → '_')", () => {
    const hint = hintFor("File `sup1:x.png' not found: using draft setting.", "pdflatex", "", files);
    expect(hint?.text).toContain("sup1_x.png");
  });

  it("returns nothing for unrelated errors", () => {
    expect(hintFor("Undefined control sequence.", "pdflatex", "\\usepackage{amsmath}", files)).toBeNull();
  });
});

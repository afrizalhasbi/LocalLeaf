//! Thin, non-blocking wrapper around the TeX engines already installed on the system.
//!
//! Nothing here reimplements TeX: we spawn the real compiler with
//! `tokio::process::Command`, then parse its log to give agents and the UI a compact
//! list of errors and warnings. For the classic LaTeX engines we also run the small
//! latexmk-style loop (bibtex/biber + reruns) that tectonic performs on its own.

use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Upper bound for a single tool run, so a stuck engine cannot hang an agent forever.
const COMPILE_TIMEOUT: Duration = Duration::from_secs(300);
/// Extra LaTeX passes allowed when the log asks for a rerun (cross-references, bibliography).
const MAX_RERUNS: usize = 3;
/// TeX hard-wraps log lines at this many characters (`max_print_line`).
const TEX_LOG_WRAP: usize = 79;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeXEngine {
    Tectonic,
    #[serde(rename = "pdflatex")]
    PdfLaTeX,
    #[serde(rename = "xelatex")]
    XeLaTeX,
    #[serde(rename = "lualatex")]
    LuaLaTeX,
}

impl TeXEngine {
    pub const ALL: [TeXEngine; 4] = [
        TeXEngine::Tectonic,
        TeXEngine::PdfLaTeX,
        TeXEngine::XeLaTeX,
        TeXEngine::LuaLaTeX,
    ];

    /// Executable name looked up in `PATH`.
    pub fn binary(self) -> &'static str {
        match self {
            TeXEngine::Tectonic => "tectonic",
            TeXEngine::PdfLaTeX => "pdflatex",
            TeXEngine::XeLaTeX => "xelatex",
            TeXEngine::LuaLaTeX => "lualatex",
        }
    }

    /// Absolute path of the engine executable, if it is installed in `PATH`.
    pub fn locate(self) -> Option<PathBuf> {
        find_in_path(self.binary())
    }

    fn args(self, entry_file: &Path, stem: &str, output_dir: &Path, opts: &CompileOptions) -> Vec<String> {
        let entry = entry_file.to_string_lossy().into_owned();
        let out = output_dir.to_string_lossy().into_owned();
        match self {
            TeXEngine::Tectonic => {
                let mut args = vec!["--keep-logs".into(), "--outdir".into(), out];
                if opts.synctex {
                    args.push("--synctex".into());
                }
                args.push(entry);
                args
            }
            _ => {
                let mut args = vec![
                    "-interaction=nonstopmode".to_string(),
                    "-file-line-error".into(),
                    format!("-output-directory={out}"),
                    format!("-jobname={stem}"),
                ];
                if opts.stop_on_first_error {
                    args.push("-halt-on-error".into());
                }
                if opts.synctex {
                    args.push("-synctex=1".into());
                }
                if opts.draft {
                    // Same trick as Overleaf's "fast [draft]" mode: images become placeholders.
                    args.push(format!("\\PassOptionsToPackage{{draft}}{{graphicx}}\\input{{{entry}}}"));
                } else {
                    args.push(entry);
                }
                args
            }
        }
    }
}

impl fmt::Display for TeXEngine {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.binary())
    }
}

impl FromStr for TeXEngine {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "tectonic" => Ok(TeXEngine::Tectonic),
            "pdflatex" => Ok(TeXEngine::PdfLaTeX),
            "xelatex" => Ok(TeXEngine::XeLaTeX),
            "lualatex" => Ok(TeXEngine::LuaLaTeX),
            other => bail!(
                "unknown TeX engine '{other}' (expected one of: tectonic, pdflatex, xelatex, lualatex)"
            ),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "snake_case")]
pub struct CompileOptions {
    /// Generate SyncTeX data for source ↔ PDF navigation.
    pub synctex: bool,
    /// Replace images with placeholders for faster builds (LaTeX engines only).
    pub draft: bool,
    /// Stop at the first error instead of trying to produce a PDF anyway.
    pub stop_on_first_error: bool,
}

impl Default for CompileOptions {
    fn default() -> Self {
        Self { synctex: false, draft: false, stop_on_first_error: true }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticKind {
    Error,
    Warning,
    BadBox,
}

/// A single error or warning extracted from TeX output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeXError {
    pub kind: DiagnosticKind,
    pub message: String,
    /// Source file the diagnostic refers to, as printed by TeX, when known.
    pub file: Option<String>,
    /// Source line reported by TeX, when available.
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilationResult {
    pub engine: TeXEngine,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub pdf_path: Option<PathBuf>,
    pub log_path: Option<PathBuf>,
    pub synctex_path: Option<PathBuf>,
    pub duration_ms: u64,
    pub stdout: String,
    pub stderr: String,
    pub errors: Vec<TeXError>,
    pub warnings: Vec<TeXError>,
}

/// Compiles `entry_point` with `engine`, writing artifacts into `output_dir`.
pub async fn compile(
    engine: TeXEngine,
    entry_point: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
) -> Result<CompilationResult> {
    compile_with(engine, entry_point, output_dir, &CompileOptions::default()).await
}

/// Like [`compile`], with explicit options.
///
/// The compiler runs with the entry point's directory as working directory so that
/// relative `\input`/`\includegraphics` paths resolve as they would in an editor.
pub async fn compile_with(
    engine: TeXEngine,
    entry_point: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    opts: &CompileOptions,
) -> Result<CompilationResult> {
    let started = Instant::now();
    let entry_point = entry_point.as_ref();
    let entry_abs = std::path::absolute(entry_point)
        .with_context(|| format!("invalid entry point {}", entry_point.display()))?;
    if !entry_abs.is_file() {
        bail!("entry point {} does not exist", entry_abs.display());
    }
    let workdir = entry_abs
        .parent()
        .context("entry point has no parent directory")?
        .to_path_buf();
    let entry_name = PathBuf::from(entry_abs.file_name().context("entry point has no file name")?);
    let stem = entry_abs
        .file_stem()
        .context("entry point has no file stem")?
        .to_string_lossy()
        .into_owned();

    let output_dir = std::path::absolute(output_dir.as_ref())?;
    tokio::fs::create_dir_all(&output_dir)
        .await
        .with_context(|| format!("cannot create output dir {}", output_dir.display()))?;
    if engine != TeXEngine::Tectonic {
        // `\include{chapters/intro}` writes `chapters/intro.aux` into the output dir,
        // which fails unless the folder structure already exists there.
        mirror_dirs(&workdir, &output_dir, &output_dir, 0);
    }

    let binary = engine
        .locate()
        .with_context(|| format!("{engine} is not installed or not in PATH"))?;

    tracing::info!(%engine, entry = %entry_abs.display(), out = %output_dir.display(), "compiling");

    let pdf_path = output_dir.join(format!("{stem}.pdf"));
    // Remove a stale PDF so a failed run is never mistaken for a successful one.
    let _ = tokio::fs::remove_file(&pdf_path).await;

    let engine_args = engine.args(&entry_name, &stem, &output_dir, opts);
    let mut output = run_tool(&binary, &engine_args, &workdir, &[]).await?;
    let mut stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    // Rerun/bibliography whenever a PDF came out, even with non-fatal errors (e.g. a missing
    // image in "try compiling despite errors" mode), as latexmk does on Overleaf.
    let produced = |out: &Output| out.status.success() || pdf_path.is_file();
    if engine != TeXEngine::Tectonic && produced(&output) {
        let mut passes = 0;
        if let Some(bib_out) = run_bibliography(&workdir, &output_dir, &stem).await? {
            stdout.push_str(&bib_out);
            passes = 1;
            output = run_tool(&binary, &engine_args, &workdir, &[]).await?;
        }
        let log_file = output_dir.join(format!("{stem}.log"));
        while produced(&output) && passes < MAX_RERUNS && needs_rerun(&log_file).await {
            passes += 1;
            tracing::debug!(passes, "rerunning for cross-references");
            output = run_tool(&binary, &engine_args, &workdir, &[]).await?;
        }
        if passes > 0 {
            stdout.push_str(&format!("\n[texcraft] {} extra LaTeX pass(es)\n", passes));
            stdout.push_str(&String::from_utf8_lossy(&output.stdout));
            stderr.push_str(&String::from_utf8_lossy(&output.stderr));
        }
    }

    let log_file = output_dir.join(format!("{stem}.log"));
    let log_path = log_file.is_file().then_some(log_file);
    let log_text = match &log_path {
        Some(p) => tokio::fs::read(p)
            .await
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default(),
        None => String::new(),
    };

    // Prefer the .log file (most complete), fall back to the console streams.
    let source = if log_text.is_empty() { format!("{stdout}\n{stderr}") } else { log_text };
    let (mut errors, warnings) = parse_tex_log(&source);
    if errors.is_empty() {
        errors = parse_tex_log(&format!("{stdout}\n{stderr}")).0;
    }

    let pdf_exists = pdf_path.is_file();
    let success = output.status.success() && pdf_exists;
    if !success && errors.is_empty() {
        errors.push(TeXError {
            kind: DiagnosticKind::Error,
            message: format!("{engine} exited with status {} without producing a PDF", output.status),
            file: None,
            line: None,
        });
    }

    let synctex_file = output_dir.join(format!("{stem}.synctex.gz"));

    Ok(CompilationResult {
        engine,
        success,
        exit_code: output.status.code(),
        pdf_path: pdf_exists.then_some(pdf_path),
        log_path,
        synctex_path: (opts.synctex && synctex_file.is_file()).then_some(synctex_file),
        duration_ms: started.elapsed().as_millis() as u64,
        stdout,
        stderr,
        errors,
        warnings,
    })
}

async fn run_tool(binary: &Path, args: &[String], cwd: &Path, env: &[(&str, String)]) -> Result<Output> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let child = cmd
        .spawn()
        .with_context(|| format!("failed to spawn {}", binary.display()))?;
    let name = binary.file_name().unwrap_or_default().to_string_lossy();
    tokio::time::timeout(COMPILE_TIMEOUT, child.wait_with_output())
        .await
        .with_context(|| format!("{name} timed out after {}s", COMPILE_TIMEOUT.as_secs()))?
        .with_context(|| format!("failed waiting for {name}"))
}

/// Runs biber or bibtex when the first pass asked for a bibliography.
/// Returns the tool's console output, or `None` if no bibliography is needed.
async fn run_bibliography(workdir: &Path, output_dir: &Path, stem: &str) -> Result<Option<String>> {
    let bcf = output_dir.join(format!("{stem}.bcf"));
    let aux = output_dir.join(format!("{stem}.aux"));
    let (tool, args) = if bcf.is_file() {
        (
            "biber",
            vec!["--input-directory".to_string(), workdir.to_string_lossy().into_owned(), stem.to_string()],
        )
    } else if tokio::fs::read_to_string(&aux)
        .await
        .map(|s| s.contains("\\bibdata"))
        .unwrap_or(false)
    {
        ("bibtex", vec![stem.to_string()])
    } else {
        return Ok(None);
    };
    let Some(binary) = find_in_path(tool) else {
        tracing::warn!(tool, "bibliography requested but tool not installed");
        return Ok(None);
    };
    // bibtex runs inside the output dir (where the .aux is) and finds .bib files via BIBINPUTS.
    let sep = if cfg!(windows) { ";" } else { ":" };
    let env = [
        ("BIBINPUTS", format!("{}{sep}", workdir.display())),
        ("BSTINPUTS", format!("{}{sep}", workdir.display())),
    ];
    let out = run_tool(&binary, &args, output_dir, &env).await?;
    Ok(Some(format!(
        "\n[texcraft] {tool}\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )))
}

async fn needs_rerun(log_file: &Path) -> bool {
    let Ok(bytes) = tokio::fs::read(log_file).await else { return false };
    let log = String::from_utf8_lossy(&bytes);
    log.contains("Rerun to get")
        || log.contains("Label(s) may have changed")
        || log.contains("Please rerun LaTeX")
        || log.contains("Please (re)run Biber")
}

fn mirror_dirs(src: &Path, dst: &Path, skip: &Path, depth: usize) {
    if depth > 8 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(src) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            || path == skip
            || name.to_string_lossy().starts_with('.')
        {
            continue;
        }
        let target = dst.join(&name);
        if std::fs::create_dir_all(&target).is_ok() {
            mirror_dirs(&path, &target, skip, depth + 1);
        }
    }
}

/// Extracts errors from TeX console/log output (see [`parse_tex_log`]).
pub fn parse_tex_errors(text: &str) -> Vec<TeXError> {
    parse_tex_log(text).0
}

/// Extracts errors and warnings from TeX console/log output.
///
/// Recognises classic TeX errors (`! Message`, followed later by `l.<n> ...`),
/// `-file-line-error` style errors (`./file.tex:12: Message`), tectonic's `error: ...`
/// diagnostics, LaTeX/package warnings and over/underfull boxes.
/// Duplicates are removed, order is preserved.
pub fn parse_tex_log(text: &str) -> (Vec<TeXError>, Vec<TeXError>) {
    static RES: OnceLock<[Regex; 6]> = OnceLock::new();
    let [l_line, file_line, input_line, box_lines, pkg_warning, pkg_error] = RES.get_or_init(|| {
        [
            Regex::new(r"^l\.(\d+)").unwrap(),
            Regex::new(r"^(.+?\.(?:tex|sty|cls|bib|ltx|dtx|bbl|def|cfg|clo)):(\d+): (.+)$").unwrap(),
            Regex::new(r"on input line (\d+)").unwrap(),
            Regex::new(r"at lines? (\d+)").unwrap(),
            Regex::new(r"^(?:LaTeX|Package|Class) ?(\S*) Warning: (.+)$").unwrap(),
            Regex::new(r"(?:Package|Class) (\S+) Error:").unwrap(),
        ]
    });

    let lines = unwrap_log_lines(text);
    let mut errors: Vec<TeXError> = Vec::new();
    let mut warnings: Vec<TeXError> = Vec::new();
    let push = |list: &mut Vec<TeXError>, d: TeXError| {
        if !list.contains(&d) {
            list.push(d);
        }
    };
    // TeX prints the offending source line as `l.<n> ...` shortly after the error line.
    let find_l_line = |from: usize| {
        lines
            .iter()
            .skip(from + 1)
            .take(12)
            .take_while(|l| !l.starts_with("! ") && !file_line.is_match(l))
            .find_map(|l| l_line.captures(l))
            .and_then(|c| c[1].parse().ok())
    };

    // Package errors continue on lines prefixed with `(pkgname)`, which carry the actual
    // explanation (e.g. fontspec's "The font ... cannot be found").
    let with_continuation = |from: usize, message: &str| {
        let mut message = message.trim().to_string();
        if let Some(c) = pkg_error.captures(&message) {
            let prefix = format!("({})", &c[1]);
            for next in lines.iter().skip(from + 1).take(10) {
                let Some(rest) = next.strip_prefix(&prefix) else { break };
                message.push(' ');
                message.push_str(rest.trim());
            }
        }
        message
    };

    for (i, raw) in lines.iter().enumerate() {
        let line = raw.trim_end();

        if let Some(c) = file_line.captures(line) {
            push(&mut errors, TeXError {
                kind: DiagnosticKind::Error,
                message: with_continuation(i, &c[3]),
                file: Some(c[1].to_string()),
                line: c[2].parse().ok(),
            });
            continue;
        }

        if let Some(msg) = line.strip_prefix("! ").or_else(|| line.strip_prefix("error: ")) {
            let msg = msg.trim();
            if !msg.is_empty() {
                push(&mut errors, TeXError {
                    kind: DiagnosticKind::Error,
                    message: with_continuation(i, msg),
                    file: None,
                    line: find_l_line(i),
                });
            }
            continue;
        }

        if let Some(c) = pkg_warning.captures(line) {
            // Package warnings continue on lines prefixed with `(pkgname)`.
            let mut message = c[2].trim().to_string();
            let cont_prefix = format!("({})", &c[1]);
            for next in lines.iter().skip(i + 1).take(8) {
                match next.strip_prefix(&cont_prefix) {
                    Some(rest) if !c[1].is_empty() => {
                        message.push(' ');
                        message.push_str(rest.trim());
                    }
                    _ => break,
                }
            }
            let line_no = input_line.captures(&message).and_then(|c| c[1].parse().ok());
            push(&mut warnings, TeXError {
                kind: DiagnosticKind::Warning,
                message,
                file: None,
                line: line_no,
            });
            continue;
        }

        if line.starts_with("Overfull \\") || line.starts_with("Underfull \\") {
            push(&mut warnings, TeXError {
                kind: DiagnosticKind::BadBox,
                message: line.to_string(),
                file: None,
                line: box_lines.captures(line).and_then(|c| c[1].parse().ok()),
            });
        }
    }
    (errors, warnings)
}

/// Re-joins lines that TeX hard-wrapped at [`TEX_LOG_WRAP`] characters.
fn unwrap_log_lines(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut joining = false;
    for line in text.lines() {
        if joining {
            if let Some(last) = out.last_mut() {
                last.push_str(line);
            }
        } else {
            out.push(line.to_string());
        }
        joining = line.chars().count() == TEX_LOG_WRAP;
    }
    out
}

/// Returns every supported engine that is installed, with its resolved path.
pub fn detect_engines() -> Vec<(TeXEngine, PathBuf)> {
    TeXEngine::ALL
        .iter()
        .filter_map(|&e| e.locate().map(|p| (e, p)))
        .collect()
}

/// Finds an executable in `PATH` (with the `.exe` suffix on Windows).
pub fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let file_name = if cfg!(windows) { format!("{binary}.exe") } else { binary.to_string() };
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(&file_name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(message: &str, file: Option<&str>, line: Option<u32>) -> TeXError {
        TeXError { kind: DiagnosticKind::Error, message: message.into(), file: file.map(Into::into), line }
    }

    #[test]
    fn parses_bang_errors_with_line_numbers() {
        let log = "\
This is pdfTeX
! Undefined control sequence.
l.5 \\foo

! LaTeX Error: Missing \\begin{document}.

See the LaTeX manual
l.12 x
";
        assert_eq!(
            parse_tex_errors(log),
            vec![
                err("Undefined control sequence.", None, Some(5)),
                err("LaTeX Error: Missing \\begin{document}.", None, Some(12)),
            ]
        );
    }

    #[test]
    fn parses_file_line_errors() {
        let log = "(./main.tex\n./chapters/intro.tex:7: Undefined control sequence.\nl.7 \\oops\n";
        assert_eq!(
            parse_tex_errors(log),
            vec![err("Undefined control sequence.", Some("./chapters/intro.tex"), Some(7))]
        );
    }

    #[test]
    fn joins_package_error_continuation_lines() {
        let log = "\
./main.tex:11: Package fontspec Error: 
(fontspec)                The font \"Noto Sans\" cannot be found; this may be
(fontspec)                but usually is not a fontspec bug.

For immediate help type H <return>.
";
        let errs = parse_tex_errors(log);
        assert_eq!(errs.len(), 1);
        assert_eq!(
            errs[0].message,
            "Package fontspec Error: The font \"Noto Sans\" cannot be found; this may be but usually is not a fontspec bug."
        );
        assert_eq!(errs[0].line, Some(11));
    }

    #[test]
    fn parses_tectonic_errors() {
        let errs = parse_tex_errors("note: Running TeX ...\nerror: halted on potentially-recoverable error\n");
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].line, None);
    }

    #[test]
    fn parses_warnings_and_bad_boxes() {
        let log = "\
LaTeX Warning: Reference `fig:x' on page 1 undefined on input line 14.
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing `math shift' on input line 20.
Overfull \\hbox (12.0pt too wide) in paragraph at lines 30--32
";
        let (errors, warnings) = parse_tex_log(log);
        assert!(errors.is_empty());
        assert_eq!(warnings.len(), 3);
        assert_eq!(warnings[0].line, Some(14));
        assert_eq!(warnings[1].line, Some(20));
        assert!(warnings[1].message.contains("removing"));
        assert_eq!(warnings[2].kind, DiagnosticKind::BadBox);
        assert_eq!(warnings[2].line, Some(30));
    }

    #[test]
    fn unwraps_hard_wrapped_lines() {
        let first = "x".repeat(TEX_LOG_WRAP);
        let joined = unwrap_log_lines(&format!("{first}\nrest\nnext"));
        assert_eq!(joined, vec![format!("{first}rest"), "next".to_string()]);
    }

    #[test]
    fn engine_round_trips() {
        for e in TeXEngine::ALL {
            assert_eq!(e.binary().parse::<TeXEngine>().unwrap(), e);
            let json = serde_json::to_string(&e).unwrap();
            assert_eq!(json, format!("\"{}\"", e.binary()));
        }
    }
}

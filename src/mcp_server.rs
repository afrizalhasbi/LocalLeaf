//! Native Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
//!
//! `stdout` is reserved for protocol messages; all diagnostics go to `stderr` via `tracing`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::compiler::{self, CompileOptions, TeXEngine};
use crate::project::Project;

const SERVER_NAME: &str = "localleaf";
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

/// Cap for stdout/stderr echoed back to agents; TeX logs can be very large.
const MAX_STREAM_CHARS: usize = 16_000;

// JSON-RPC error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

struct Server {
    /// Every path an agent supplies is resolved (and sandboxed) through the project.
    project: Project,
}

/// Runs the MCP server until `stdin` is closed.
pub async fn run(root: PathBuf) -> Result<()> {
    let project = Project::open(&root)?;
    tracing::info!(root = %project.root().display(), "texcraft MCP server started");
    let server = Arc::new(Server { project });

    // A single writer task serialises output so concurrent requests never interleave lines.
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = rx.recv().await {
            let mut line = msg.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let _ = tx.send(error_response(Value::Null, PARSE_ERROR, &format!("parse error: {e}")));
                continue;
            }
        };
        // Compilations run in the background so they never block `ping` or file reads.
        // Everything else is handled in arrival order, so a read that follows a write
        // always sees it.
        let is_compile = msg.get("method").and_then(Value::as_str) == Some("tools/call")
            && msg.pointer("/params/name").and_then(Value::as_str) == Some("compile_tex");
        if is_compile {
            let server = Arc::clone(&server);
            let tx = tx.clone();
            tokio::spawn(async move {
                if let Some(resp) = server.handle_message(msg).await {
                    let _ = tx.send(resp);
                }
            });
        } else if let Some(resp) = server.handle_message(msg).await {
            let _ = tx.send(resp);
        }
    }

    drop(tx);
    let _ = writer.await;
    tracing::info!("stdin closed, shutting down");
    Ok(())
}

impl Server {
    /// Returns `None` for notifications and client responses, which need no reply.
    async fn handle_message(&self, msg: Value) -> Option<Value> {
        let id = msg.get("id").cloned();
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            // A response to a server-initiated request (we send none) or garbage.
            return match id {
                Some(id) if msg.get("result").is_none() && msg.get("error").is_none() => {
                    Some(error_response(id, INVALID_REQUEST, "missing method"))
                }
                _ => None,
            };
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        let Some(id) = id else {
            tracing::debug!(method, "notification");
            return None;
        };

        let result = match method {
            "initialize" => Ok(self.initialize(&params)),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(tools_list()),
            "tools/call" => self.tools_call(params).await,
            other => Err(RpcError::new(METHOD_NOT_FOUND, format!("method not found: {other}"))),
        };

        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(e) => error_response(id, e.code, &e.message),
        })
    }

    fn initialize(&self, params: &Value) -> Value {
        let requested = params.get("protocolVersion").and_then(Value::as_str);
        let version = requested
            .filter(|v| SUPPORTED_PROTOCOL_VERSIONS.contains(v))
            .unwrap_or(LATEST_PROTOCOL_VERSION);
        json!({
            "protocolVersion": version,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": format!(
                "LocalLeaf compiles LaTeX projects with the TeX engines installed on this machine. \
                 Project root: {}. All paths are relative to it. compile_tex without arguments builds the \
                 project's main document with its configured engine; use read_project_file / \
                 write_project_file to inspect and fix sources around reported error lines.",
                self.project.root().display()
            ),
        })
    }

    async fn tools_call(&self, params: Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        struct CallParams {
            name: String,
            #[serde(default)]
            arguments: Value,
        }
        let call: CallParams = serde_json::from_value(params)
            .map_err(|e| RpcError::new(INVALID_PARAMS, format!("invalid tools/call params: {e}")))?;

        let outcome = match call.name.as_str() {
            "compile_tex" => self.compile_tex(call.arguments).await,
            "read_project_file" => self.read_project_file(call.arguments).await,
            "write_project_file" => self.write_project_file(call.arguments).await,
            "list_available_engines" => Ok(list_available_engines()),
            other => {
                return Err(RpcError::new(INVALID_PARAMS, format!("unknown tool: {other}")));
            }
        };

        // Tool failures are reported in-band (isError) so the agent can read and react to them.
        Ok(match outcome {
            Ok(ToolOutput { value, is_error }) => tool_result(&value, is_error),
            Err(e) => tool_result(&json!({ "error": format!("{e:#}") }), true),
        })
    }

    async fn compile_tex(&self, args: Value) -> Result<ToolOutput> {
        #[derive(Deserialize)]
        struct Args {
            #[serde(default)]
            entry_point: Option<String>,
            #[serde(default)]
            engine: Option<String>,
            #[serde(default)]
            output_dir: Option<String>,
            #[serde(default)]
            stop_on_first_error: bool,
            #[serde(default)]
            draft: bool,
        }
        let args: Args = serde_json::from_value(args).context("invalid arguments for compile_tex")?;

        let settings = self.project.load_settings().unwrap_or_default();
        let entry_rel = match args.entry_point {
            Some(e) => e,
            None => self
                .project
                .main_document()
                .context("no entry_point given and no main document found in the project")?,
        };
        let entry = self.resolve(&entry_rel)?;
        let engine = match (args.engine.as_deref(), settings.engine) {
            (Some(name), _) => name.parse::<TeXEngine>()?,
            // The engine chosen in LocalLeaf for this project, if any…
            (None, Some(engine)) if engine.locate().is_some() => engine,
            // …else what the preamble needs, else pdfLaTeX first (same rule as the app).
            _ => {
                let source = tokio::fs::read_to_string(&entry).await.unwrap_or_default();
                TeXEngine::default_for(&source)
                    .ok_or_else(|| anyhow!("no TeX engine installed (looked for pdflatex, xelatex, lualatex, tectonic)"))?
            }
        };
        let output_dir = self.resolve(args.output_dir.as_deref().unwrap_or(crate::DEFAULT_OUTPUT_DIR))?;

        // Like Overleaf's default, keep going past errors so a PDF is produced whenever possible.
        let opts = CompileOptions { synctex: true, stop_on_first_error: args.stop_on_first_error, draft: args.draft };
        let mut result = compiler::compile_with(engine, &entry, &output_dir, &opts).await?;
        result.stdout = tail(&result.stdout, MAX_STREAM_CHARS);
        result.stderr = tail(&result.stderr, MAX_STREAM_CHARS);
        let success = result.success;

        // Paths relative to the project root, diagnostics pointing at project files.
        let value = self.project.relativize_compilation(&entry, &result);
        Ok(ToolOutput { value, is_error: !success })
    }

    async fn read_project_file(&self, args: Value) -> Result<ToolOutput> {
        #[derive(Deserialize)]
        struct Args {
            path: String,
        }
        let args: Args = serde_json::from_value(args).context("invalid arguments for read_project_file")?;
        let content = self.project.read_text(&args.path).await?;
        let path = self.project.resolve(&args.path)?;
        Ok(ToolOutput {
            value: json!({ "path": self.relative(&path), "content": content }),
            is_error: false,
        })
    }

    async fn write_project_file(&self, args: Value) -> Result<ToolOutput> {
        #[derive(Deserialize)]
        struct Args {
            path: String,
            content: String,
        }
        let args: Args = serde_json::from_value(args).context("invalid arguments for write_project_file")?;
        self.project.write(&args.path, args.content.as_bytes()).await?;
        let path = self.project.resolve(&args.path)?;
        Ok(ToolOutput {
            value: json!({ "path": self.relative(&path), "bytes_written": args.content.len() }),
            is_error: false,
        })
    }

    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        self.project.resolve(rel)
    }

    fn relative(&self, path: &Path) -> String {
        self.project.relative(path)
    }
}

struct ToolOutput {
    value: Value,
    is_error: bool,
}

struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

fn list_available_engines() -> ToolOutput {
    let engines: Vec<Value> = TeXEngine::ALL
        .iter()
        .map(|&e| {
            let path = e.locate();
            json!({
                "engine": e,
                "installed": path.is_some(),
                "path": path.map(|p| p.to_string_lossy().into_owned()),
            })
        })
        .collect();
    ToolOutput { value: json!({ "engines": engines }), is_error: false }
}

fn tools_list() -> Value {
    let engines: Vec<&str> = TeXEngine::ALL.iter().map(|e| e.binary()).collect();
    json!({
        "tools": [
            {
                "name": "compile_tex",
                "title": "Compile LaTeX",
                "description": "Compile a LaTeX entry point with a locally installed TeX engine. \
                    Returns success, the PDF path, extracted errors (message + source line) and tails of stdout/stderr.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "entry_point": { "type": "string", "description": "Main .tex file relative to the project root, e.g. \"main.tex\". Defaults to the project's main document (as set in LocalLeaf, else the root .tex file with \\documentclass, preferring main.tex)." },
                        "engine": { "type": "string", "enum": engines, "description": "TeX engine to use. Defaults to the engine chosen for the project in LocalLeaf, else the one the preamble needs (fontspec → xelatex, LuaTeX features → lualatex), else the first installed of pdflatex, xelatex, lualatex, tectonic." },
                        "output_dir": { "type": "string", "description": "Output directory relative to the project root. Defaults to \".texcraft/build\" (shared with the texcraft desktop app)." },
                        "stop_on_first_error": { "type": "boolean", "description": "Halt at the first error instead of producing a PDF despite errors (Overleaf's default is false)." },
                        "draft": { "type": "boolean", "description": "Fast draft mode: images are replaced by placeholders." }
                    },
                    "required": []
                }
            },
            {
                "name": "read_project_file",
                "title": "Read project file",
                "description": "Read a UTF-8 source file (.tex, .bib, .sty, .cls, .log, ...) from the LaTeX project.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path relative to the project root." }
                    },
                    "required": ["path"]
                },
                "annotations": { "readOnlyHint": true }
            },
            {
                "name": "write_project_file",
                "title": "Write project file",
                "description": "Create or overwrite a UTF-8 text file in the LaTeX project (atomic write; parent folders are created). \
                    Open editors such as the texcraft desktop app pick up the change automatically.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "File path relative to the project root." },
                        "content": { "type": "string", "description": "Full new contents of the file." }
                    },
                    "required": ["path", "content"]
                },
                "annotations": { "destructiveHint": true, "idempotentHint": true }
            },
            {
                "name": "list_available_engines",
                "title": "List TeX engines",
                "description": "Detect which TeX compilers (tectonic, pdflatex, xelatex, lualatex) are installed in the system PATH.",
                "inputSchema": { "type": "object", "properties": {} },
                "annotations": { "readOnlyHint": true }
            }
        ]
    })
}

fn tool_result(value: &Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Keeps the last `max` characters, where TeX puts the information that matters.
fn tail(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let skip = count - max;
    let start = s.char_indices().nth(skip).map(|(i, _)| i).unwrap_or(0);
    format!("[... {skip} characters truncated ...]\n{}", &s[start..])
}

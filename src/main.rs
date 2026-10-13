use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use texcraft_core::{compiler, mcp_server};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "\
texcraft-core — native, local-first LaTeX build core with a built-in MCP server

USAGE:
    texcraft-core                 System check: list detected TeX engines
    texcraft-core --mcp           Start the MCP server on stdin/stdout (JSON-RPC 2.0)
    texcraft-core --mcp --root <DIR>
                                  Use <DIR> as the LaTeX project root (default: current dir)
    texcraft-core --help          Show this help

MCP TOOLS:
    compile_tex             { entry_point, engine?, output_dir? }
    read_project_file       { path }
    write_project_file      { path, content }
    list_available_engines  {}

Connect an agent with the bundled .mcp.json, or e.g.:
    claude mcp add texcraft -- /path/to/texcraft-core --mcp

Logs go to stderr; set RUST_LOG=debug for more detail.";

#[tokio::main]
async fn main() -> Result<()> {
    // stdout belongs to the MCP protocol, so logs must always go to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let mut mcp = false;
    let mut root: Option<PathBuf> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mcp" => mcp = true,
            "--root" => root = Some(args.next().context("--root requires a directory")?.into()),
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => bail!("unknown argument '{other}'\n\n{USAGE}"),
        }
    }

    let root = match root {
        Some(r) => r,
        None => std::env::current_dir()?,
    };

    if mcp {
        mcp_server::run(root).await
    } else {
        system_check();
        Ok(())
    }
}

fn system_check() {
    println!("texcraft-core {} — system check\n", env!("CARGO_PKG_VERSION"));
    println!("TeX engines:");
    let mut found = 0;
    for engine in compiler::TeXEngine::ALL {
        match engine.locate() {
            Some(path) => {
                found += 1;
                println!("  [x] {:<9} {}", engine.binary(), path.display());
            }
            None => println!("  [ ] {:<9} not found in PATH", engine.binary()),
        }
    }
    if found == 0 {
        println!("\nNo TeX engine detected. Install TeX Live / MacTeX or tectonic.");
    }
    println!("\n{USAGE}");
}

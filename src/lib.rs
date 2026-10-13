//! texcraft-core: native, local-first LaTeX build core.
//!
//! Wraps the TeX engines already installed on the system and exposes them to AI agents
//! through a built-in MCP server and to the desktop UI as a Rust library.

pub mod compiler;
pub mod mcp_server;
pub mod project;
pub mod synctex;

/// Where build artifacts go by default, relative to the project root.
/// Shared by the MCP server and the desktop app so both see the same PDF.
pub const DEFAULT_OUTPUT_DIR: &str = ".texcraft/build";

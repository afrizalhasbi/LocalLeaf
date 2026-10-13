//! Sandboxed access to a local LaTeX project directory.
//!
//! Every path coming from an agent (MCP) or the desktop UI is relative to the project
//! root and is rejected if it escapes it, through `..`, absolute paths or symlinks.

use std::path::{Component, Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Largest text file served to clients.
pub const MAX_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Directory names never shown in the file tree.
const HIDDEN_DIRS: &[&str] = &[".git", "node_modules", "target", ".texcraft"];

#[derive(Debug, Clone)]
pub struct Project {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    /// Path relative to the project root, always with `/` separators.
    pub path: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileNode>>,
}

impl Project {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let root = root
            .canonicalize()
            .with_context(|| format!("invalid project root {}", root.display()))?;
        if !root.is_dir() {
            bail!("project root {} is not a directory", root.display());
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolves a client-supplied path against the project root, rejecting escapes.
    /// The path does not need to exist (so it can be used for new files and output dirs).
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let candidate = Path::new(rel);
        let joined = if candidate.is_absolute() {
            candidate.to_path_buf()
        } else {
            self.root.join(candidate)
        };

        // Normalise lexically first, then canonicalise the deepest existing ancestor
        // so that not-yet-existing paths can still be validated against symlinks.
        let mut normalized = PathBuf::new();
        for comp in joined.components() {
            match comp {
                Component::ParentDir => {
                    normalized.pop();
                }
                Component::CurDir => {}
                other => normalized.push(other),
            }
        }
        let mut existing = normalized.as_path();
        let mut suffix = Vec::new();
        while !existing.exists() {
            suffix.push(existing.file_name().map(|s| s.to_owned()));
            existing = existing.parent().context("path has no existing ancestor")?;
        }
        let mut resolved = existing.canonicalize()?;
        for part in suffix.into_iter().rev().flatten() {
            resolved.push(part);
        }

        if !resolved.starts_with(&self.root) {
            bail!("path '{rel}' is outside the project root");
        }
        Ok(resolved)
    }

    /// Converts an absolute path inside the project to a root-relative `/`-separated path.
    pub fn relative(&self, path: &Path) -> String {
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        rel.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }

    pub async fn read_text(&self, rel: &str) -> Result<String> {
        let path = self.resolve(rel)?;
        let meta = tokio::fs::metadata(&path)
            .await
            .with_context(|| format!("cannot access {rel}"))?;
        if !meta.is_file() {
            bail!("{rel} is not a regular file");
        }
        if meta.len() > MAX_TEXT_FILE_BYTES {
            bail!("{rel} is too large ({} bytes, limit {MAX_TEXT_FILE_BYTES})", meta.len());
        }
        let bytes = tokio::fs::read(&path).await?;
        String::from_utf8(bytes).map_err(|_| anyhow!("{rel} is not a UTF-8 text file"))
    }

    pub async fn read_bytes(&self, rel: &str) -> Result<Vec<u8>> {
        let path = self.resolve(rel)?;
        tokio::fs::read(&path)
            .await
            .with_context(|| format!("cannot read {rel}"))
    }

    /// Writes a file atomically (temp file + rename), creating parent directories.
    pub async fn write(&self, rel: &str, contents: &[u8]) -> Result<()> {
        let path = self.resolve(rel)?;
        if path == self.root {
            bail!("cannot write to the project root");
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let tmp = path.with_file_name(format!(
            ".{}.texcraft-tmp",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        tokio::fs::write(&tmp, contents)
            .await
            .with_context(|| format!("cannot write {rel}"))?;
        tokio::fs::rename(&tmp, &path)
            .await
            .with_context(|| format!("cannot write {rel}"))?;
        Ok(())
    }

    pub async fn create_file(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path.exists() {
            bail!("{rel} already exists");
        }
        self.write(rel, b"").await
    }

    pub async fn create_dir(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path.exists() {
            bail!("{rel} already exists");
        }
        tokio::fs::create_dir_all(&path)
            .await
            .with_context(|| format!("cannot create folder {rel}"))
    }

    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let src = self.resolve(from)?;
        let dst = self.resolve(to)?;
        if src == self.root {
            bail!("cannot rename the project root");
        }
        if !src.exists() {
            bail!("{from} does not exist");
        }
        if dst.exists() {
            bail!("{to} already exists");
        }
        if let Some(parent) = dst.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&src, &dst)
            .await
            .with_context(|| format!("cannot rename {from} to {to}"))
    }

    pub async fn delete(&self, rel: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        if path == self.root {
            bail!("cannot delete the project root");
        }
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .with_context(|| format!("{rel} does not exist"))?;
        if meta.is_dir() {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        }
        .with_context(|| format!("cannot delete {rel}"))
    }

    /// Recursively lists the project, folders first, then files, both alphabetically.
    /// `exclude` names root-level directories to hide (e.g. the build output dir).
    pub fn tree(&self, exclude: &[&str]) -> Result<Vec<FileNode>> {
        self.walk(&self.root, exclude, 0)
    }

    fn walk(&self, dir: &Path, exclude: &[&str], depth: usize) -> Result<Vec<FileNode>> {
        if depth > 16 {
            return Ok(Vec::new());
        }
        let mut nodes = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type()?;
            if name == ".DS_Store" || name.ends_with(".texcraft-tmp") {
                continue;
            }
            if file_type.is_dir()
                && (HIDDEN_DIRS.contains(&name.as_str()) || (depth == 0 && exclude.contains(&name.as_str())))
            {
                continue;
            }
            let path = entry.path();
            // Symlinks are listed but never followed, so the tree can't escape the root.
            let is_dir = file_type.is_dir();
            nodes.push(FileNode {
                name,
                path: self.relative(&path),
                is_dir,
                children: if is_dir { Some(self.walk(&path, exclude, depth + 1)?) } else { None },
            });
        }
        nodes.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(nodes)
    }

    /// Picks the most likely main document: a root-level `.tex` file containing `\documentclass`,
    /// preferring `main.tex`.
    pub fn guess_main_document(&self) -> Option<String> {
        let mut candidates: Vec<String> = std::fs::read_dir(&self.root)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tex"))
            .filter(|n| {
                std::fs::read_to_string(self.root.join(n))
                    .map(|s| s.contains("\\documentclass"))
                    .unwrap_or(false)
            })
            .collect();
        candidates.sort();
        candidates
            .iter()
            .find(|n| n.as_str() == "main.tex")
            .or_else(|| candidates.first())
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> (PathBuf, Project) {
        let dir = std::env::temp_dir().join(format!(
            "texcraft-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let project = Project::open(&dir).unwrap();
        (dir, project)
    }

    #[test]
    fn rejects_escapes() {
        let (dir, project) = temp_project();
        assert!(project.resolve("../outside.tex").is_err());
        assert!(project.resolve("/etc/passwd").is_err());
        assert!(project.resolve("a/../../b").is_err());
        assert!(project.resolve("chapters/new.tex").is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn file_operations_round_trip() {
        let (dir, project) = temp_project();
        project.write("chapters/intro.tex", b"\\section{Intro}").await.unwrap();
        assert_eq!(project.read_text("chapters/intro.tex").await.unwrap(), "\\section{Intro}");
        project.rename("chapters/intro.tex", "intro.tex").await.unwrap();
        project.create_dir("figures").await.unwrap();
        let tree = project.tree(&[]).unwrap();
        let names: Vec<_> = tree.iter().map(|n| n.path.as_str()).collect();
        assert_eq!(names, vec!["chapters", "figures", "intro.tex"]);
        project.delete("chapters").await.unwrap();
        assert!(project.read_text("chapters/intro.tex").await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

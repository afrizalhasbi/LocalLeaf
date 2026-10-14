//! Project-folder management for the dashboard: rename, move and trash whole projects.

use std::path::{Path, PathBuf};

use crate::{err, AppState, CmdResult};
use tauri::State;

/// Canonicalizes a project folder and refuses paths that must never be renamed/moved/trashed.
fn checked_project_dir(state: &AppState, root: &str) -> CmdResult<PathBuf> {
    checked_dir(state.open_root().as_deref(), root)
}

fn checked_dir(open_root: Option<&Path>, root: &str) -> CmdResult<PathBuf> {
    let path = Path::new(root)
        .canonicalize()
        .map_err(|_| format!("{root} no longer exists"))?;
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if path.parent().is_none() || Some(&path) == home.as_ref() || path.components().count() < 3 {
        return Err(format!("refusing to modify {}", path.display()));
    }
    if open_root == Some(path.as_path()) {
        return Err("close the project before changing its folder".into());
    }
    Ok(path)
}

fn valid_name(name: &str) -> CmdResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err("invalid folder name".into());
    }
    Ok(name)
}

/// Renames the project folder in place. Returns the new absolute path.
#[tauri::command]
pub fn rename_project_folder(state: State<'_, AppState>, root: String, new_name: String) -> CmdResult<String> {
    let src = checked_project_dir(&state, &root)?;
    rename_dir(&src, &new_name)
}

pub(crate) fn rename_dir(src: &Path, new_name: &str) -> CmdResult<String> {
    let name = valid_name(new_name)?;
    let dst = src.parent().ok_or("invalid project folder")?.join(name);
    if dst == src {
        return Ok(dst.to_string_lossy().into_owned());
    }
    // Allow case-only renames on case-insensitive file systems.
    let case_only = dst.to_string_lossy().to_lowercase() == src.to_string_lossy().to_lowercase();
    if dst.exists() && !case_only {
        return Err(format!("{} already exists", dst.display()));
    }
    std::fs::rename(src, &dst).map_err(err)?;
    Ok(dst.to_string_lossy().into_owned())
}

/// Moves the project folder into `destination` (a parent directory), removing it from the
/// old location. Uses a rename when possible, otherwise copies, verifies and then deletes.
#[tauri::command]
pub async fn move_project_folder(state: State<'_, AppState>, root: String, destination: String) -> CmdResult<String> {
    let src = checked_project_dir(&state, &root)?;
    tokio::task::spawn_blocking(move || move_dir(&src, &destination, false)).await.map_err(err)?
}

/// `force_copy` exercises the cross-volume path in tests.
fn move_dir(src: &Path, destination: &str, force_copy: bool) -> CmdResult<String> {
    let parent = Path::new(&destination)
        .canonicalize()
        .map_err(|_| format!("{destination} does not exist"))?;
    if !parent.is_dir() {
        return Err(format!("{} is not a folder", parent.display()));
    }
    if parent.starts_with(src) {
        return Err("a project cannot be moved inside itself".into());
    }
    let dst = parent.join(src.file_name().ok_or("invalid project folder")?);
    if dst == src {
        return Ok(dst.to_string_lossy().into_owned());
    }
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }

    let (from, to) = (src.to_path_buf(), dst.clone());
    let renamed = if force_copy { Err(std::io::Error::other("forced copy")) } else { std::fs::rename(&from, &to) };
    match renamed {
            Ok(()) => {}
            // Different volume: copy everything, check it arrived, then remove the original.
            Err(_) => {
                let copied = copy_dir(&from, &to).and_then(|n| {
                    let arrived = count_files(&to)?;
                    if arrived == n {
                        Ok(())
                    } else {
                        Err(std::io::Error::other(format!("copied {arrived} of {n} files")))
                    }
                });
                if let Err(e) = copied {
                    let _ = std::fs::remove_dir_all(&to);
                    return Err(format!("move failed, the original was left untouched: {e}"));
                }
                std::fs::remove_dir_all(&from).map_err(|e| format!("copied, but could not remove the old folder: {e}"))?;
            }
    }
    Ok(dst.to_string_lossy().into_owned())
}

/// Moves the project folder to the system Trash (recoverable).
#[tauri::command]
pub fn trash_project_folder(state: State<'_, AppState>, root: String) -> CmdResult<()> {
    let path = checked_project_dir(&state, &root)?;
    trash::delete(&path).map_err(err)
}

/// Copies a directory tree; returns the number of files copied. Symlinks are recreated, not followed.
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(dst)?;
    let mut files = 0;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if kind.is_dir() {
            files += copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &target)?;
            files += 1;
        } else {
            std::fs::copy(entry.path(), &target)?;
            files += 1;
        }
    }
    Ok(files)
}

fn count_files(dir: &Path) -> std::io::Result<usize> {
    let mut n = 0;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        n += if entry.file_type()?.is_dir() { count_files(&entry.path())? } else { 1 };
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("localleaf-test-{tag}-{}", std::process::id()))
            .canonicalize()
            .unwrap_or_else(|_| {
                let d = std::env::temp_dir().join(format!("localleaf-test-{tag}-{}", std::process::id()));
                std::fs::create_dir_all(&d).unwrap();
                d.canonicalize().unwrap()
            });
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("thesis/chapters")).unwrap();
        std::fs::write(dir.join("thesis/main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(dir.join("thesis/chapters/intro.tex"), "intro").unwrap();
        std::fs::create_dir_all(dir.join("archive")).unwrap();
        dir
    }

    #[test]
    fn renames_project_folder() {
        let dir = sandbox("rename");
        let new = rename_dir(&dir.join("thesis"), "tesi-finale").unwrap();
        assert!(Path::new(&new).join("chapters/intro.tex").is_file());
        assert!(!dir.join("thesis").exists());
        assert!(rename_dir(&dir.join("tesi-finale"), "../escape").is_err());
        assert!(rename_dir(&dir.join("tesi-finale"), "archive").is_err(), "must not overwrite");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn moves_project_by_rename_and_by_copy() {
        for force_copy in [false, true] {
            let dir = sandbox(if force_copy { "copy" } else { "move" });
            let new = move_dir(&dir.join("thesis"), dir.join("archive").to_str().unwrap(), force_copy).unwrap();
            assert_eq!(Path::new(&new), dir.join("archive/thesis"));
            assert_eq!(std::fs::read_to_string(dir.join("archive/thesis/chapters/intro.tex")).unwrap(), "intro");
            assert!(!dir.join("thesis").exists(), "old location must be removed");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn refuses_dangerous_targets() {
        let dir = sandbox("guard");
        let thesis = dir.join("thesis");
        assert!(move_dir(&thesis, thesis.join("chapters").to_str().unwrap(), false).is_err(), "into itself");
        assert!(checked_dir(Some(&thesis), thesis.to_str().unwrap()).is_err(), "project is open");
        assert!(checked_dir(None, "/").is_err());
        if let Some(home) = std::env::var_os("HOME") {
            assert!(checked_dir(None, &home.to_string_lossy()).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}

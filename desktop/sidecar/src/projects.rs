//! Project-folder management for the dashboard: rename and move whole projects.

use std::path::Path;

use crate::{err, CmdResult};

fn valid_name(name: &str) -> CmdResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':']) {
        return Err("invalid folder name".into());
    }
    Ok(name)
}

/// Renames the project folder in place. Returns the new absolute path.
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
pub(crate) fn move_dir(src: &Path, destination: &str) -> CmdResult<String> {
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
    let renamed = std::fs::rename(&from, &to);
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

//! Process environment fixes shared by the CLI and the desktop app.

use std::collections::BTreeSet;
use std::path::PathBuf;

/// Programs launched from Finder, the Dock or another GUI app (e.g. an MCP client) get a
/// minimal `PATH` that lacks TeX. Recover the user's login-shell `PATH` and add the usual
/// TeX and Homebrew locations so the engines are found. Call it once, early, before any
/// threads are spawned.
pub fn fix_path() {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();

    #[cfg(unix)]
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-lc", "printf '%s' \"$PATH\""])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            let shell_path = String::from_utf8_lossy(&out.stdout);
            if let Some(last) = shell_path.lines().last() {
                paths.extend(std::env::split_paths(last));
            }
        }
    }

    #[cfg(unix)]
    {
        paths.extend(
            ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
                .into_iter()
                .map(PathBuf::from),
        );
        // TeX Live installed with install-tl on Linux: /usr/local/texlive/<year>/bin/<arch>
        if let Ok(years) = std::fs::read_dir("/usr/local/texlive") {
            let mut bins: Vec<PathBuf> = years
                .flatten()
                .filter_map(|y| std::fs::read_dir(y.path().join("bin")).ok())
                .flat_map(|arches| arches.flatten().map(|a| a.path()))
                .filter(|p| p.is_dir())
                .collect();
            bins.sort();
            bins.reverse(); // newest year first
            paths.extend(bins);
        }
        if let Some(home) = std::env::var_os("HOME") {
            paths.push(PathBuf::from(&home).join(".cargo/bin"));
            paths.push(PathBuf::from(&home).join("bin"));
        }
    }

    let mut seen = BTreeSet::new();
    paths.retain(|p| seen.insert(p.clone()));
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

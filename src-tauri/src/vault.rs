//! Direct filesystem access to the Obsidian vault. This is the ONLY data
//! source besides the Anthropic API — Nexus Shell has zero coupling to any
//! other app or backend. Also reads the trading agents' state files from the
//! vault's .poolside directory so their workstations show real activity.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &[
    ".obsidian", ".git", ".poolside", "node_modules", ".claude",
    "NEXUS", "nexus", "target", "dist",
];

fn vault_root(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !p.is_dir() {
        return Err(format!("Vault path is not a directory: {path}"));
    }
    Ok(p)
}

/// Resolve a vault-relative file path and refuse anything that escapes the
/// vault (.. traversal) — agents only ever touch vault files.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.contains("..") {
        return Err("Path traversal is not allowed".into());
    }
    let joined = root.join(rel);
    if !joined.starts_with(root) {
        return Err("Path escapes the vault".into());
    }
    Ok(joined)
}

fn is_indexable(entry: &walkdir::DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy();
    if entry.file_type().is_dir() {
        return !SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.');
    }
    name.ends_with(".md")
}

#[derive(Serialize)]
pub struct VaultStats {
    pub files: usize,
    pub words: u64,
    pub folders: usize,
    pub recent: Vec<String>, // most recently modified notes (vault-relative)
}

#[tauri::command]
pub fn vault_scan(path: String) -> Result<VaultStats, String> {
    let root = vault_root(&path)?;
    let mut files = 0usize;
    let mut words = 0u64;
    let mut folders = 0usize;
    let mut mtimes: Vec<(std::time::SystemTime, String)> = Vec::new();

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(is_indexable)
        .filter_map(Result::ok)
    {
        if entry.file_type().is_dir() {
            folders += 1;
            continue;
        }
        files += 1;
        if let Ok(meta) = entry.metadata() {
            // Word counts on a bounded sample keep big vaults fast
            if files <= 3000 {
                if let Ok(text) = fs::read_to_string(entry.path()) {
                    words += text.split_whitespace().count() as u64;
                }
            }
            if let (Ok(modified), Ok(rel)) = (meta.modified(), entry.path().strip_prefix(&root)) {
                mtimes.push((modified, rel.to_string_lossy().into_owned()));
            }
        }
    }

    mtimes.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(VaultStats {
        files,
        words,
        folders,
        recent: mtimes.into_iter().take(8).map(|(_, p)| p).collect(),
    })
}

#[tauri::command]
pub fn vault_read(path: String, file: String) -> Result<String, String> {
    let root = vault_root(&path)?;
    let target = safe_join(&root, &file)?;
    fs::read_to_string(&target).map_err(|e| format!("read {file}: {e}"))
}

#[tauri::command]
pub fn vault_write(path: String, file: String, content: String) -> Result<(), String> {
    let root = vault_root(&path)?;
    if !file.ends_with(".md") {
        return Err("Agents may only write Markdown notes".into());
    }
    let target = safe_join(&root, &file)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target, content).map_err(|e| format!("write {file}: {e}"))
}

#[derive(Serialize)]
pub struct SearchHit {
    pub file: String,
    pub line: usize,
    pub text: String,
}

#[tauri::command]
pub fn vault_search(path: String, query: String, max: Option<usize>) -> Result<Vec<SearchHit>, String> {
    let root = vault_root(&path)?;
    let needle = query.to_lowercase();
    let cap = max.unwrap_or(20).min(100);
    let mut hits = Vec::new();

    'outer: for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(is_indexable)
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        let rel = entry
            .path()
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    file: rel.clone(),
                    line: i + 1,
                    text: line.chars().take(220).collect(),
                });
                if hits.len() >= cap {
                    break 'outer;
                }
            }
        }
    }
    Ok(hits)
}

#[derive(Serialize)]
pub struct FolderStat {
    pub name: String,
    pub files: usize,
    pub recent: usize, // modified in the last 24h
}

/// Per-top-level-folder note counts — feeds the brain-region labels so each
/// region reflects a REAL path in the Obsidian brain.
#[tauri::command]
pub fn vault_folders(path: String) -> Result<Vec<FolderStat>, String> {
    let root = vault_root(&path)?;
    let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(86_400);
    let mut out = Vec::new();

    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() || name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let mut files = 0usize;
        let mut recent = 0usize;
        for f in WalkDir::new(entry.path())
            .into_iter()
            .filter_entry(is_indexable)
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            files += 1;
            if let Ok(meta) = f.metadata() {
                if meta.modified().map(|m| m > day_ago).unwrap_or(false) {
                    recent += 1;
                }
            }
        }
        if files > 0 {
            out.push(FolderStat { name, files, recent });
        }
    }
    out.sort_by(|a, b| b.files.cmp(&a.files));
    Ok(out)
}

// ── trading agents (read-only views over the vault's .poolside files) ──────

#[derive(Serialize, Default)]
pub struct TradingState {
    pub scalperx: Option<serde_json::Value>,
    pub scalperx_reserve: Option<serde_json::Value>,
    pub scalperx_open_positions: usize,
    pub scalperx_trades: usize,
    pub night_watch: Option<serde_json::Value>,
    pub night_watch_reserve: Option<serde_json::Value>,
    pub night_watch_trades: usize,
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

fn count_lines(p: &Path) -> usize {
    fs::read_to_string(p)
        .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0)
}

#[tauri::command]
pub fn trading_state(path: String) -> Result<TradingState, String> {
    let root = vault_root(&path)?;
    let pool = root.join(".poolside");
    let mut s = TradingState::default();

    s.scalperx = read_json(&pool.join("scalperx_heartbeat.json"));
    s.scalperx_reserve = read_json(&pool.join("scalperx_reserve.json"));
    s.scalperx_trades = count_lines(&pool.join("scalperx_trade_journal.jsonl"));
    if let Some(hb) = &s.scalperx {
        s.scalperx_open_positions = hb
            .get("open_positions")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
    }

    s.night_watch = read_json(&pool.join("night_watch_state.json"));
    s.night_watch_reserve = read_json(&pool.join("night_watch_reserve.json"));
    s.night_watch_trades = count_lines(&pool.join("night_watch_trade_journal.jsonl"));
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traversal_is_blocked() {
        let tmp = std::env::temp_dir();
        assert!(safe_join(&tmp, "../etc/passwd").is_err());
        assert!(safe_join(&tmp, "notes/ok.md").is_ok());
    }

    #[test]
    fn scan_and_search_roundtrip() {
        let dir = std::env::temp_dir().join("nexus_vault_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Notes")).unwrap();
        fs::write(dir.join("Notes/a.md"), "hello trailing stop world").unwrap();
        fs::write(dir.join("Notes/b.md"), "another note").unwrap();

        let stats = vault_scan(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(stats.files, 2);
        assert!(stats.words >= 6);

        let hits = vault_search(
            dir.to_string_lossy().into_owned(),
            "trailing".into(),
            None,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].file, "Notes/a.md");

        vault_write(
            dir.to_string_lossy().into_owned(),
            "Agent Output/c.md".into(),
            "# written by agent".into(),
        )
        .unwrap();
        let back = vault_read(dir.to_string_lossy().into_owned(), "Agent Output/c.md".into()).unwrap();
        assert!(back.contains("written by agent"));
        let _ = fs::remove_dir_all(&dir);
    }
}

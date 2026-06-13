//! Skills bridge — Nexus shares Claude's skill library (~/.claude/skills)
//! directly. One library, zero double-handling: the agent can search the
//! catalogue and load any skill's full instructions on demand.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn skills_dir() -> PathBuf {
    dirs_home().join(".claude").join("skills")
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

/// Pull `name:` and `description:` out of a SKILL.md YAML frontmatter block.
fn parse_front(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                let line = line.trim();
                if let Some(v) = line.strip_prefix("name:") {
                    name = Some(v.trim().trim_matches('"').to_string());
                } else if let Some(v) = line.strip_prefix("description:") {
                    desc = Some(v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    (name, desc)
}

/// Search the skill catalogue. Returns up to `limit` matches + total count.
pub fn list_skills(query: &str, limit: usize) -> Result<Value, String> {
    let dir = skills_dir();
    if !dir.is_dir() {
        return Err(format!("No skills library at {}", dir.display()));
    }
    let q = query.to_lowercase();
    let mut total = 0usize;
    let mut hits: Vec<Value> = Vec::new();

    let mut entries: Vec<_> = fs::read_dir(&dir).map_err(|e| e.to_string())?
        .flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        if !entry.path().is_dir() { continue; }
        let folder = entry.file_name().to_string_lossy().into_owned();
        let skill_md = entry.path().join("SKILL.md");
        if !skill_md.exists() { continue; }
        total += 1;

        // cheap filter on folder name first; read the file only when needed
        let mut desc = String::new();
        let mut matched = q.is_empty() || folder.to_lowercase().contains(&q);
        if !matched || !q.is_empty() {
            if let Ok(text) = fs::read_to_string(&skill_md) {
                let (_, d) = parse_front(&text);
                desc = d.unwrap_or_default();
                if !matched {
                    matched = desc.to_lowercase().contains(&q);
                }
            }
        }
        if matched && hits.len() < limit {
            if desc.is_empty() {
                if let Ok(text) = fs::read_to_string(&skill_md) {
                    desc = parse_front(&text).1.unwrap_or_default();
                }
            }
            hits.push(json!({ "name": folder, "description": desc }));
        }
    }
    Ok(json!({ "total_in_library": total, "matches": hits }))
}

/// Load one skill's full instructions (bounded).
pub fn read_skill(name: &str) -> Result<String, String> {
    if name.contains("..") || name.contains('/') {
        return Err("Invalid skill name".into());
    }
    let path = skills_dir().join(name).join("SKILL.md");
    let text = fs::read_to_string(&path)
        .map_err(|_| format!("Skill '{name}' not found — use list_skills to search the catalogue"))?;
    Ok(text.chars().take(24_000).collect())
}

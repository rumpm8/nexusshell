//! STUDIO — the old NEXUS app's portfolio / tasks / ideas / forge modules,
//! rebuilt for Nexus Shell. Ideas keep the SAME on-disk store as the old app
//! (vault/nexus/Memory/Ideas/*.md with YAML frontmatter) so nothing is lost;
//! portfolio reads every strategy's .poolside state; tasks live in the
//! shell's SQLite; forge runs through the agent engine.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn read_json(p: &PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// Every trading strategy's live state in one call (old PortfolioView data,
/// plus the new agents' reserves).
#[tauri::command]
pub fn portfolio_states(path: String) -> Result<Value, String> {
    let pool = PathBuf::from(&path).join(".poolside");
    Ok(json!({
        "scalperx":        read_json(&pool.join("scalperx_state.json")),
        "scalperx_reserve": read_json(&pool.join("scalperx_reserve.json")),
        "night_watch":     read_json(&pool.join("night_watch_state.json")),
        "night_watch_reserve": read_json(&pool.join("night_watch_reserve.json")),
        "meme_scalper":    read_json(&pool.join("meme_scalper_state.json")),
        "polymarket":      read_json(&pool.join("polymarket_state.json")),
        "perps":           read_json(&pool.join("perps_state.json")),
        "pumpfun":         read_json(&pool.join("pumpfun_state.json")),
        "rsi_positions":   read_json(&pool.join("TradingAgent_RSIScalpStrategy_positions.json")),
        "risk":            read_json(&pool.join("risk_state.json")),
    }))
}

/* ── ideas: same markdown store as the old app ───────────────────────────── */

fn ideas_dir(vault: &str) -> PathBuf {
    PathBuf::from(vault).join("nexus").join("Memory").join("Ideas")
}

fn parse_front(text: &str) -> (Value, String) {
    let mut meta = json!({});
    if let Some(rest) = text.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim();
                    let val = v.trim().trim_matches('"');
                    if key == "tags" {
                        let tags: Vec<String> = val.trim_matches(['[', ']'])
                            .split(',')
                            .map(|t| t.trim().trim_matches(['"', '\'']).to_string())
                            .filter(|t| !t.is_empty())
                            .collect();
                        meta["tags"] = json!(tags);
                    } else if ["title", "created", "modified"].contains(&key) {
                        meta[key] = json!(val);
                    }
                }
            }
            let body = rest[end + 4..].trim_start().to_string();
            return (meta, body);
        }
    }
    (meta, text.to_string())
}

#[tauri::command]
pub fn ideas_list(path: String) -> Result<Vec<Value>, String> {
    let dir = ideas_dir(&path);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().map(|e| e != "md").unwrap_or(true) || !p.is_file() {
            continue;
        }
        let id = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let text = fs::read_to_string(&p).unwrap_or_default();
        let (meta, body) = parse_front(&text);
        out.push(json!({
            "id": id,
            "title": meta["title"].as_str().unwrap_or(&id),
            "tags": meta["tags"],
            "created": meta["created"],
            "modified": meta["modified"],
            "preview": body.chars().take(180).collect::<String>(),
            "body": body,
        }));
    }
    out.sort_by(|a, b| b["modified"].as_str().unwrap_or("")
        .cmp(a["modified"].as_str().unwrap_or("")));
    Ok(out)
}

#[tauri::command]
pub fn ideas_save(path: String, id: Option<String>, title: String,
                  tags: Vec<String>, body: String) -> Result<String, String> {
    let dir = ideas_dir(&path);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let slug = id.unwrap_or_else(|| {
        let s: String = title.to_lowercase().chars()
            .map(|c| if c.is_alphanumeric() { c } else { '-' })
            .collect::<String>()
            .split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
        if dir.join(format!("{s}.md")).exists() {
            format!("{s}-{}", chrono_now().replace([':', '.'], "-"))
        } else { s }
    });
    if slug.contains("..") || slug.contains('/') {
        return Err("Invalid idea id".into());
    }

    let now = chrono_now();
    let existing = fs::read_to_string(dir.join(format!("{slug}.md"))).ok();
    let created = existing.as_deref()
        .map(|t| parse_front(t).0["created"].as_str().unwrap_or(&now).to_string())
        .unwrap_or_else(|| now.clone());

    let tags_str = tags.iter().map(|t| format!("\"{t}\"")).collect::<Vec<_>>().join(", ");
    let content = format!(
        "---\ntitle: {title}\ntags: [{tags_str}]\ncreated: {created}\nmodified: {now}\n---\n\n{body}\n");
    fs::write(dir.join(format!("{slug}.md")), content).map_err(|e| e.to_string())?;
    Ok(slug)
}

#[tauri::command]
pub fn ideas_archive(path: String, id: String) -> Result<(), String> {
    if id.contains("..") || id.contains('/') {
        return Err("Invalid idea id".into());
    }
    let dir = ideas_dir(&path);
    let archive = dir.join("_archive");
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
    fs::rename(dir.join(format!("{id}.md")), archive.join(format!("{id}.md")))
        .map_err(|e| e.to_string())
}

fn chrono_now() -> String {
    // ISO-ish timestamp without pulling in chrono
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    let (y, m, d) = civil_from_days(days as i64);
    let tod = secs % 86400;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            y, m, d, tod / 3600, (tod % 3600) / 60, tod % 60)
}

/// days-since-epoch → (y, m, d) — Howard Hinnant's civil_from_days
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

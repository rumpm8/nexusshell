//! Operator powers — full filesystem + terminal control for the Nexus agent.
//!
//! The user explicitly wants Nexus to operate the whole machine. These tools
//! give it that: read/write/list ANY path and run ANY shell command. The ONE
//! safety floor is a catastrophe guard that blocks only machine-bricking /
//! self-destruct operations (rm -rf / or ~, disk format, fork bombs, sudo,
//! curl|sh, writes into system dirs). That floor never restricts real work —
//! it only stops the AI from destroying the Mac on a bad turn or a poisoned
//! web page. Every operator action is appended to an audit log.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

fn audit(action: &str, detail: &str) {
    let line = format!("{}\t{action}\t{detail}\n", now_iso());
    let path = home().join(".nexus-shell").join("operator-audit.log");
    let _ = fs::create_dir_all(path.parent().unwrap());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("@{secs}")
}

/// Blocks ONLY catastrophic, irreversible machine-destroying commands.
/// Returns Some(reason) if the command must be refused.
fn catastrophic(cmd: &str) -> Option<String> {
    let c = cmd.to_lowercase();
    let c_nospace = c.replace([' ', '\t'], "");

    // recursive deletion of root or home
    let bad_rm = [
        "rm-rf/", "rm-fr/", "rm-rf~", "rm-fr~", "rm-rf$home", "rm-rf/*",
        "rm-rf--no-preserve-root", "rm-rf.",
    ];
    for b in bad_rm {
        if c_nospace.contains(b) { return Some(format!("blocked: catastrophic delete ({b})")); }
    }
    // delete of critical system roots
    for p in ["rm -rf /system", "rm -rf /usr", "rm -rf /bin", "rm -rf /etc",
              "rm -rf /library", "rm -rf /applications", "rm -rf /users"] {
        if c.contains(p) { return Some("blocked: deleting a system directory".into()); }
    }
    // disk / filesystem destroyers
    for p in ["mkfs", "dd if=", "dd of=/dev/", "diskutil erasedisk",
              "diskutil erasevolume", ">/dev/sda", "of=/dev/disk"] {
        if c.contains(p) { return Some("blocked: disk-destroying command".into()); }
    }
    // fork bomb
    if c_nospace.contains(":(){:|:&};:") || c_nospace.contains(":(){:|:&};") {
        return Some("blocked: fork bomb".into());
    }
    // privilege escalation — Nexus runs as you, it should not sudo
    if c.split_whitespace().next() == Some("sudo") || c.contains("| sudo") || c.contains("&& sudo") {
        return Some("blocked: sudo (privilege escalation) is not permitted".into());
    }
    // pipe-to-shell from the network (classic injection vector)
    if (c.contains("curl ") || c.contains("wget ")) &&
       (c.contains("| sh") || c.contains("| bash") || c.contains("|sh") || c.contains("|bash")) {
        return Some("blocked: piping a network download straight into a shell".into());
    }
    // overwrite the audit log or shell binaries
    if c.contains("operator-audit.log") && (c.contains('>') || c.contains("rm ")) {
        return Some("blocked: tampering with the operator audit log".into());
    }
    None
}

fn guard_path_write(path: &str) -> Option<String> {
    let p = path.to_lowercase();
    for sys in ["/system/", "/usr/bin/", "/usr/sbin/", "/bin/", "/sbin/"] {
        if p.starts_with(sys) {
            return Some(format!("blocked: writing into a protected system path ({sys})"));
        }
    }
    None
}

/* ── commands (exposed to the Nexus agent as tools) ──────────────────────── */

#[tauri::command]
pub fn op_read(path: String) -> Result<String, String> {
    audit("read", &path);
    fs::read_to_string(&path)
        .map(|t| t.chars().take(60_000).collect())
        .map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
pub fn op_write(path: String, content: String) -> Result<String, String> {
    if let Some(r) = guard_path_write(&path) { return Err(r); }
    audit("write", &format!("{} ({} bytes)", path, content.len()));
    if let Some(parent) = PathBuf::from(&path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&path, content).map(|_| format!("wrote {path}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn op_list(path: String) -> Result<Value, String> {
    audit("list", &path);
    let mut entries = Vec::new();
    for e in fs::read_dir(&path).map_err(|e| e.to_string())?.flatten() {
        let meta = e.metadata().ok();
        entries.push(json!({
            "name": e.file_name().to_string_lossy(),
            "dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
        }));
    }
    Ok(json!({ "path": path, "entries": entries }))
}

#[tauri::command]
pub fn op_shell(command: String, cwd: Option<String>) -> Result<Value, String> {
    if let Some(reason) = catastrophic(&command) {
        audit("shell-BLOCKED", &command);
        return Err(reason);
    }
    audit("shell", &command);
    let dir = cwd.unwrap_or_else(|| home().to_string_lossy().into_owned());
    let out = Command::new("/bin/zsh")
        .arg("-lc")
        .arg(&command)
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("exec failed: {e}"))?;
    // bound output so a huge dump doesn't blow out the agent context
    let cap = |b: &[u8]| String::from_utf8_lossy(b).chars().take(40_000).collect::<String>();
    Ok(json!({
        "exit_code": out.status.code(),
        "stdout": cap(&out.stdout),
        "stderr": cap(&out.stderr),
    }))
}

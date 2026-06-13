//! Claude agent engine. Runs an agentic loop against the Anthropic Messages
//! API entirely in Rust: the API key is read from the macOS Keychain here and
//! never crosses into the webview. Agents get vault tools (read / write /
//! search) scoped to the configured Obsidian vault. Progress streams to the
//! UI as `agent-event` Tauri events; the frontend logs them to SQLite.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::vault;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
const DEFAULT_MODEL: &str = "claude-sonnet-4-6";
const MAX_TURNS: usize = 8;
// Display-only blended cost estimate (Sonnet-class pricing per MTok)
const COST_IN_PER_MTOK: f64 = 3.0;
const COST_OUT_PER_MTOK: f64 = 15.0;

#[derive(Serialize, Clone)]
pub struct AgentEvent {
    pub worker_id: String,
    pub phase: String, // started | thinking | tool | done | error
    pub text: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
}

#[derive(Serialize)]
pub struct AgentResult {
    pub output: String,
    pub turns: usize,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cost_usd: f64,
    pub tool_calls: usize,
}

fn api_key() -> Result<String, String> {
    keyring::Entry::new("nexus-shell", "anthropic_api_key")
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| "Anthropic API key not configured — add it in Settings".to_string())
}

fn tool_definitions() -> Value {
    json!([
        {
            "name": "vault_read",
            "description": "Read a Markdown note from the Obsidian vault. Path is vault-relative, e.g. 'Trading Data/ScalperX Dashboard.md'.",
            "input_schema": {
                "type": "object",
                "properties": { "file": { "type": "string" } },
                "required": ["file"]
            }
        },
        {
            "name": "vault_write",
            "description": "Create or overwrite a Markdown note in the vault. Use a vault-relative path ending in .md.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "file": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["file", "content"]
            }
        },
        {
            "name": "vault_search",
            "description": "Case-insensitive full-text search across vault notes. Returns file, line number and matching line.",
            "input_schema": {
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }
        },
        {
            "name": "trading_summary",
            "description": "Live snapshot of the trading system: ScalperX heartbeat/open positions/reserve, NightWatch state, recent closed trades, and the brain controller phase.",
            "input_schema": { "type": "object", "properties": {} }
        },
        {
            "name": "op_read",
            "description": "Read ANY file on this machine by absolute path. Full operator access.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        },
        {
            "name": "op_write",
            "description": "Write ANY file on this machine (creates parent dirs). Full operator access — use deliberately.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "op_list",
            "description": "List the contents of any directory by absolute path.",
            "input_schema": {
                "type": "object",
                "properties": { "path": { "type": "string" } },
                "required": ["path"]
            }
        },
        {
            "name": "op_shell",
            "description": "Run ANY shell command on this machine (zsh login shell). Returns exit code, stdout, stderr. Full terminal control. Catastrophic self-destruct commands are blocked.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" }
                },
                "required": ["command"]
            }
        },
        {
            "name": "list_skills",
            "description": "Search the shared Claude skills library (~/.claude/skills, 1000+ skills). Pass a query to filter by name/description. Use this to find a skill before applying it.",
            "input_schema": {
                "type": "object",
                "properties": { "query": { "type": "string" } }
            }
        },
        {
            "name": "use_skill",
            "description": "Load a skill's full instructions by exact name (from list_skills). Follow the returned instructions to perform the task in that skill's style/method.",
            "input_schema": {
                "type": "object",
                "properties": { "name": { "type": "string" } },
                "required": ["name"]
            }
        },
        {
            "name": "brain_command",
            "description": "Control the brain controller. action: pause | resume | run | boost | block | unblock. agent (for run/boost/block/unblock): e.g. 'night_watch', 'scalperx_watchdog', 'research', 'dex'. factor: boost multiplier (default 3).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string" },
                    "agent": { "type": "string" },
                    "factor": { "type": "number" }
                },
                "required": ["action"]
            }
        }
    ])
}

fn run_tool(vault_path: &str, name: &str, input: &Value, allowed: &[String]) -> String {
    if !allowed.iter().any(|a| a == name) {
        return format!("ERROR: tool '{name}' is not allowed for this agent");
    }
    let res = match name {
        "vault_read" => {
            let file = input["file"].as_str().unwrap_or_default();
            vault::vault_read(vault_path.into(), file.into())
                // Bound tool results so a huge note can't blow out the context
                .map(|t| t.chars().take(24_000).collect::<String>())
        }
        "vault_write" => {
            let file = input["file"].as_str().unwrap_or_default();
            let content = input["content"].as_str().unwrap_or_default();
            vault::vault_write(vault_path.into(), file.into(), content.into())
                .map(|_| format!("Wrote {file}"))
        }
        "vault_search" => {
            let query = input["query"].as_str().unwrap_or_default();
            vault::vault_search(vault_path.into(), query.into(), Some(20)).map(|hits| {
                if hits.is_empty() {
                    "No matches".to_string()
                } else {
                    hits.iter()
                        .map(|h| format!("{}:{}: {}", h.file, h.line, h.text))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
            })
        }
        "op_read" => crate::operator::op_read(
            input["path"].as_str().unwrap_or_default().to_string()),
        "op_write" => crate::operator::op_write(
            input["path"].as_str().unwrap_or_default().to_string(),
            input["content"].as_str().unwrap_or_default().to_string()),
        "op_list" => crate::operator::op_list(
            input["path"].as_str().unwrap_or_default().to_string())
            .map(|v| v.to_string()),
        "op_shell" => crate::operator::op_shell(
            input["command"].as_str().unwrap_or_default().to_string(),
            input["cwd"].as_str().map(|s| s.to_string()))
            .map(|v| v.to_string()),
        "list_skills" => {
            let query = input["query"].as_str().unwrap_or_default();
            crate::skills::list_skills(query, 40).map(|v| v.to_string())
        }
        "use_skill" => {
            let name = input["name"].as_str().unwrap_or_default();
            crate::skills::read_skill(name)
        }
        "trading_summary" => {
            crate::market::trading_detail(vault_path.into(), Some(15))
                // bound the payload so it doesn't blow out the context
                .map(|v| v.to_string().chars().take(12_000).collect::<String>())
        }
        "brain_command" => {
            let action = input["action"].as_str().unwrap_or_default().to_string();
            let agent = input["agent"].as_str().map(|s| s.to_string());
            let factor = input["factor"].as_f64();
            crate::market::brain_command(vault_path.into(), action.clone(), agent.clone(), factor)
                .map(|f| format!("Command '{action}'{} queued for the brain ({f})",
                    agent.map(|a| format!(" on {a}")).unwrap_or_default()))
        }
        _ => Err(format!("Unknown tool: {name}")),
    };
    res.unwrap_or_else(|e| format!("ERROR: {e}"))
}

fn emit(app: &tauri::AppHandle, ev: AgentEvent) {
    let _ = app.emit("agent-event", ev);
}

#[tauri::command]
pub async fn run_agent(
    app: tauri::AppHandle,
    worker_id: String,
    system_prompt: String,
    task: String,
    vault_path: String,
    allowed_tools: Vec<String>,
    model: Option<String>,
) -> Result<AgentResult, String> {
    let key = api_key()?;
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.to_string());
    let client = reqwest::Client::new();

    let system = format!(
        "{system_prompt}\n\nYou are worker '{worker_id}' inside Nexus Shell, \
         operating on the user's local Obsidian vault. Keep outputs concise. \
         When you create or update notes, use clear vault-relative paths."
    );

    let mut messages = vec![json!({ "role": "user", "content": task })];
    let (mut tokens_in, mut tokens_out, mut tool_calls) = (0u64, 0u64, 0usize);

    emit(&app, AgentEvent {
        worker_id: worker_id.clone(), phase: "started".into(),
        text: task.chars().take(140).collect(), tokens_in: 0, tokens_out: 0, cost_usd: 0.0,
    });

    for turn in 0..MAX_TURNS {
        let body = json!({
            "model": model,
            "max_tokens": 2048,
            "system": system,
            "tools": tool_definitions(),
            "messages": messages,
        });

        let resp = client
            .post(API_URL)
            .header("x-api-key", &key)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("API request failed: {e}"))?;

        let status = resp.status();
        let payload: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            let msg = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown API error")
                .to_string();
            emit(&app, AgentEvent {
                worker_id: worker_id.clone(), phase: "error".into(), text: msg.clone(),
                tokens_in, tokens_out, cost_usd: 0.0,
            });
            return Err(format!("Anthropic API {status}: {msg}"));
        }

        tokens_in += payload["usage"]["input_tokens"].as_u64().unwrap_or(0);
        tokens_out += payload["usage"]["output_tokens"].as_u64().unwrap_or(0);
        let cost = tokens_in as f64 / 1e6 * COST_IN_PER_MTOK
            + tokens_out as f64 / 1e6 * COST_OUT_PER_MTOK;

        let content = payload["content"].as_array().cloned().unwrap_or_default();
        let stop_reason = payload["stop_reason"].as_str().unwrap_or("");

        // Surface any text the model produced this turn
        for block in &content {
            if block["type"] == "text" {
                if let Some(t) = block["text"].as_str() {
                    emit(&app, AgentEvent {
                        worker_id: worker_id.clone(), phase: "thinking".into(),
                        text: t.chars().take(220).collect(),
                        tokens_in, tokens_out, cost_usd: cost,
                    });
                }
            }
        }

        if stop_reason == "tool_use" {
            messages.push(json!({ "role": "assistant", "content": content }));
            let mut results = Vec::new();
            for block in &content {
                if block["type"] == "tool_use" {
                    let name = block["name"].as_str().unwrap_or_default();
                    let input = &block["input"];
                    tool_calls += 1;
                    emit(&app, AgentEvent {
                        worker_id: worker_id.clone(), phase: "tool".into(),
                        text: format!("{name} {}", input.to_string().chars().take(140).collect::<String>()),
                        tokens_in, tokens_out, cost_usd: cost,
                    });
                    let output = run_tool(&vault_path, name, input, &allowed_tools);
                    results.push(json!({
                        "type": "tool_result",
                        "tool_use_id": block["id"],
                        "content": output,
                    }));
                }
            }
            messages.push(json!({ "role": "user", "content": results }));
            continue;
        }

        // Terminal turn — collect final text
        let final_text = content
            .iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");

        emit(&app, AgentEvent {
            worker_id: worker_id.clone(), phase: "done".into(),
            text: final_text.chars().take(220).collect(),
            tokens_in, tokens_out, cost_usd: cost,
        });
        return Ok(AgentResult {
            output: final_text,
            turns: turn + 1,
            tokens_in, tokens_out,
            cost_usd: cost,
            tool_calls,
        });
    }

    let msg = format!("Agent hit the {MAX_TURNS}-turn limit");
    emit(&app, AgentEvent {
        worker_id: worker_id.clone(), phase: "error".into(), text: msg.clone(),
        tokens_in, tokens_out, cost_usd: 0.0,
    });
    Err(msg)
}

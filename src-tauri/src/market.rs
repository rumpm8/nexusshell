//! Market data + trading detail for the Trading Floor.
//!
//! - Candles: GeckoTerminal public API (no key) — finds the deepest DEX pool
//!   for any Solana mint and returns minute OHLCV. This is the same on-chain
//!   data the agents trade against.
//! - Live ticks: Jupiter lite price API.
//! - Trading detail: parses the brain vault's .poolside state — open
//!   positions (with trailing-stop state), trade journals, reserve ledgers.
//! - Brain control: writes commands into the vault's brain_commands/ channel
//!   (pause/resume/boost/block) — the brain controller picks them up within
//!   seconds. This is the official control path, not a side door.

use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const GECKO: &str = "https://api.geckoterminal.com/api/v2";
const JUP_PRICE: &str = "https://lite-api.jup.ag/price/v3";

/// Batched Jupiter price lookup → {mint: usd_price}. Local helper so the
/// wallet snapshot can price holdings without round-tripping through a command.
async fn jup_prices(client: &reqwest::Client, mints: &[String]) -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    if mints.is_empty() {
        return out;
    }
    for chunk in mints.chunks(50) {
        let ids = chunk.join(",");
        if let Ok(resp) = client.get(format!("{JUP_PRICE}?ids={ids}")).send().await {
            if let Ok(data) = resp.json::<Value>().await {
                for m in chunk {
                    if let Some(p) = data[m]["usdPrice"].as_f64() {
                        out.insert(m.clone(), p);
                    }
                }
            }
        }
    }
    out
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("nexus-shell/0.2")
        .build()
        .unwrap_or_default()
}

/// Find the deepest pool for a mint, then pull minute candles from it.
#[tauri::command]
pub async fn market_candles(mint: String, minutes: Option<u32>) -> Result<Value, String> {
    let client = http();

    let pools: Value = client
        .get(format!("{GECKO}/networks/solana/tokens/{mint}/pools?page=1"))
        .header("accept", "application/json")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let top = pools["data"].as_array()
        .and_then(|a| a.first())
        .ok_or("No DEX pool found for this token")?;
    let pool_addr = top["attributes"]["address"].as_str()
        .ok_or("Pool has no address")?;
    let pool_name = top["attributes"]["name"].as_str().unwrap_or("?").to_string();
    let dex = top["relationships"]["dex"]["data"]["id"].as_str().unwrap_or("?").to_string();

    let limit = minutes.unwrap_or(240).min(1000);
    let ohlcv: Value = client
        .get(format!(
            "{GECKO}/networks/solana/pools/{pool_addr}/ohlcv/minute?aggregate=1&limit={limit}&currency=usd"
        ))
        .header("accept", "application/json")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let mut list = ohlcv["data"]["attributes"]["ohlcv_list"].as_array()
        .cloned()
        .ok_or("No OHLCV data for this pool")?;
    // GeckoTerminal returns newest-first; charts want ascending time
    list.sort_by_key(|c| c[0].as_i64().unwrap_or(0));

    Ok(json!({
        "pool": pool_name,
        "dex": dex,
        "candles": list,
    }))
}

/// Live spot prices for a set of mints (Jupiter lite, batched).
#[tauri::command]
pub async fn market_price(mints: Vec<String>) -> Result<Value, String> {
    if mints.is_empty() {
        return Ok(json!({}));
    }
    let ids = mints.join(",");
    let data: Value = http()
        .get(format!("{JUP_PRICE}?ids={ids}"))
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let mut out = serde_json::Map::new();
    for m in &mints {
        if let Some(p) = data[m]["usdPrice"].as_f64() {
            out.insert(m.clone(), json!(p));
        }
    }
    Ok(Value::Object(out))
}

fn read_json_file(p: &PathBuf) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

fn read_jsonl_tail(p: &PathBuf, n: usize) -> Vec<Value> {
    let Ok(text) = fs::read_to_string(p) else { return vec![] };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines.iter().rev().take(n).rev()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Everything the Trading Floor + Agent Ops need in one call.
#[tauri::command]
pub fn trading_detail(path: String, journal_tail: Option<usize>) -> Result<Value, String> {
    let pool = PathBuf::from(&path).join(".poolside");
    let n = journal_tail.unwrap_or(120);

    Ok(json!({
        "scalperx": {
            "heartbeat":  read_json_file(&pool.join("scalperx_heartbeat.json")),
            "state":      read_json_file(&pool.join("scalperx_state.json")),
            "reserve":    read_json_file(&pool.join("scalperx_reserve.json")),
            "tuned":      read_json_file(&pool.join("scalperx_tuned_params.json")),
            "journal":    read_jsonl_tail(&pool.join("scalperx_trade_journal.jsonl"), n),
        },
        "night_watch": {
            "state":      read_json_file(&pool.join("night_watch_state.json")),
            "positions":  read_json_file(&pool.join("night_watch_positions.json")),
            "reserve":    read_json_file(&pool.join("night_watch_reserve.json")),
            "journal":    read_jsonl_tail(&pool.join("night_watch_trade_journal.jsonl"), n),
        },
        "brain": read_json_file(&PathBuf::from(&path).join("brain_state.json")),
    }))
}

/// Phantom/Solana wallet snapshot: SOL balance + every SPL token the wallet
/// holds, priced via Jupiter. Read-only — the shell never signs or moves funds.
#[tauri::command]
pub async fn wallet_balances(address: String) -> Result<Value, String> {
    let client = http();
    let rpc = std::env::var("SOLANA_RPC_URL")
        .unwrap_or_else(|_| "https://api.mainnet-beta.solana.com".into());

    // SOL balance
    let bal: Value = client.post(&rpc).json(&json!({
        "jsonrpc": "2.0", "id": 1, "method": "getBalance", "params": [address]
    })).send().await.map_err(|e| e.to_string())?
       .json().await.map_err(|e| e.to_string())?;
    let lamports = bal["result"]["value"].as_u64().unwrap_or(0);
    let sol = lamports as f64 / 1e9;

    // SPL token accounts
    let toks: Value = client.post(&rpc).json(&json!({
        "jsonrpc": "2.0", "id": 1, "method": "getTokenAccountsByOwner",
        "params": [address,
            {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
            {"encoding": "jsonParsed"}]
    })).send().await.map_err(|e| e.to_string())?
       .json().await.map_err(|e| e.to_string())?;

    let mut holdings = Vec::new();
    let mut mints = Vec::new();
    if let Some(accounts) = toks["result"]["value"].as_array() {
        for acc in accounts {
            let info = &acc["account"]["data"]["parsed"]["info"];
            let mint = info["mint"].as_str().unwrap_or("").to_string();
            let amt = info["tokenAmount"]["uiAmount"].as_f64().unwrap_or(0.0);
            if amt > 0.0 && !mint.is_empty() {
                mints.push(mint.clone());
                holdings.push(json!({ "mint": mint, "amount": amt }));
            }
        }
    }

    // price everything (SOL + held tokens) via Jupiter
    let sol_mint = "So11111111111111111111111111111111111111112";
    let mut price_ids = mints.clone();
    price_ids.push(sol_mint.to_string());
    let prices = jup_prices(&client, &price_ids).await;
    let sol_price = prices.get(sol_mint).copied().unwrap_or(0.0);

    let mut active = Vec::new();
    let mut tokens_usd = 0.0;
    for h in &holdings {
        let mint = h["mint"].as_str().unwrap_or("");
        let amt = h["amount"].as_f64().unwrap_or(0.0);
        let px = prices.get(mint).copied().unwrap_or(0.0);
        let usd = amt * px;
        if usd >= 0.01 {
            tokens_usd += usd;
            active.push(json!({ "mint": mint, "amount": amt, "usd": usd }));
        }
    }
    active.sort_by(|a, b| b["usd"].as_f64().unwrap_or(0.0)
        .partial_cmp(&a["usd"].as_f64().unwrap_or(0.0)).unwrap());

    Ok(json!({
        "address": address,
        "sol": sol,
        "sol_usd": sol * sol_price,
        "tokens_usd": tokens_usd,
        "total_usd": sol * sol_price + tokens_usd,
        "active": active,
    }))
}

/// Drop a command into the brain controller's command channel.
/// Allowed actions only — this is a control surface, not a shell.
#[tauri::command]
pub fn brain_command(path: String, action: String, agent: Option<String>,
                     factor: Option<f64>) -> Result<String, String> {
    const ALLOWED: &[&str] = &["pause", "resume", "run", "boost", "block", "unblock"];
    if !ALLOWED.contains(&action.as_str()) {
        return Err(format!("Action '{action}' is not permitted from the shell"));
    }
    let mut cmd = json!({ "action": action });
    if let Some(a) = agent { cmd["agent"] = json!(a); }
    if let Some(f) = factor { cmd["factor"] = json!(f); }

    let dir = PathBuf::from(&path).join("brain_commands");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!(
        "shell_{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let file = dir.join(&name);
    fs::write(&file, cmd.to_string()).map_err(|e| e.to_string())?;
    Ok(name)
}

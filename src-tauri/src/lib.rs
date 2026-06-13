mod agent_engine;
mod keychain;
mod market;
mod oauth;
mod odysseus;
mod operator;
mod skills;
mod studio;
mod vault;

use tauri_plugin_sql::{Migration, MigrationKind};

/// Schema v1 — agent registry, per-action activity log (tokens + cost),
/// ingestion metrics (drives the brain visualization), P/L entries, and
/// non-secret app settings. Secrets live in the Keychain, never here.
fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "initial schema",
        kind: MigrationKind::Up,
        sql: r#"
            CREATE TABLE IF NOT EXISTS agents (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id     TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                zone          INTEGER NOT NULL DEFAULT 0,
                system_prompt TEXT NOT NULL DEFAULT '',
                tools         TEXT NOT NULL DEFAULT '[]',   -- JSON array of allowed tools
                schedule      TEXT,                          -- cron-ish or NULL = manual
                status        TEXT NOT NULL DEFAULT 'idle',  -- idle | working | error
                created_at    TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS activities (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                worker_id   TEXT NOT NULL,
                kind        TEXT NOT NULL,            -- task | note | email | post | trade | system
                description TEXT NOT NULL,
                status      TEXT NOT NULL,            -- ok | fail
                tokens_in   INTEGER NOT NULL DEFAULT 0,
                tokens_out  INTEGER NOT NULL DEFAULT 0,
                cost_usd    REAL    NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_activities_worker
                ON activities(worker_id, created_at);

            CREATE TABLE IF NOT EXISTS ingestion_metrics (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                metric TEXT NOT NULL,                 -- notes_indexed | tasks_done | messages
                value  REAL NOT NULL DEFAULT 1,
                ts     TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_metrics_name ON ingestion_metrics(metric, ts);

            CREATE TABLE IF NOT EXISTS pnl_entries (
                id     INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,                 -- wallet | manual | agent:<worker_id>
                amount_usd REAL NOT NULL,
                note   TEXT NOT NULL DEFAULT '',
                ts     TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        "#,
    },
    Migration {
        version: 2,
        description: "studio tasks (rebuilt from old NEXUS tasks module)",
        kind: MigrationKind::Up,
        sql: r#"
            CREATE TABLE IF NOT EXISTS studio_tasks (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                title     TEXT NOT NULL,
                status    TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | done | blocked
                priority  TEXT NOT NULL DEFAULT 'medium',   -- low | medium | high
                tags      TEXT NOT NULL DEFAULT '[]',
                created   TEXT NOT NULL DEFAULT (datetime('now')),
                updated   TEXT NOT NULL DEFAULT (datetime('now'))
            );
        "#,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:nexus.db", migrations())
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            keychain::secret_set,
            keychain::secret_get,
            keychain::secret_delete,
            keychain::secret_exists,
            vault::vault_scan,
            vault::vault_read,
            vault::vault_write,
            vault::vault_search,
            vault::vault_folders,
            vault::trading_state,
            agent_engine::run_agent,
            oauth::oauth_login,
            oauth::oauth_connected,
            oauth::oauth_disconnect,
            market::market_candles,
            market::market_price,
            market::trading_detail,
            market::brain_command,
            market::wallet_balances,
            operator::op_read,
            operator::op_write,
            operator::op_list,
            operator::op_shell,
            odysseus::odysseus_status,
            odysseus::odysseus_start,
            odysseus::odysseus_stop,
            odysseus::odysseus_open_external,
            odysseus::odysseus_embed,
            odysseus::odysseus_embed_hide,
            odysseus::odysseus_embed_reload,
            studio::portfolio_states,
            studio::ideas_list,
            studio::ideas_save,
            studio::ideas_archive,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus Shell");
}

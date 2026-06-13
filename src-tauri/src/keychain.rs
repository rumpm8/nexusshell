//! macOS Keychain access for ALL app secrets (Anthropic API key, OAuth
//! tokens, wallet session data). Secrets are never written to disk in
//! plaintext — only Keychain entries under the "nexus-shell" service.

use keyring::Entry;

const SERVICE: &str = "nexus-shell";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// Returns None (not an error) when the secret has never been stored.
#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Existence check that never returns the secret itself — used by the
/// Settings UI to show "configured" badges without round-tripping values.
#[tauri::command]
pub fn secret_exists(key: String) -> Result<bool, String> {
    Ok(secret_get(key)?.is_some())
}

//! Official OAuth 2.0 login for Instagram (via Meta/Facebook Login) and
//! TikTok (Login Kit v2), using the desktop loopback pattern:
//!
//!   1. open the platform's consent page in the SYSTEM browser
//!   2. catch the redirect on a localhost listener (fixed port, registered
//!      in the platform's developer console)
//!   3. exchange the code for tokens IN RUST and store them in the Keychain
//!
//! No usernames/passwords ever touch this app — the user signs in on the
//! platform's own page. Client credentials (from the user's own developer
//! app) live in the Keychain too.

use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const LOGIN_TIMEOUT_SECS: u64 = 240;
const IG_PORT: u16 = 38427;
const TT_PORT: u16 = 38428;
const GM_PORT: u16 = 38429;
const GH_PORT: u16 = 38430;

fn secret(key: &str) -> Result<String, String> {
    keyring::Entry::new("nexus-shell", key)
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|_| format!("'{key}' not configured — add it in Settings first"))
}

fn store(key: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new("nexus-shell", key)
        .map_err(|e| e.to_string())?
        .set_password(value)
        .map_err(|e| e.to_string())
}

fn rand_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Block on the loopback listener until the browser redirects back with
/// `code` (verifying `state`), then answer the browser with a close page.
fn wait_for_code(port: u16, expected_state: &str) -> Result<String, String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("Cannot listen on localhost:{port}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(LOGIN_TIMEOUT_SECS);

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                // Browsers open speculative pre-connections and fire favicon
                // requests at loopback listeners BEFORE the real redirect.
                // An empty read is one of those — ignore it and keep waiting.
                if n == 0 {
                    continue;
                }
                let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                // first line: GET /callback?code=...&state=... HTTP/1.1
                let query = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|path| path.split_once('?').map(|(_, q)| q.to_string()))
                    .unwrap_or_default();

                let mut code = None;
                let mut state = None;
                let mut error = None;
                for pair in query.split('&') {
                    let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                    let v = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default();
                    match k {
                        "code" => code = Some(v),
                        "state" => state = Some(v),
                        "error" | "error_description" if error.is_none() => error = Some(v),
                        _ => {}
                    }
                }

                // Not the OAuth callback (favicon.ico, probes, stray tabs):
                // answer politely and KEEP LISTENING for the real redirect.
                if code.is_none() && error.is_none() {
                    let _ = stream.write_all(
                        b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
                    if Instant::now() > deadline {
                        return Err("Login timed out — no response from the browser".into());
                    }
                    continue;
                }

                let ok = code.is_some() && state.as_deref() == Some(expected_state);
                let body = if ok {
                    "<html><body style='background:#040308;color:#45e8ff;\
                     font-family:monospace;display:flex;align-items:center;\
                     justify-content:center;height:100vh'>\
                     <h2>✓ Connected — you can close this tab and return to Nexus Shell</h2>\
                     </body></html>"
                } else {
                    "<html><body style='background:#040308;color:#ff4d8f;\
                     font-family:monospace;display:flex;align-items:center;\
                     justify-content:center;height:100vh'>\
                     <h2>✗ Login failed or was cancelled — return to Nexus Shell</h2>\
                     </body></html>"
                };
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    ).as_bytes(),
                );

                if let Some(err) = error {
                    return Err(format!("Authorization denied: {err}"));
                }
                if !ok {
                    // wrong/missing state on a request that DID carry a code —
                    // treat as hostile/stale and keep waiting for the real one
                    continue;
                }
                return Ok(code.unwrap());
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("Login timed out — no response from the browser".into());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/* ── Instagram via Meta (Facebook Login → Graph API) ─────────────────────── */

async fn instagram_login() -> Result<Value, String> {
    let client_id = secret("instagram_client_id")?;
    let client_secret = secret("instagram_client_secret")?;
    let redirect = format!("http://localhost:{IG_PORT}/callback");
    let state = rand_token(24);
    let scopes = "public_profile,pages_show_list,instagram_basic,\
                  instagram_content_publish,pages_read_engagement,business_management";

    let auth_url = format!(
        "https://www.facebook.com/v21.0/dialog/oauth?client_id={}&redirect_uri={}&state={}&response_type=code&scope={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(&state),
        urlencoding::encode(scopes),
    );
    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(IG_PORT, &state))
        .await
        .map_err(|e| e.to_string())??;

    let http = reqwest::Client::new();
    let tok: Value = http
        .get("https://graph.facebook.com/v21.0/oauth/access_token")
        .query(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("code", code.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let short = tok["access_token"].as_str()
        .ok_or_else(|| format!("Token exchange failed: {tok}"))?;

    // upgrade to a long-lived token (~60 days instead of ~1 hour)
    let long: Value = http
        .get("https://graph.facebook.com/v21.0/oauth/access_token")
        .query(&[
            ("grant_type", "fb_exchange_token"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("fb_exchange_token", short),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let access = long["access_token"].as_str().unwrap_or(short);

    let me: Value = http
        .get("https://graph.facebook.com/v21.0/me?fields=id,name")
        .bearer_auth(access)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    store("instagram_tokens", &json!({
        "access_token": access,
        "token_kind": "fb_long_lived",
        "user": me,
    }).to_string())?;

    Ok(json!({ "connected": true, "account": me["name"] }))
}

/* ── TikTok Login Kit v2 (with PKCE) ─────────────────────────────────────── */

async fn tiktok_login() -> Result<Value, String> {
    let client_key = secret("tiktok_client_key")?;
    let client_secret = secret("tiktok_client_secret")?;
    let redirect = format!("http://localhost:{TT_PORT}/callback");
    let state = rand_token(24);

    // PKCE S256
    let verifier = rand_token(48);
    let challenge = {
        let digest = Sha256::digest(verifier.as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    };

    let scopes = "user.info.basic,video.publish,video.upload";
    let auth_url = format!(
        "https://www.tiktok.com/v2/auth/authorize/?client_key={}&response_type=code&scope={}&redirect_uri={}&state={}&code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(&client_key),
        urlencoding::encode(scopes),
        urlencoding::encode(&redirect),
        urlencoding::encode(&state),
        urlencoding::encode(&challenge),
    );
    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(TT_PORT, &state))
        .await
        .map_err(|e| e.to_string())??;

    let http = reqwest::Client::new();
    let tok: Value = http
        .post("https://open.tiktokapis.com/v2/oauth/token/")
        .form(&[
            ("client_key", client_key.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let access = tok["access_token"].as_str()
        .ok_or_else(|| format!("Token exchange failed: {tok}"))?
        .to_string();

    let user: Value = http
        .get("https://open.tiktokapis.com/v2/user/info/?fields=display_name,open_id")
        .bearer_auth(&access)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    store("tiktok_tokens", &tok.to_string())?;

    Ok(json!({
        "connected": true,
        "account": user["data"]["user"]["display_name"],
    }))
}

/* ── Gmail via Google OAuth 2.0 (Desktop loopback + PKCE) ────────────────── */

async fn gmail_login() -> Result<Value, String> {
    let client_id = secret("google_client_id")?;
    let client_secret = secret("google_client_secret")?;
    let redirect = format!("http://127.0.0.1:{GM_PORT}/callback");
    let state = rand_token(24);

    let verifier = rand_token(48);
    let challenge = {
        let digest = Sha256::digest(verifier.as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    };

    let scopes = "https://www.googleapis.com/auth/gmail.readonly \
                  https://www.googleapis.com/auth/gmail.send";
    // access_type=offline + prompt=consent → Google issues a refresh token,
    // so the connection survives the 1-hour access-token expiry.
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&code_challenge={}&code_challenge_method=S256&access_type=offline&prompt=consent",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(scopes),
        urlencoding::encode(&state),
        urlencoding::encode(&challenge),
    );
    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(GM_PORT, &state))
        .await
        .map_err(|e| e.to_string())??;

    let http = reqwest::Client::new();
    let tok: Value = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
            ("code_verifier", verifier.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let access = tok["access_token"].as_str()
        .ok_or_else(|| format!("Token exchange failed: {tok}"))?;

    let profile: Value = http
        .get("https://gmail.googleapis.com/gmail/v1/users/me/profile")
        .bearer_auth(access)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let email = profile["emailAddress"].as_str().unwrap_or("connected");

    let mut stored = tok.clone();
    stored["email"] = json!(email);
    store("gmail_tokens", &stored.to_string())?;

    Ok(json!({ "connected": true, "account": email }))
}

/* ── GitHub OAuth (web flow with loopback redirect) ──────────────────────── */

async fn github_login() -> Result<Value, String> {
    let client_id = secret("github_client_id")?;
    let client_secret = secret("github_client_secret")?;
    let redirect = format!("http://127.0.0.1:{GH_PORT}/callback");
    let state = rand_token(24);

    let scopes = "repo read:user user:email";
    let auth_url = format!(
        "https://github.com/login/oauth/authorize?client_id={}&redirect_uri={}&scope={}&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(scopes),
        urlencoding::encode(&state),
    );
    open::that(&auth_url).map_err(|e| format!("Could not open browser: {e}"))?;

    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(GH_PORT, &state))
        .await
        .map_err(|e| e.to_string())??;

    let http = reqwest::Client::new();
    let tok: Value = http
        .post("https://github.com/login/oauth/access_token")
        .header("accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("code", code.as_str()),
            ("redirect_uri", redirect.as_str()),
        ])
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let access = tok["access_token"].as_str()
        .ok_or_else(|| format!("Token exchange failed: {tok}"))?;

    let user: Value = http
        .get("https://api.github.com/user")
        .header("user-agent", "nexus-shell")
        .bearer_auth(access)
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;
    let login = user["login"].as_str().unwrap_or("connected");

    let mut stored = tok.clone();
    stored["login"] = json!(login);
    store("github_tokens", &stored.to_string())?;

    Ok(json!({ "connected": true, "account": login }))
}

/* ── commands ────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn oauth_login(provider: String) -> Result<Value, String> {
    match provider.as_str() {
        "instagram" => instagram_login().await,
        "tiktok" => tiktok_login().await,
        "gmail" => gmail_login().await,
        "github" => github_login().await,
        _ => Err(format!("Unknown provider: {provider}")),
    }
}

#[tauri::command]
pub fn oauth_connected(provider: String) -> Result<bool, String> {
    let key = match provider.as_str() {
        "instagram" => "instagram_tokens",
        "tiktok" => "tiktok_tokens",
        "gmail" => "gmail_tokens",
        "github" => "github_tokens",
        _ => return Err(format!("Unknown provider: {provider}")),
    };
    Ok(secret(key).is_ok())
}

#[tauri::command]
pub fn oauth_disconnect(provider: String) -> Result<(), String> {
    let key = match provider.as_str() {
        "instagram" => "instagram_tokens",
        "tiktok" => "tiktok_tokens",
        "gmail" => "gmail_tokens",
        "github" => "github_tokens",
        _ => return Err(format!("Unknown provider: {provider}")),
    };
    match keyring::Entry::new("nexus-shell", key)
        .map_err(|e| e.to_string())?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

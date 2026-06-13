/**
 * Interactive OAuth rows for Instagram (Meta) and TikTok. Official login
 * only: the Connect button opens the platform's own consent page in the
 * system browser; the app never sees a password. Client credentials from
 * the user's developer app are stored in the Keychain (see SETUP.md).
 */
import { useEffect, useState } from "react";
import { setSecret, secretExists } from "../lib/keychain";
import { inTauri } from "../lib/live";

export interface ProviderSpec {
  id: "instagram" | "tiktok" | "gmail" | "github";
  name: string;
  detail: string;
  idKey: string;       // keychain key for the client id/key
  secretKey: string;   // keychain key for the client secret
  idLabel: string;
  setupAnchor: string; // section in SETUP.md
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "gmail", name: "Gmail",
    detail: "Google OAuth 2.0 (loopback) · read + send",
    idKey: "google_client_id", secretKey: "google_client_secret",
    idLabel: "Google Client ID", setupAnchor: "gmail-google",
  },
  {
    id: "instagram", name: "Instagram",
    detail: "Meta Graph API · official posting only",
    idKey: "instagram_client_id", secretKey: "instagram_client_secret",
    idLabel: "Meta App ID", setupAnchor: "instagram-meta",
  },
  {
    id: "tiktok", name: "TikTok",
    detail: "Content Posting API · official only",
    idKey: "tiktok_client_key", secretKey: "tiktok_client_secret",
    idLabel: "TikTok Client Key", setupAnchor: "tiktok",
  },
  {
    id: "github", name: "GitHub",
    detail: "OAuth app · repos + profile",
    idKey: "github_client_id", secretKey: "github_client_secret",
    idLabel: "GitHub Client ID", setupAnchor: "github",
  },
];

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export function SocialRow({ p }: { p: ProviderSpec }) {
  const [connected, setConnected] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [credsReady, setCredsReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function refresh() {
    if (!inTauri()) return;
    setConnected(await invoke<boolean>("oauth_connected", { provider: p.id }));
    const [hasId, hasSecret] = await Promise.all([
      secretExists(p.idKey), secretExists(p.secretKey),
    ]);
    setCredsReady(hasId && hasSecret);
  }
  useEffect(() => { void refresh(); }, []);

  async function saveCreds() {
    setBusy(true); setMsg("");
    try {
      if (clientId.trim()) await setSecret(p.idKey, clientId.trim());
      if (clientSecret.trim()) await setSecret(p.secretKey, clientSecret.trim());
      setClientId(""); setClientSecret("");
      await refresh();
      setMsg("Credentials stored in Keychain.");
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  async function connect() {
    if (!credsReady) {
      setExpanded(true);
      setMsg(`${p.name} needs its developer-app keys first — paste them here ` +
             `(SETUP.md § ${p.setupAnchor} is the 10-minute walkthrough).`);
      return;
    }
    setBusy(true);
    setMsg("Browser opened — finish the login there, then come back…");
    try {
      const res = await invoke<{ connected: boolean; account?: string }>(
        "oauth_login", { provider: p.id });
      setAccount(res.account ?? null);
      setMsg(res.account ? `Connected as ${res.account}` : "Connected.");
      await refresh();
      setExpanded(false);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await invoke("oauth_disconnect", { provider: p.id });
      setAccount(null); setMsg("Disconnected — tokens removed from Keychain.");
      await refresh();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  if (!inTauri()) {
    return (
      <div className="integration-row">
        <div>
          <span className="integration-name">{p.name}</span>
          <span className="muted"> — {p.detail}</span>
        </div>
        <span className="conn-chip unconfigured">desktop app only</span>
      </div>
    );
  }

  return (
    <div className="integration-block">
      <div className="integration-row">
        <div>
          <span className="integration-name">{p.name}</span>
          <span className="muted"> — {p.detail}</span>
        </div>
        <div className="row">
          <span className={`conn-chip ${connected ? "configured" : "unconfigured"}`}>
            {connected ? (account ? `✓ ${account}` : "connected") : "not connected"}
          </span>
          {connected ? (
            <button className="ghost" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          ) : (
            <>
              <button className="ghost" disabled={busy}
                      onClick={() => setExpanded((v) => !v)}>
                {credsReady ? "Keys ✓" : "Setup"}
              </button>
              <button disabled={busy} onClick={() => void connect()}
                      title={credsReady ? "Open the official login in your browser"
                                        : "Add your developer app keys first (Setup)"}>
                {busy ? "Waiting…" : "Connect"}
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && !connected && (
        <div className="integration-config">
          <p className="muted">
            Paste the credentials from your {p.name} developer app — see
            SETUP.md (§ {p.setupAnchor}) for the 10-minute walkthrough.
            Stored only in the macOS Keychain.
          </p>
          <div className="row">
            <input type="password" placeholder={p.idLabel}
                   value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="row">
            <input type="password" placeholder="Client Secret"
                   value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
          </div>
          <div className="row">
            <button disabled={busy || (!clientId.trim() && !clientSecret.trim())}
                    onClick={() => void saveCreds()}>
              Save keys
            </button>
          </div>
        </div>
      )}
      {msg && <p className="settings-msg">{msg}</p>}
    </div>
  );
}

export default function SocialConnect() {
  return (
    <>
      {PROVIDERS.map((p) => <SocialRow key={p.id} p={p} />)}
    </>
  );
}

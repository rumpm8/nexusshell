import { useEffect, useState } from "react";
import { useNexus } from "../state/store";
import { SECRET_KEYS, secretExists, setSecret, deleteSecret } from "../lib/keychain";
import SocialConnect from "./SocialConnect";
import ApiVault from "./ApiVault";

type ConnState = "unconfigured" | "configured" | "error";

interface IntegrationRow {
  id: string;
  name: string;
  detail: string;
  phase: number;
}

// Remaining placeholder rows (Gmail/Instagram/TikTok are live via SocialConnect).
const INTEGRATIONS: IntegrationRow[] = [
  { id: "obsidian", name: "Obsidian Vault", detail: "Filesystem indexing + agent read/write", phase: 2 },
  { id: "solana", name: "Phantom / Solana", detail: "Wallet adapter · balances + history → P/L", phase: 5 },
];

export default function SettingsPanel() {
  const open = useNexus((s) => s.settingsOpen);
  const setOpen = useNexus((s) => s.setSettingsOpen);

  const [tab, setTab] = useState<"general" | "vault">("general");
  const [apiKeyState, setApiKeyState] = useState<ConnState>("unconfigured");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [vaultPath, setVaultPath] = useState(
    () => localStorage.getItem("nexus.vaultPath") ?? "",
  );
  const [walletAddr, setWalletAddr] = useState(
    () => localStorage.getItem("nexus.walletAddress") ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!open) return;
    void secretExists(SECRET_KEYS.anthropicApiKey).then((exists) =>
      setApiKeyState(exists ? "configured" : "unconfigured"),
    );
  }, [open]);

  async function saveApiKey() {
    if (!apiKeyInput.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      await setSecret(SECRET_KEYS.anthropicApiKey, apiKeyInput.trim());
      setApiKeyState("configured");
      setApiKeyInput("");
      setMessage("API key stored in macOS Keychain.");
    } catch (e) {
      setApiKeyState("error");
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearApiKey() {
    setBusy(true);
    try {
      await deleteSecret(SECRET_KEYS.anthropicApiKey);
      setApiKeyState("unconfigured");
      setMessage("API key removed from Keychain.");
    } finally {
      setBusy(false);
    }
  }

  function saveVaultPath(path: string) {
    setVaultPath(path);
    localStorage.setItem("nexus.vaultPath", path); // path is not a secret
  }

  function saveWalletAddr(addr: string) {
    setWalletAddr(addr);
    // a public address is not a secret; the card reads it live
    localStorage.setItem("nexus.walletAddress", addr.trim());
  }

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={() => setOpen(false)}>
      <aside className="settings-panel panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="ghost" onClick={() => setOpen(false)}>✕</button>
        </div>

        <div className="settings-tabs">
          <button className={tab === "general" ? "tab active" : "tab ghost"}
                  onClick={() => setTab("general")}>
            General
          </button>
          <button className={tab === "vault" ? "tab active" : "tab ghost"}
                  onClick={() => setTab("vault")}>
            🔐 API Vault
          </button>
        </div>

        {tab === "vault" && (
          <section className="settings-section">
            <h3>API Vault</h3>
            <ApiVault />
          </section>
        )}

        {tab === "general" && (<>
        <section className="settings-section">
          <h3>
            Anthropic API key
            <span className={`conn-chip ${apiKeyState}`}>
              {apiKeyState === "configured" ? "configured" : apiKeyState}
            </span>
          </h3>
          <p className="muted">
            Stored only in the macOS Keychain — never written to disk.
          </p>
          <div className="row">
            <input
              type="password"
              placeholder="sk-ant-…"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <button disabled={busy || !apiKeyInput.trim()} onClick={() => void saveApiKey()}>
              Save
            </button>
            {apiKeyState === "configured" && (
              <button className="ghost" disabled={busy} onClick={() => void clearApiKey()}>
                Remove
              </button>
            )}
          </div>
          {message && <p className="settings-msg">{message}</p>}
        </section>

        <section className="settings-section">
          <h3>
            Obsidian vault path
            <span className="conn-chip configured">saved</span>
          </h3>
          <div className="row">
            <input
              value={vaultPath}
              onChange={(e) => saveVaultPath(e.target.value)}
              spellCheck={false}
            />
          </div>
          <p className="muted">Indexing + agent read/write lands in Phase 2.</p>
        </section>

        <section className="settings-section">
          <h3>
            👻 Phantom wallet
            <span className={`conn-chip ${walletAddr.trim() ? "configured" : "unconfigured"}`}>
              {walletAddr.trim() ? "tracking" : "not set"}
            </span>
          </h3>
          <p className="muted">
            Paste your Phantom <b>public address</b> for live balance + account
            overview. Read-only — the app never signs or moves funds, and never
            asks for your seed phrase.
          </p>
          <div className="row">
            <input
              placeholder="Solana public address (e.g. 3jSW…wHQht)"
              value={walletAddr}
              onChange={(e) => saveWalletAddr(e.target.value)}
              spellCheck={false}
            />
          </div>
          <p className="muted">In Phantom: tap your account name → the address copies to your clipboard.</p>
        </section>

        <section className="settings-section">
          <h3>Connected accounts</h3>
          <SocialConnect />
          <p className="muted">
            Official OAuth only — Connect opens the platform's own login in
            your browser; this app never sees your password. Tokens live in
            the macOS Keychain.
          </p>
        </section>

        <section className="settings-section">
          <h3>Integrations</h3>
          {INTEGRATIONS.map((row) => (
            <div className="integration-row" key={row.id}>
              <div>
                <span className="integration-name">{row.name}</span>
                <span className="muted"> — {row.detail}</span>
              </div>
              <div className="row">
                <span className="conn-chip unconfigured">not connected</span>
                <button className="ghost" disabled title={`Arrives in Phase ${row.phase}`}>
                  Test
                </button>
              </div>
            </div>
          ))}
          <p className="muted">
            Official APIs and OAuth only — no password logins, no cookie reuse,
            no browser automation. Each integration unlocks in its build phase.
          </p>
        </section>
        </>)}
      </aside>
    </div>
  );
}

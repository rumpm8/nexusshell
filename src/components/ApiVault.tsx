/**
 * API VAULT — a personal store for every API key on this machine.
 *
 * Values live ONLY in the macOS Keychain (service "nexus-shell", keys
 * prefixed `vault_`). What's kept outside the Keychain is just the index of
 * NAMES (localStorage) so the list can render without touching secrets.
 * Reveal fetches the value on demand and re-masks after 15 seconds.
 */
import { useEffect, useRef, useState } from "react";
import { setSecret, getSecret, deleteSecret } from "../lib/keychain";
import { inTauri } from "../lib/live";

interface VaultEntry {
  label: string;
  key: string;     // keychain key (vault_<slug>)
  created: string; // ISO date
}

const INDEX_KEY = "nexus.apivault.index";

function loadIndex(): VaultEntry[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveIndex(entries: VaultEntry[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
}
function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function VaultRow({ entry, onDelete }: { entry: VaultEntry; onDelete: () => void }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const hideTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
  }, []);

  async function reveal() {
    if (revealed !== null) { setRevealed(null); return; }
    setBusy(true);
    try {
      const v = await getSecret(entry.key);
      setRevealed(v ?? "(empty)");
      // auto re-mask
      hideTimer.current = window.setTimeout(() => setRevealed(null), 15_000);
    } finally { setBusy(false); }
  }

  async function copy() {
    setBusy(true);
    try {
      const v = await getSecret(entry.key);
      if (v) {
        await navigator.clipboard.writeText(v);
        setNote("copied");
        window.setTimeout(() => setNote(""), 1500);
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="vault-row">
      <div className="vault-id">
        <span className="vault-label">{entry.label}</span>
        <span className="vault-meta">
          {entry.key} · added {new Date(entry.created).toLocaleDateString()}
        </span>
      </div>
      <span className="vault-value">{revealed ?? "••••••••••••••••"}</span>
      <div className="row">
        <button className="ghost" disabled={busy} onClick={() => void reveal()}>
          {revealed !== null ? "Hide" : "Reveal"}
        </button>
        <button className="ghost" disabled={busy} onClick={() => void copy()}>
          {note || "Copy"}
        </button>
        <button className="ghost danger" disabled={busy} onClick={onDelete}>
          ✕
        </button>
      </div>
    </div>
  );
}

export default function ApiVault() {
  const [entries, setEntries] = useState<VaultEntry[]>(loadIndex);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (!inTauri()) {
    return <p className="muted">The API Vault needs the desktop app (Keychain access).</p>;
  }

  async function add() {
    const name = label.trim();
    if (!name || !value.trim()) return;
    const slug = slugify(name);
    if (!slug) { setMsg("Give it a usable name."); return; }
    const key = `vault_${slug}`;
    if (entries.some((e) => e.key === key)) {
      setMsg("An entry with that name exists — delete it first or pick another name.");
      return;
    }
    setBusy(true); setMsg("");
    try {
      await setSecret(key, value.trim());
      const next = [...entries, { label: name, key, created: new Date().toISOString() }];
      setEntries(next); saveIndex(next);
      setLabel(""); setValue("");
      setMsg("Stored in Keychain.");
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  async function remove(key: string) {
    if (confirmDelete !== key) { setConfirmDelete(key); return; }
    setBusy(true);
    try {
      await deleteSecret(key);
      const next = entries.filter((e) => e.key !== key);
      setEntries(next); saveIndex(next);
      setMsg("Deleted from Keychain.");
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); setConfirmDelete(null); }
  }

  return (
    <div className="api-vault">
      <p className="muted">
        Store every API key in one place. Values live only in the macOS
        Keychain — this list keeps just the names. Agents can be granted
        specific keys by name in a later phase.
      </p>

      <div className="vault-add">
        <input placeholder="Name (e.g. CoinGecko, Helius RPC)"
               value={label} onChange={(e) => setLabel(e.target.value)} />
        <input type="password" placeholder="Key / secret value"
               value={value} onChange={(e) => setValue(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button disabled={busy || !label.trim() || !value.trim()}
                onClick={() => void add()}>
          Add to vault
        </button>
      </div>
      {msg && <p className="settings-msg">{msg}</p>}

      <div className="vault-list">
        {entries.length === 0 ? (
          <p className="muted">Vault is empty — add your first key above.</p>
        ) : (
          entries.map((e) => (
            <div key={e.key}>
              <VaultRow entry={e} onDelete={() => void remove(e.key)} />
              {confirmDelete === e.key && (
                <p className="settings-msg danger-text">
                  Click ✕ again to permanently delete "{e.label}" from the Keychain.
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Frontend wrappers for the Rust Keychain commands. All secrets (Anthropic
 * API key, OAuth tokens, wallet sessions) go through these — nothing secret
 * is ever kept in SQLite, localStorage, or files.
 */

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const SECRET_KEYS = {
  anthropicApiKey: "anthropic_api_key",
} as const;

export async function setSecret(key: string, value: string): Promise<void> {
  if (!inTauri()) throw new Error("Keychain requires the desktop app");
  await invoke("secret_set", { key, value });
}

/** Fetch a secret's value (API Vault reveal/copy). Use sparingly. */
export async function getSecret(key: string): Promise<string | null> {
  if (!inTauri()) return null;
  return invoke<string | null>("secret_get", { key });
}

export async function secretExists(key: string): Promise<boolean> {
  if (!inTauri()) return false;
  return invoke<boolean>("secret_exists", { key });
}

export async function deleteSecret(key: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("secret_delete", { key });
}

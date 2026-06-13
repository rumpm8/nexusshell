/**
 * CONNECTIONS — one place to link every external account with direct
 * third-party logins (official OAuth in your own browser; passwords never
 * touch the shell, tokens live in the macOS Keychain). Built to grow:
 * adding a future platform is one entry in the provider registry.
 */
import { PROVIDERS, SocialRow } from "./SocialConnect";
import { inTauri } from "../lib/live";

const ICONS: Record<string, string> = {
  gmail: "✉️", instagram: "📸", tiktok: "🎵", github: "🐙",
};

export default function ConnectionsView() {
  return (
    <main className="conn-wrap">
      <section className="panel conn-panel">
        <header className="conn-head">
          <h3>⛓ CONNECTIONS</h3>
          <p className="muted">
            Direct third-party logins — each Connect opens the platform's own
            sign-in page in your browser. Nexus Shell never sees a password;
            access tokens are stored only in the macOS Keychain. One-time per
            platform: paste your developer-app keys via Setup
            (walkthroughs in SETUP.md, ~10 min each).
          </p>
        </header>

        {!inTauri() ? (
          <p className="muted">Connections need the desktop app (Keychain + loopback OAuth).</p>
        ) : (
          <div className="conn-grid">
            {PROVIDERS.map((p) => (
              <div key={p.id} className="panel conn-card">
                <div className="conn-card-head">
                  <span className="conn-icon">{ICONS[p.id] ?? "🔌"}</span>
                  <span className="conn-name">{p.name}</span>
                </div>
                <SocialRow p={p} />
              </div>
            ))}
            <div className="panel conn-card conn-card-future">
              <div className="conn-card-head">
                <span className="conn-icon">＋</span>
                <span className="conn-name">More coming</span>
              </div>
              <p className="muted">
                X/Twitter, YouTube, Discord, LinkedIn… adding a platform is a
                single registry entry — tell Nexus which one you want next.
              </p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

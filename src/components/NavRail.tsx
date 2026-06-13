import { useNexus, type View } from "../state/store";

const AREAS: { id: View; glyph: string; label: string; sub: string }[] = [
  { id: "command", glyph: "◉", label: "COMMAND", sub: "core overview" },
  { id: "trading", glyph: "◫", label: "TRADING", sub: "live floor" },
  { id: "agents",    glyph: "⬡", label: "AGENTS",    sub: "ops + control" },
  { id: "workspace", glyph: "❖", label: "WORKSPACE", sub: "brain ecosystem" },
  { id: "studio",      glyph: "✦", label: "STUDIO",      sub: "plan + create" },
  { id: "odysseus",    glyph: "⊹", label: "ODYSSEUS",    sub: "ai workspace" },
  { id: "connections", glyph: "⛓", label: "CONNECT",     sub: "accounts" },
  { id: "nexus",       glyph: "◈", label: "NEXUS",       sub: "ask + command" },
];

export default function NavRail() {
  const view = useNexus((s) => s.view);
  const setView = useNexus((s) => s.setView);
  const workers = useNexus((s) => s.workers);
  const active = workers.filter((w) => w.status === "working").length;

  return (
    <nav className="nav-rail">
      {AREAS.map((a) => (
        <button key={a.id}
                className={`rail-btn ${view === a.id ? "active" : ""}`}
                onClick={() => setView(a.id)}>
          <span className="rail-glyph">{a.glyph}</span>
          <span className="rail-label">{a.label}</span>
          <span className="rail-sub">{a.sub}</span>
          {a.id === "agents" && active > 0 && (
            <span className="rail-badge">{active}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

import { useEffect, useState } from "react";
import StatsHub from "./components/StatsHub";
import BrainCore from "./components/BrainCore";
import HomeWidgets from "./components/HomeWidgets";
import SettingsPanel from "./components/SettingsPanel";
import TradingFloor from "./components/TradingFloor";
import AgentOps from "./components/AgentOps";
import WorkspaceView from "./components/WorkspaceView";
import StudioView from "./components/StudioView";
import OdysseusView from "./components/OdysseusView";
import ConnectionsView from "./components/ConnectionsView";
import ChatNexus from "./components/ChatNexus";
import NavRail from "./components/NavRail";
import { useNexus } from "./state/store";
import { startMockTicker } from "./lib/mock";
import { startLive } from "./lib/live";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const date = now.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
  return (
    <span className="top-clock">
      {date} {now.toLocaleTimeString()}
    </span>
  );
}

export default function App() {
  const setSettingsOpen = useNexus((s) => s.setSettingsOpen);
  const feed = useNexus((s) => s.feed);
  const dataSource = useNexus((s) => s.dataSource);
  const view = useNexus((s) => s.view);

  // Inside Tauri: real vault + trading data. In a plain browser: mock ticker.
  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let cancelled = false;
    void startLive().then((live) => {
      if (cancelled) { live?.(); return; }
      cleanup = live ?? startMockTicker();
    });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">NEXUS SHELL</span>
        <span className="brand-sub">AGENT AI CORE v0.2</span>
        <span className={`live-pill ${dataSource === "mock" ? "mock" : ""}`}>
          {dataSource === "mock" ? "SIM" : "LIVE"}
        </span>
        <Clock />
        <div className="traffic"><span className="r" /><span className="y" /><span className="g" /></div>
        <button className="ghost" onClick={() => setSettingsOpen(true)}>
          ⚙ Settings
        </button>
      </div>

      <div className="body-row">
        <NavRail />
        <div className="view-col">
          {view === "command" && (
            <>
              <StatsHub />
              <div className="home-row">
                <div className="home-core">
                  <BrainCore />
                </div>
                <div className="home-side">
                  <HomeWidgets />
                  <ChatNexus embedded />
                </div>
              </div>
              <footer className="activity-feed panel">
                <span className="feed-title">ACTIVITY</span>
                <ul>
                  {feed.slice(0, 5).map((e) => (
                    <li key={e.id} className={e.status}>
                      <span className="feed-worker">{e.workerId}</span>
                      <span className="feed-desc">{e.description}</span>
                      <span className="feed-ts">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                  {feed.length === 0 && <li className="muted">Waiting for activity…</li>}
                </ul>
              </footer>
            </>
          )}
          {view === "trading" && <TradingFloor />}
          {view === "agents" && <AgentOps />}
          {view === "workspace" && <WorkspaceView />}
          {view === "studio" && <StudioView />}
          {view === "odysseus" && <OdysseusView />}
          {view === "connections" && <ConnectionsView />}
          {view === "nexus" && <ChatNexus />}
        </div>
      </div>

      <SettingsPanel />
    </div>
  );
}

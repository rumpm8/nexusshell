/**
 * WORKSPACE — the living ecosystem of the brain, rebuilt from the old
 * NEXUS OS module and upgraded: every agent in the brain controller is a
 * hub orbiting the core, sized by its live dispatch-priority score, coloured
 * by freshness, firing data-pulses into the core when it has run recently.
 * Click a hub to inspect it (last run, priority reasoning, boost, blocked)
 * and command it directly. The phase ring + think-cycle countdown show the
 * controller's heartbeat in real time.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import * as THREE from "three";
import { fetchTradingDetail, sendBrainCommand } from "../lib/trading";
import { inTauri } from "../lib/live";
import { glowTexture } from "../lib/textures";

/* mirror of the brain controller's staleness thresholds (seconds) */
const STALENESS: Record<string, number> = {
  market: 1800, sentinel: 900, research: 3600, dex: 300, meme: 7200,
  polymarket: 3600, performance: 86400, trade: 1800, roster: 3600,
  scalperx_watchdog: 300, night_watch: 300,
};

interface BrainState {
  status?: string; pid?: number;
  cycle_phase?: string; phase_start?: string; phase_label?: string;
  last_think?: string; think_interval?: number;
  agent_boosts?: Record<string, number>;
  blocked_agents?: string[];
  last_run?: Record<string, string>;
  priorities?: Record<string, { score: number; reason: string }>;
  current_agent?: string | null;
}

function ageSecs(iso?: string): number {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 1000;
}
function agoText(iso?: string): string {
  const s = ageSecs(iso);
  if (!isFinite(s)) return "never";
  if (s < 90) return `${Math.floor(s)}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  return `${(s / 3600).toFixed(1)}h ago`;
}

interface Hub {
  id: string;
  anchor: [number, number, number];
  score: number;
  fresh: boolean;     // ran within its staleness window
  blocked: boolean;
  boost: number;
  lastRun?: string;
  reason?: string;
}

function hubColor(h: Hub): string {
  if (h.blocked) return "#ff4d8f";
  if (h.fresh) return "#45e8ff";
  if (h.score > 60) return "#ffd166";   // overdue + urgent
  return "#7e6ad1";
}

/* ── 3D scene ─────────────────────────────────────────────────────────── */

function EcosystemScene({ hubs, selected, onSelect, onLabels }: {
  hubs: Hub[];
  selected: string | null;
  onSelect: (id: string) => void;
  onLabels: (p: { x: number; y: number; visible: boolean }[]) => void;
}) {
  const glow = useMemo(glowTexture, []);
  const groupRef = useRef<THREE.Group>(null);
  const pulseGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(hubs.length * 3), 3));
    const cols = new Float32Array(hubs.length * 3);
    hubs.forEach((h, i) => {
      const c = new THREE.Color(hubColor(h));
      cols[i*3] = c.r; cols[i*3+1] = c.g; cols[i*3+2] = c.b;
    });
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return g;
  }, [hubs]);

  const { camera, size } = useThree();
  const last = useRef("");

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(t * 0.1) * 0.05;
    }
    // data pulses: fresh hubs stream charges into the core
    const pos = pulseGeom.attributes.position as THREE.BufferAttribute;
    hubs.forEach((h, i) => {
      if (!h.fresh || h.blocked) { pos.setXYZ(i, 0, -99, 0); return; }
      const f = 1 - ((t * 0.35 + i * 0.13) % 1);   // hub → core
      pos.setXYZ(i, h.anchor[0] * f, h.anchor[1] * f, h.anchor[2] * f);
    });
    pos.needsUpdate = true;

    // project labels
    const v = new THREE.Vector3();
    const out = hubs.map((h) => {
      v.set(...h.anchor);
      if (groupRef.current) v.applyMatrix4(groupRef.current.matrixWorld);
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
        visible: v.z < 1,
      };
    });
    const key = out.map((p) => `${p.x | 0},${p.y | 0}`).join(";");
    if (key !== last.current) { last.current = key; onLabels(out); }
  });

  return (
    <>
      <group ref={groupRef}>
        {/* the core */}
        <sprite scale={[2.4, 2.4, 1]}>
          <spriteMaterial map={glow} color="#b18aff" transparent opacity={0.75}
                          depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
        <sprite scale={[4.6, 4.6, 1]}>
          <spriteMaterial map={glow} color="#45e8ff" transparent opacity={0.14}
                          depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>

        {/* agent hubs */}
        {hubs.map((h) => (
          <group key={h.id} position={h.anchor}>
            <mesh onClick={(e) => { e.stopPropagation(); onSelect(h.id); }}>
              <icosahedronGeometry args={[0.09 + Math.min(h.score, 100) / 900, 0]} />
              <meshBasicMaterial color={hubColor(h)} toneMapped={false}
                                 wireframe={selected !== h.id} />
            </mesh>
            <sprite scale={[0.7, 0.7, 1]}>
              <spriteMaterial map={glow} color={hubColor(h)} transparent
                              opacity={h.fresh ? 0.7 : 0.3}
                              depthWrite={false} blending={THREE.AdditiveBlending} />
            </sprite>
          </group>
        ))}

        {/* connection threads hub → core */}
        {hubs.map((h) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(
            new Float32Array([0, 0, 0, ...h.anchor]), 3));
          return (
            <lineSegments key={`l-${h.id}`} geometry={g}>
              <lineBasicMaterial color={hubColor(h)} transparent
                                 opacity={h.fresh ? 0.22 : 0.07}
                                 depthWrite={false} blending={THREE.AdditiveBlending} />
            </lineSegments>
          );
        })}

        {/* travelling data pulses */}
        <points geometry={pulseGeom}>
          <pointsMaterial map={glow} vertexColors size={0.18} transparent
                          opacity={0.9} sizeAttenuation depthWrite={false}
                          blending={THREE.AdditiveBlending} />
        </points>
      </group>

      <EffectComposer multisampling={0}>
        <Bloom intensity={0.9} luminanceThreshold={0.3} luminanceSmoothing={0.7} mipmapBlur />
      </EffectComposer>
    </>
  );
}

/* ── view ─────────────────────────────────────────────────────────────── */

export default function WorkspaceView() {
  const [brain, setBrain] = useState<BrainState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [labels, setLabels] = useState<{ x: number; y: number; visible: boolean }[]>([]);
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState("");
  const pendingLabels = useRef<typeof labels | null>(null);

  useEffect(() => {
    let on = true;
    const tick = async () => {
      const d = await fetchTradingDetail();
      if (on && d?.brain) setBrain(d.brain as BrainState);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5000);
    const clockId = window.setInterval(() => setNow(Date.now()), 1000);
    const labelId = window.setInterval(() => {
      if (pendingLabels.current) { setLabels(pendingLabels.current); pendingLabels.current = null; }
    }, 120);
    return () => {
      on = false;
      window.clearInterval(id); window.clearInterval(clockId); window.clearInterval(labelId);
    };
  }, []);

  const hubs = useMemo<Hub[]>(() => {
    if (!brain) return [];
    const ids = Array.from(new Set([
      ...Object.keys(brain.last_run ?? {}),
      ...Object.keys(brain.priorities ?? {}),
    ])).filter((a) => a in STALENESS).sort();
    return ids.map((id, i) => {
      const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      const r = 2.1 + (i % 2) * 0.45;
      const lastRun = brain.last_run?.[id];
      return {
        id,
        anchor: [Math.cos(angle) * r, Math.sin(angle) * r * 0.72, Math.sin(angle * 2) * 0.3],
        score: brain.priorities?.[id]?.score ?? 0,
        reason: brain.priorities?.[id]?.reason,
        fresh: ageSecs(lastRun) < (STALENESS[id] ?? 3600),
        blocked: (brain.blocked_agents ?? []).includes(id),
        boost: brain.agent_boosts?.[id] ?? 1,
        lastRun,
      };
    });
  }, [brain]);

  const sel = hubs.find((h) => h.id === selected) ?? null;

  // phase progress + think countdown
  const phase = brain?.cycle_phase ?? "—";
  const phaseLen = (phase === "report" ? 2 : 22) * 3600;
  const phaseElapsed = brain?.phase_start
    ? (now - new Date(brain.phase_start).getTime()) / 1000 : 0;
  const phasePct = Math.min(100, Math.max(0, phaseElapsed / phaseLen * 100));
  const thinkIn = brain?.last_think
    ? Math.max(0, (brain.think_interval ?? 120) - (now - new Date(brain.last_think).getTime()) / 1000)
    : null;

  async function control(action: "run" | "boost" | "block" | "unblock", agent: string) {
    try {
      await sendBrainCommand(action, agent, action === "boost" ? 3 : undefined);
      setMsg(`${action} ${agent} → brain`);
    } catch (e) { setMsg(String(e)); }
    window.setTimeout(() => setMsg(""), 4000);
  }

  // Kick every waiting (blue/purple) + overdue (yellow) agent so they stop
  // idling. Blocked agents are skipped; fresh ones don't need it.
  async function wakeIdle() {
    const idle = hubs.filter((h) => !h.fresh && !h.blocked);
    if (!idle.length) { setMsg("All agents are already fresh — nothing to wake."); }
    let n = 0;
    for (const h of idle) {
      try { await sendBrainCommand("run", h.id); n++; } catch { /* keep going */ }
    }
    if (idle.length) setMsg(`⚡ Woke ${n} idle agent${n === 1 ? "" : "s"} → dispatching now`);
    window.setTimeout(() => setMsg(""), 5000);
  }

  if (!inTauri()) {
    return (
      <main className="wsv-wrap">
        <div className="panel floor-empty">WORKSPACE needs the desktop app (brain access).</div>
      </main>
    );
  }

  return (
    <main className="wsv-wrap">
      <section className="panel wsv-canvas-panel">
        <div className="wsv-head">
          <div className="wsv-phase">
            <span className="wsv-phase-name">{String(phase).toUpperCase()} SHIFT</span>
            <div className="wsv-phase-bar"><div style={{ width: `${phasePct}%` }} /></div>
            <span className="wsv-phase-sub">
              {brain?.status ?? "?"} · pid {brain?.pid ?? "—"}
              {thinkIn !== null && ` · next think in ${Math.ceil(thinkIn)}s`}
              {brain?.current_agent ? ` · dispatching ${brain.current_agent}` : ""}
            </span>
          </div>
          <div className="wsv-head-right">
            <button className="wake-btn" onClick={() => void wakeIdle()}
                    title="Run every waiting (blue) and overdue (yellow) agent now">
              ⚡ Wake idle agents
            </button>
            <span className="floor-pool">{hubs.filter((h) => h.fresh).length}/{hubs.length} fresh</span>
          </div>
        </div>

        <div className="wsv-canvas">
          <Canvas camera={{ position: [0, 0, 5.6], fov: 45 }} dpr={[1, 2]}>
            <color attach="background" args={["#040308"]} />
            <EcosystemScene hubs={hubs} selected={selected}
                            onSelect={setSelected}
                            onLabels={(p) => { pendingLabels.current = p; }} />
          </Canvas>
          {labels.map((p, i) =>
            p.visible && hubs[i] ? (
              <button key={hubs[i].id} className="wsv-label"
                      style={{ left: p.x, top: p.y, borderColor: hubColor(hubs[i]) }}
                      onClick={() => setSelected(hubs[i].id)}>
                <span style={{ color: hubColor(hubs[i]) }}>{hubs[i].id}</span>
                <small>{agoText(hubs[i].lastRun)}</small>
              </button>
            ) : null,
          )}
        </div>
        <div className="floor-legend">
          <span className="lg" style={{ color: "#45e8ff" }}>● fresh</span>
          <span className="lg" style={{ color: "#7e6ad1" }}>● waiting</span>
          <span className="lg" style={{ color: "#ffd166" }}>● overdue</span>
          <span className="lg" style={{ color: "#ff4d8f" }}>● blocked</span>
          <span className="lg muted">size = dispatch priority · pulses = data flowing to the core</span>
        </div>
      </section>

      <aside className="floor-side">
        <section className="panel floor-card">
          <h4>{sel ? sel.id.toUpperCase() : "SELECT A HUB"}</h4>
          {sel ? (
            <>
              <div className="kv"><span>last run</span><b>{agoText(sel.lastRun)}</b></div>
              <div className="kv"><span>priority</span><b>{sel.score.toFixed(1)}</b></div>
              <div className="kv"><span>boost</span><b>×{sel.boost}</b></div>
              <div className="kv"><span>status</span>
                <b className={sel.blocked ? "neg" : sel.fresh ? "pos" : ""}>
                  {sel.blocked ? "BLOCKED" : sel.fresh ? "FRESH" : "WAITING"}</b></div>
              {sel.reason && <p className="muted">“{sel.reason}”</p>}
              <div className="ctrl-grid" style={{ marginTop: 8 }}>
                <button className="ghost" onClick={() => void control("run", sel.id)}>▶ Run now</button>
                <button className="ghost" onClick={() => void control("boost", sel.id)}>Boost ×3</button>
                <button className="ghost" onClick={() => void control("block", sel.id)}>Block</button>
                <button className="ghost" onClick={() => void control("unblock", sel.id)}>Unblock</button>
              </div>
            </>
          ) : (
            <p className="muted">Click any hub in the ecosystem to inspect and command it.</p>
          )}
          {msg && <p className="settings-msg">{msg}</p>}
        </section>

        <section className="panel floor-card floor-tape">
          <h4>DISPATCH PRIORITIES</h4>
          <ul>
            {[...hubs].sort((a, b) => b.score - a.score).map((h) => (
              <li key={h.id} className={h.fresh ? "pos" : ""}>
                <span className="tape-sym">{h.id}</span>
                <span className="tape-pnl" style={{ color: hubColor(h) }}>{h.score.toFixed(0)}</span>
                <span className="tape-reason">{h.blocked ? "blocked" : h.reason ?? ""}</span>
                <span className="tape-time">{agoText(h.lastRun)}</span>
              </li>
            ))}
            {hubs.length === 0 && <li className="muted">Waiting for brain state…</li>}
          </ul>
        </section>
      </aside>
    </main>
  );
}

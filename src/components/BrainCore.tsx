/**
 * NEXUS CORE — cinematic reactor rendering (game-engine grade).
 *
 * Rendering stack:
 *   - HDR bloom + chromatic aberration + film grain + vignette post pipeline
 *     (the same passes AAA engines use for their "expensive" look)
 *   - Plasma nucleus: custom fresnel shader, emissive over 1.0 so the bloom
 *     pass ignites it like a light source
 *   - Machined gyroscope rings: PBR metal with environment reflections and
 *     emissive light-strips, counter-rotating
 *   - Brain-region particle clusters, comet streaks, nebula glows, starfield
 *   - Region label chips projected from 3D anchors, fed by real agent data
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  EffectComposer, Bloom, ChromaticAberration, Noise, Vignette,
} from "@react-three/postprocessing";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { useNexus } from "../state/store";
import { glowTexture } from "../lib/textures";

interface Region {
  name: string;
  color: string;
  anchor: [number, number, number];
  drive: "scalperx" | "night_watch" | "librarian" | "tasks" | "notes" | "messages";
  /** the REAL Obsidian brain folder this region represents */
  folder: string;
}

const REGIONS: Region[] = [
  { name: "PREFRONTAL",     color: "#3df2b6", anchor: [ 1.55,  1.05, -0.3], drive: "tasks",       folder: "Trading Strategies" },
  { name: "MOTOR CORTEX",   color: "#ff4d5e", anchor: [-1.7,   0.85,  0.2], drive: "scalperx",    folder: "Trades" },
  { name: "CONCEPT LAYER",  color: "#ff9f2e", anchor: [ 0.75,  0.45,  0.9], drive: "librarian",   folder: "Research" },
  { name: "ASSOCIATION",    color: "#ffe34d", anchor: [-0.6,   0.2,  -1.1], drive: "messages",    folder: "Trading Data" },
  { name: "SENSORY CORTEX", color: "#39d6ff", anchor: [-1.95, -0.35, -0.4], drive: "messages",    folder: "Market Analysis" },
  { name: "FEATURE LAYER",  color: "#a06bff", anchor: [-0.9,  -1.0,   0.7], drive: "notes",       folder: "Risk Management" },
  { name: "PREDICTIVE",     color: "#ff3fd2", anchor: [ 1.85, -0.55,  0.3], drive: "night_watch", folder: "Trending Coins" },
  { name: "HIPPOCAMPUS",    color: "#4d7bff", anchor: [ 0.6,  -1.35, -0.6], drive: "notes",       folder: "Daily Notes" },
  { name: "LANGUAGE",       color: "#7dffce", anchor: [-0.1,   1.55,  0.5], drive: "librarian",   folder: "Portfolio" },
];

export interface FolderStat { name: string; files: number; recent: number }

const PTS_PER_REGION = 64;

function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RegionBuild {
  pts: Float32Array;
  ptCols: Float32Array;
  edges: Float32Array;
  edgeCols: Float32Array;
}

/** Cluster geometry in LOCAL coordinates (anchor at origin) so each region
 *  can wave/breathe independently as a group. */
function buildRegionLocal(reg: Region, ri: number): RegionBuild {
  const rand = mulberry(ri * 1337 + 7);
  const c = new THREE.Color(reg.color);
  const pts: number[] = [];
  const ptCols: number[] = [];
  const edges: number[] = [];
  const edgeCols: number[] = [];
  const local: number[][] = [];
  for (let i = 0; i < PTS_PER_REGION; i++) {
    const g = () => (rand() + rand() + rand()) / 1.5 - 1;
    const spread = 0.62;
    const p = [
      reg.anchor[0] * rand() * 0.45 + g() * spread,
      reg.anchor[1] * rand() * 0.45 + g() * spread,
      reg.anchor[2] * rand() * 0.45 + g() * spread,
    ];
    local.push(p);
    pts.push(p[0], p[1], p[2]);
    const dim = 0.55 + rand() * 0.45;
    ptCols.push(c.r * dim, c.g * dim, c.b * dim);
  }
  for (let i = 0; i < local.length; i++) {
    const dists = local
      .map((q, j) => ({ j, d: (q[0]-local[i][0])**2 + (q[1]-local[i][1])**2 + (q[2]-local[i][2])**2 }))
      .filter((x) => x.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    for (const { j } of dists) {
      edges.push(...local[i], ...local[j]);
      edgeCols.push(c.r, c.g, c.b, c.r * 0.4, c.g * 0.4, c.b * 0.4);
    }
  }
  return {
    pts: new Float32Array(pts),
    ptCols: new Float32Array(ptCols),
    edges: new Float32Array(edges),
    edgeCols: new Float32Array(edgeCols),
  };
}

interface StreakMeta { dir: [number, number, number]; inner: number; reach: number; color: THREE.Color }

function buildStreaks() {
  const pos: number[] = [];
  const col: number[] = [];
  const meta: StreakMeta[] = [];
  const white = new THREE.Color("#eaf6ff");
  REGIONS.forEach((reg, ri) => {
    const rand = mulberry(ri * 991 + 3);
    const c = new THREE.Color(reg.color);
    for (let s = 0; s < 6; s++) {
      const jit = () => (rand() - 0.5) * 0.9;
      const dir = [reg.anchor[0] + jit(), reg.anchor[1] + jit(), reg.anchor[2] + jit()];
      const len = Math.hypot(...dir) || 1;
      const reach = 2.6 + rand() * 1.6;
      const inner = 0.12 + rand() * 0.25;
      const mid = 1.15 + rand() * 0.5;
      const n: [number, number, number] = [dir[0]/len, dir[1]/len, dir[2]/len];
      meta.push({ dir: n, inner, reach, color: c });
      pos.push(
        n[0]*inner, n[1]*inner, n[2]*inner,
        n[0]*mid,   n[1]*mid,   n[2]*mid,
        n[0]*mid,   n[1]*mid,   n[2]*mid,
        n[0]*reach, n[1]*reach, n[2]*reach,
      );
      col.push(
        white.r, white.g, white.b,  c.r, c.g, c.b,
        c.r, c.g, c.b,              c.r*0.05, c.g*0.05, c.b*0.05,
      );
    }
  });
  return { pos: new Float32Array(pos), col: new Float32Array(col), meta };
}

/** One waving region cluster — gentle rotation/scale/bob, never stiff. */
function RegionCluster({ build, anchor, index, glow }: {
  build: RegionBuild; anchor: [number, number, number]; index: number;
  glow: THREE.Texture;
}) {
  const ref = useRef<THREE.Group>(null);
  const ptsGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(build.pts, 3));
    g.setAttribute("color", new THREE.BufferAttribute(build.ptCols, 3));
    return g;
  }, [build]);
  const edgeGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(build.edges, 3));
    g.setAttribute("color", new THREE.BufferAttribute(build.edgeCols, 3));
    return g;
  }, [build]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const ph = index * 1.7;
    const g = ref.current;
    if (!g) return;
    g.position.set(
      anchor[0],
      anchor[1] + Math.sin(t * 0.6 + ph) * 0.05,
      anchor[2] + Math.cos(t * 0.45 + ph) * 0.035,
    );
    g.rotation.z = Math.sin(t * 0.35 + ph) * 0.09;
    g.rotation.x = Math.cos(t * 0.28 + ph) * 0.07;
    const s = 1 + Math.sin(t * 0.8 + ph) * 0.04;
    g.scale.setScalar(s);
  });

  return (
    <group ref={ref} position={anchor}>
      <points geometry={ptsGeom}>
        <pointsMaterial map={glow} vertexColors size={0.16} transparent
                        opacity={0.9} sizeAttenuation depthWrite={false}
                        blending={THREE.AdditiveBlending} />
      </points>
      <lineSegments geometry={edgeGeom}>
        <lineBasicMaterial vertexColors transparent opacity={0.26}
                           depthWrite={false} blending={THREE.AdditiveBlending} />
      </lineSegments>
    </group>
  );
}

/** Electricity: bright charge particles racing from the core outward along
 *  every streak, tinted to that region's colour path. */
function ElectricPulses({ meta, glow }: { meta: StreakMeta[]; glow: THREE.Texture }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meta.length * 3), 3));
    const cols = new Float32Array(meta.length * 3);
    meta.forEach((m, i) => {
      cols[i*3] = m.color.r; cols[i*3+1] = m.color.g; cols[i*3+2] = m.color.b;
    });
    g.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    return g;
  }, [meta]);

  const params = useMemo(() => {
    const rand = mulberry(99);
    return meta.map(() => ({ speed: 0.10 + rand() * 0.22, offset: rand() }));
  }, [meta]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pos = geom.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i];
      const f = (t * params[i].speed + params[i].offset) % 1;
      // ease so charges accelerate out of the core then fade into distance
      const d = m.inner + (m.reach - m.inner) * (f * f);
      pos.setXYZ(i, m.dir[0] * d, m.dir[1] * d, m.dir[2] * d);
    }
    pos.needsUpdate = true;
  });

  return (
    <points geometry={geom}>
      <pointsMaterial map={glow} vertexColors size={0.14} transparent
                      opacity={0.85} sizeAttenuation depthWrite={false}
                      blending={THREE.AdditiveBlending} />
    </points>
  );
}

function buildStars(count = 260) {
  const rand = mulberry(42);
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 5 + rand() * 6;
    const th = rand() * Math.PI * 2;
    const ph = Math.acos(2 * rand() - 1);
    pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
    pos[i*3+1] = r * Math.cos(ph) * 0.7;
    pos[i*3+2] = r * Math.sin(ph) * Math.sin(th) - 2;
  }
  return pos;
}

/* ── procedural brain geometry: two wrinkled hemispheres with a sagittal
      fissure — no external 3D assets needed ─────────────────────────────── */
function buildBrainGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(0.5, 128, 96);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    // ellipsoid proportions (wider front-back, slightly squashed)
    v.x *= 1.0; v.y *= 0.88; v.z *= 1.3;
    // sagittal fissure: pinch the surface toward the midline
    const pinch = Math.exp(-((v.x / 0.09) ** 2)) * 0.13;
    // hemispheres bulge outward
    v.x += Math.sign(v.x) * 0.06;
    // gyri/sulci wrinkles — layered trig noise displaced along the normal
    const w =
      0.045 * Math.sin(v.y * 21 + v.x * 13) * Math.sin(v.z * 17 - v.x * 11) +
      0.028 * Math.sin(v.z * 29 + v.y * 23) +
      0.018 * Math.sin(v.x * 35 - v.z * 19);
    const d = w - pinch;
    v.addScaledVector(n, d);
    // flatten the underside a touch (temporal lobes)
    if (v.y < -0.18) v.y += (v.y + 0.18) * -0.25;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/* ── hologram shader: translucent fill, strong fresnel rim, rising
      scan-bands, projector flicker. No blinding core — light lives on
      the edges and the wrinkles, where bloom picks it up gently. ───────── */
const HOLO_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  void main() {
    vNormal = normalMatrix * normal;
    vPos = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const HOLO_FRAG = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vPos;
  uniform float uTime;
  uniform float uActivity;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.2);
    // hologram scan-bands sweeping upward
    float scan = smoothstep(0.35, 1.0, 0.5 + 0.5 * sin(vPos.y * 90.0 - uTime * 4.0));
    // a slower, brighter sweep that passes every few seconds
    float sweep = exp(-pow((vPos.y - (fract(uTime * 0.14) * 1.4 - 0.7)) * 9.0, 2.0));
    // projector flicker
    float flick = 0.92 + 0.08 * sin(uTime * 31.0) * sin(uTime * 13.7);
    // neon purple <-> aqua hologram
    vec3 holo = mix(vec3(0.27, 0.91, 1.0), vec3(0.69, 0.54, 1.0), 0.45 + 0.35 * sin(uTime * 0.4));
    float body  = 0.05 + scan * 0.05;                  // faint translucent fill
    float edge  = fres * (0.85 + uActivity * 0.5);     // the hologram lives on the rim
    float burst = sweep * 0.5;
    vec3 col = holo * (body + edge * 1.7 + burst) * flick;
    float alpha = clamp(body + edge + burst, 0.0, 0.9);
    gl_FragColor = vec4(col, alpha);
  }
`;

function Reactor({ activity }: { activity: number }) {
  const holoRef = useRef<THREE.ShaderMaterial>(null);
  const brainRef = useRef<THREE.Group>(null);
  const ring1 = useRef<THREE.Group>(null);
  const ring2 = useRef<THREE.Group>(null);
  const ring3 = useRef<THREE.Group>(null);

  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uActivity: { value: 0 } }), []);
  const brainGeo = useMemo(buildBrainGeometry, []);
  const glow = useMemo(glowTexture, []);

  useFrame(({ clock }, delta) => {
    const t = clock.getElapsedTime();
    if (holoRef.current) {
      holoRef.current.uniforms.uTime.value = t;
      holoRef.current.uniforms.uActivity.value = activity;
    }
    if (brainRef.current) {
      brainRef.current.rotation.y = t * 0.35;          // slow holographic turn
      brainRef.current.position.y = Math.sin(t * 0.9) * 0.03;  // gentle hover
    }
    const speed = 0.25 + activity * 0.6;
    if (ring1.current) { ring1.current.rotation.x += delta * speed; ring1.current.rotation.y += delta * speed * 0.4; }
    if (ring2.current) { ring2.current.rotation.y -= delta * speed * 0.8; ring2.current.rotation.z += delta * speed * 0.3; }
    if (ring3.current) { ring3.current.rotation.z -= delta * speed * 0.5; ring3.current.rotation.x -= delta * speed * 0.25; }
  });

  const metal = (
    <meshStandardMaterial color="#202a24" metalness={1} roughness={0.28}
                          envMapIntensity={1.4} />
  );

  return (
    <group>
      {/* ── holographic brain ─────────────────────────────────────────── */}
      <group ref={brainRef}>
        {/* translucent holo shell: fresnel rim + scan-bands */}
        <mesh geometry={brainGeo}>
          <shaderMaterial ref={holoRef} vertexShader={HOLO_VERT}
                          fragmentShader={HOLO_FRAG} uniforms={uniforms}
                          transparent depthWrite={false} side={THREE.DoubleSide}
                          blending={THREE.AdditiveBlending} />
        </mesh>
        {/* wireframe circuitry over the surface */}
        <mesh geometry={brainGeo} scale={1.002}>
          <meshBasicMaterial color="#2fe9ff" wireframe transparent opacity={0.07}
                             depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
        {/* vertex glow dots — data points crawling the cortex */}
        <points geometry={brainGeo}>
          <pointsMaterial map={glow} color="#b9a4ff" size={0.02} transparent
                          opacity={0.5} sizeAttenuation depthWrite={false}
                          blending={THREE.AdditiveBlending} />
        </points>
      </group>
      {/* soft cool light so the metalwork still reads — no blinding core */}
      <pointLight intensity={7} distance={8} decay={2} color="#4fd9c8" />

      {/* machined gyroscope rings with emissive light-strips */}
      <group ref={ring1} rotation={[0.6, 0.2, 0]}>
        <mesh>{/* body */}<torusGeometry args={[0.86, 0.028, 32, 160]} />{metal}</mesh>
        <mesh scale={[1.0, 1.0, 1.0]}>
          <torusGeometry args={[0.86, 0.007, 16, 160]} />
          <meshBasicMaterial color={[0.3, 2.2, 0.7] as unknown as THREE.Color} toneMapped={false} />
        </mesh>
      </group>
      <group ref={ring2} rotation={[1.4, 0, 0.4]}>
        <mesh><torusGeometry args={[0.98, 0.024, 32, 160]} />{metal}</mesh>
        <mesh>
          <torusGeometry args={[0.98, 0.006, 16, 160]} />
          <meshBasicMaterial color={[0.25, 1.6, 2.4] as unknown as THREE.Color} toneMapped={false} />
        </mesh>
      </group>
      <group ref={ring3} rotation={[0.2, 1.1, 0.9]}>
        <mesh><torusGeometry args={[1.18, 0.02, 32, 160]} />{metal}</mesh>
        <mesh>
          <torusGeometry args={[1.18, 0.005, 16, 160]} />
          <meshBasicMaterial color={[2.2, 1.4, 0.35] as unknown as THREE.Color} toneMapped={false} />
        </mesh>
      </group>
    </group>
  );
}

/* ── agent satellites: one orbiter per worker, colored by live status,
      firing a data-beam into the brain while working ─────────────────────── */
const STATUS_COLOR: Record<string, string> = {
  working: "#45e8ff", idle: "#4a3f6e", error: "#ff4d8f",
};

function AgentSatellites() {
  const workers = useNexus((s) => s.workers);
  const glow = useMemo(glowTexture, []);
  const group = useRef<THREE.Group>(null);
  const beamGeoms = useRef<THREE.BufferGeometry[]>([]);

  const orbits = useMemo(() =>
    workers.map((_, i) => ({
      radius: 1.5 + (i % 3) * 0.16,
      tilt: (i / workers.length) * Math.PI,
      phase: (i / workers.length) * Math.PI * 2,
      speed: 0.25 + (i % 3) * 0.08,
    })), [workers.length]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const g = group.current;
    if (!g) return;
    g.children.forEach((child, i) => {
      const o = orbits[i];
      if (!o) return;
      const a = o.phase + t * o.speed;
      const x = Math.cos(a) * o.radius;
      const z = Math.sin(a) * o.radius;
      const y = Math.sin(a + o.tilt) * 0.5;
      child.position.set(
        x * Math.cos(o.tilt) - y * Math.sin(o.tilt) * 0.4,
        y * Math.cos(o.tilt) * 0.9,
        z,
      );
      // stretch the beam from origin to the satellite
      const geom = beamGeoms.current[i];
      if (geom) {
        const pos = geom.attributes.position as THREE.BufferAttribute;
        pos.setXYZ(0, 0, 0, 0);
        pos.setXYZ(1, child.position.x, child.position.y, child.position.z);
        pos.needsUpdate = true;
      }
    });
  });

  return (
    <>
      {/* moving satellites */}
      <group ref={group}>
        {workers.map((w) => (
          <group key={w.workerId}>
            <mesh>
              <icosahedronGeometry args={[0.045, 0]} />
              <meshBasicMaterial color={STATUS_COLOR[w.status] ?? "#2b5e3a"}
                                 toneMapped={false} />
            </mesh>
            <sprite scale={[0.28, 0.28, 1]}>
              <spriteMaterial map={glow} color={STATUS_COLOR[w.status] ?? "#2b5e3a"}
                              transparent opacity={w.status === "working" ? 0.8 : 0.3}
                              depthWrite={false} blending={THREE.AdditiveBlending} />
            </sprite>
          </group>
        ))}
      </group>
      {/* data-beams anchored at the brain, endpoints driven in useFrame */}
      <group>
        {workers.map((w, i) => (
          <BeamLine key={w.workerId} index={i} registry={beamGeoms}
                    visible={w.status === "working"}
                    color={STATUS_COLOR[w.status] ?? "#45e8ff"} />
        ))}
      </group>
    </>
  );
}

function BeamLine({ index, registry, visible, color }: {
  index: number;
  registry: React.MutableRefObject<THREE.BufferGeometry[]>;
  visible: boolean;
  color: string;
}) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
    return g;
  }, []);
  useEffect(() => {
    registry.current[index] = geom;
    return () => { delete registry.current[index]; };
  }, [geom, index, registry]);
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color={color} transparent opacity={visible ? 0.5 : 0}
                         depthWrite={false} blending={THREE.AdditiveBlending} />
    </lineSegments>
  );
}

/** PBR environment reflections without any asset downloads. */
function StudioEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
    scene.environment = env;
    return () => { scene.environment = null; env.dispose(); pmrem.dispose(); };
  }, [gl, scene]);
  return null;
}

interface LabelPos { x: number; y: number; visible: boolean }

function Scene({ onLabels }: { onLabels: (p: LabelPos[]) => void }) {
  const workers = useNexus((s) => s.workers);
  const activity = Math.min(
    workers.filter((w) => w.status === "working").length / 3, 1);

  const regionBuilds = useMemo(
    () => REGIONS.map((r, i) => buildRegionLocal(r, i)), []);
  const streaks = useMemo(buildStreaks, []);
  const stars = useMemo(() => buildStars(), []);
  const glow = useMemo(glowTexture, []);

  const streakGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(streaks.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(streaks.col, 3));
    return g;
  }, [streaks]);
  const starGeom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(stars, 3));
    return g;
  }, [stars]);

  const groupRef = useRef<THREE.Group>(null);
  const streakMat = useRef<THREE.LineBasicMaterial>(null);
  const { camera, size } = useThree();
  const last = useRef<string>("");

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (groupRef.current) {
      groupRef.current.rotation.y = Math.sin(t * 0.16) * 0.07;
      groupRef.current.rotation.x = Math.sin(t * 0.11) * 0.04;
    }
    if (streakMat.current) {
      streakMat.current.opacity = 0.45 + activity * 0.35 + 0.1 * Math.sin(t * 3.4);
    }
    const v = new THREE.Vector3();
    const out: LabelPos[] = REGIONS.map((r) => {
      v.set(...r.anchor);
      if (groupRef.current) v.applyMatrix4(groupRef.current.matrixWorld);
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.width,
        y: (-v.y * 0.5 + 0.5) * size.height,
        visible: v.z < 1,
      };
    });
    const key = out.map((p) => `${p.x | 0},${p.y | 0}`).join(";");
    if (key !== last.current) {
      last.current = key;
      onLabels(out);
    }
  });

  return (
    <>
      <StudioEnvironment />
      <ambientLight intensity={0.12} />
      <directionalLight position={[4, 6, 3]} intensity={0.5} color="#bfe8ff" />

      <group ref={groupRef}>
        <Reactor activity={activity} />
        <AgentSatellites />

        <points geometry={starGeom}>
          <pointsMaterial map={glow} color="#9fb8c8" size={0.08} transparent
                          opacity={0.5} sizeAttenuation depthWrite={false}
                          blending={THREE.AdditiveBlending} />
        </points>
        {REGIONS.map((r, i) => (
          <RegionCluster key={r.name} build={regionBuilds[i]} anchor={r.anchor}
                         index={i} glow={glow} />
        ))}
        <ElectricPulses meta={streaks.meta} glow={glow} />
        <lineSegments geometry={streakGeom}>
          <lineBasicMaterial ref={streakMat} vertexColors transparent opacity={0.55}
                             depthWrite={false} blending={THREE.AdditiveBlending} />
        </lineSegments>
        {REGIONS.map((r) => (
          <sprite key={r.name} position={r.anchor} scale={[1.7, 1.7, 1]}>
            <spriteMaterial map={glow} color={r.color} transparent opacity={0.13}
                            depthWrite={false} blending={THREE.AdditiveBlending} />
          </sprite>
        ))}
      </group>

      {/* the cinematic pipeline — bloom ignites everything emissive */}
      <EffectComposer multisampling={0}>
        <Bloom intensity={1.15} luminanceThreshold={0.22}
               luminanceSmoothing={0.65} mipmapBlur />
        <ChromaticAberration offset={new THREE.Vector2(0.0009, 0.0005)}
                             radialModulation={false} modulationOffset={0} />
        <Noise opacity={0.045} />
        <Vignette eskil={false} offset={0.22} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

export default function BrainCore() {
  const metrics = useNexus((s) => s.metrics);
  const workers = useNexus((s) => s.workers);
  const [labels, setLabels] = useState<LabelPos[]>([]);
  const [folders, setFolders] = useState<Record<string, FolderStat>>({});

  const active = workers.filter((w) => w.status === "working").length;
  const ingestion =
    metrics.notesIndexed + metrics.tasksCompleted + metrics.messagesProcessed;

  const pending = useRef<LabelPos[] | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (pending.current) { setLabels(pending.current); pending.current = null; }
    }, 120);
    return () => window.clearInterval(id);
  }, []);

  // real Obsidian folder counts behind every region label
  useEffect(() => {
    if (!(typeof window !== "undefined" && "__TAURI_INTERNALS__" in window)) return;
    let on = true;
    const tick = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const path = localStorage.getItem("nexus.vaultPath") ?? "";
        const stats = await invoke<FolderStat[]>("vault_folders", { path });
        if (on) setFolders(Object.fromEntries(stats.map((s) => [s.name, s])));
      } catch { /* vault offline — labels fall back to synthetic */ }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 60_000);
    return () => { on = false; window.clearInterval(id); };
  }, []);

  function firingFor(drive: Region["drive"]): number {
    const w = workers.find((x) => x.workerId === drive);
    if (w) return w.status === "working" ? 2.4 : 0.8;
    return active > 0 ? 1.2 : 0.8;
  }
  function neuronsFor(i: number): number {
    return 120 + ((i * 37) % 90) + Math.min(Math.floor(ingestion / 4), 400);
  }
  function metaFor(i: number): string {
    const r = REGIONS[i];
    const stat = folders[r.folder];
    if (stat) {
      const firing = stat.recent > 0
        ? Math.min(0.4 + stat.recent * 0.35, 6).toFixed(1)
        : firingFor(r.drive).toFixed(1);
      return `${r.folder}/ · ${stat.files} notes · firing ${firing}%`;
    }
    return `${neuronsFor(i)} neurons · firing ${firingFor(r.drive).toFixed(1)}%`;
  }

  return (
    <div className="brain-core panel">
      <Canvas
        camera={{ position: [0, 0, 6.2], fov: 45 }}
        dpr={[1, 2]}
        gl={{
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.1,
        }}
      >
        <color attach="background" args={["#020503"]} />
        <Scene onLabels={(p) => { pending.current = p; }} />
      </Canvas>

      <span className="brain-chip">← ALL MODULES</span>
      <span className="brain-live">● LIVE {String(active).padStart(2, "0")} / {String(workers.length).padStart(2, "0")}</span>

      {labels.map((p, i) =>
        p.visible ? (
          <div
            key={REGIONS[i].name}
            className="region-label"
            style={{ left: p.x, top: p.y, borderColor: REGIONS[i].color }}
          >
            <span className="region-name" style={{ color: REGIONS[i].color }}>
              {REGIONS[i].name}
            </span>
            <span className="region-meta">{metaFor(i)}</span>
          </div>
        ) : null,
      )}

      <div className="brain-caption">
        <span className="brain-title">NEXUS CORE</span>
        <span className="brain-sub">
          {ingestion.toLocaleString()} ingested · {active} agent
          {active === 1 ? "" : "s"} active
        </span>
      </div>
    </div>
  );
}

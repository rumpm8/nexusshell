/**
 * Canvas-generated radial glow sprite — turns square WebGL points into soft
 * bloomed orbs and powers the nucleus/nebula sprites. Generated once, reused
 * by every material (tinted via material color).
 */
import * as THREE from "three";

let cached: THREE.Texture | null = null;

export function glowTexture(): THREE.Texture {
  if (cached) return cached;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.85)");
  g.addColorStop(0.42, "rgba(255,255,255,0.28)");
  g.addColorStop(0.72, "rgba(255,255,255,0.07)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  cached = new THREE.CanvasTexture(c);
  cached.colorSpace = THREE.SRGBColorSpace;
  return cached;
}

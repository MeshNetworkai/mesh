import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * The three.js scene behind the homepage hero. Loaded lazily by components/Hero3D.tsx (never import this
 * file directly from the main bundle). Rounded boxes with a matte base, a clearcoat and a soft sheen, lit by
 * a shadow-casting key, a cool rim and an accent-coloured counter-rim, over a faint reflective ground far
 * below; one or two boxes glow faintly in `--accent`. Slow tumble and drift, a camera that breathes.
 *
 *  - Colours come from `--bg`, `--fg`, `--accent` on <html>, read on mount and again whenever `data-theme`
 *    changes or the OS scheme flips; light mode re-tints to pale grey boxes with soft shadows on white.
 *  - Pixel ratio capped at 1.5 (1 on phones); 8 boxes on desktop, 4 on phones.
 *  - Renders only while the hero is on screen (IntersectionObserver) and the tab is visible.
 *  - `prefers-reduced-motion: reduce`, a software GL renderer (`still` prop) or a machine that cannot hold
 *    ~12 fps renders one static frame (and one more on theme change / resize).
 *  - `step` (recording aid, see Hero3D.tsx): no clock of its own; `window.__meshHero3dStep(t)` draws time t.
 *  - Resize via ResizeObserver on the wrapper; FOV is derived from the aspect so the edge boxes stay in frame.
 *  - Unmount disposes geometries, materials, the environment texture and the renderer, and cancels the RAF.
 *  - No WebGL context → renders nothing (the renderer constructor throws; we catch and leave the canvas blank).
 */

interface BoxDef {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  r: number;
  speed: number;
  accent: boolean;
}

const def = (x: number, y: number, z: number, w: number, h: number, d: number, r: number, speed: number, accent = false): BoxDef => ({ x, y, z, w, h, d, r, speed, accent });

/** Desktop: eight monoliths around the edges, the middle left for the headline. */
const DESKTOP: BoxDef[] = [
  def(-11.6, 3.4, -3.0, 3.2, 3.2, 3.2, 0.32, 0.11),
  def(-9.8, -3.8, -1.5, 2.0, 4.6, 2.0, 0.28, 0.08),
  def(-8.6, 5.4, -7, 1.8, 1.8, 1.8, 0.22, 0.14, true),
  def(9.2, 3.1, -3, 2.8, 2.8, 2.8, 0.3, 0.09),
  def(9.6, -3.6, -2.0, 1.9, 4.4, 1.9, 0.26, 0.07),
  def(8.8, 6.0, -9, 1.6, 1.6, 1.6, 0.2, 0.13),
  def(11.8, -0.6, -7, 2.4, 2.4, 2.4, 0.28, 0.1, true),
  def(-11.5, -0.2, -9, 2.6, 2.6, 2.6, 0.3, 0.06),
];
/**
 * Phones: seven smaller monoliths in a loose ring down the tall portrait hero — a pair above the eyebrow, a
 * pair either side of the headline, a pair beside the lede and one far below — all fully in frame (nothing
 * cropped at the corners), the centre column kept clear by the vignette.
 */
const PHONE: BoxDef[] = [
  def(-4.8, 3.4, -4, 1.5, 1.5, 1.5, 0.2, 0.11),
  def(4.8, 4.2, -5, 1.2, 1.2, 1.2, 0.18, 0.13, true),
  def(-6.0, 0.2, -3, 1.2, 2.6, 1.2, 0.18, 0.08),
  def(5.8, -0.8, -4, 1.6, 1.6, 1.6, 0.22, 0.09),
  def(-6.6, -7.0, -4, 1.4, 1.4, 1.4, 0.2, 0.1, true),
  def(6.6, -7.6, -3, 1.3, 2.8, 1.3, 0.2, 0.07),
  def(-1.2, -12.5, -8, 1.6, 1.6, 1.6, 0.22, 0.12),
];

/** Horizontal half-extent (world units at the z=0 plane) the camera must show. */
const HALF_WIDTH = { desktop: 13.6, phone: 6.6 };
const CAMERA_Z = 22;
/**
 * Where the camera looks. The canvas hangs from the top of the hero and the headline sits in its upper third,
 * so the camera aims below the world origin to lift the scene's clear middle up behind the headline.
 */
const LOOK_AT_Y = { desktop: 0.6, phone: -4.4 };

interface Palette {
  light: boolean;
  bg: THREE.Color;
  fg: THREE.Color;
  accent: THREE.Color;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => {
    const c = new THREE.Color();
    const v = cs.getPropertyValue(name).trim();
    try {
      if (v) c.setStyle(v);
      else c.setStyle(fallback);
    } catch {
      c.setStyle(fallback);
    }
    return c;
  };
  const bg = read('--bg', '#070b12');
  // sRGB relative luminance of the page background decides light vs dark, not the attribute (system theme).
  const lum = 0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b;
  return { light: lum > 0.5, bg, fg: read('--fg', '#f3f5f7'), accent: read('--accent', '#4fd394') };
}

/** A sustained frame interval above this (≈12 fps) after warm-up means a weak or software GPU: fall back to a still. */
const SLOW_FRAME_MS = 80;
/** Frames ignored (shader compile, first uploads) before frame times count, and frames measured after that. */
const WARMUP_FRAMES = 2;
const MEASURE_FRAMES = 6;

declare global {
  interface Window {
    __meshHero3dStep?: (t: number) => void;
  }
}

interface Props {
  /** Render a single static frame (software GL): no animation loop. */
  still?: boolean;
  /** Recording aid: no clock; expose `window.__meshHero3dStep(t)`. */
  step?: boolean;
}

export default function Hero3DScene({ still: forceStill = false, step = false }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const host = canvas.parentElement ?? canvas;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    } catch {
      return; // no WebGL: leave the canvas blank
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const phone = window.matchMedia('(max-width: 760px)');
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, phone.matches || forceStill ? 1 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 2.2, CAMERA_Z);

    // ---- environment for the clearcoat reflections: a procedural gradient room, rebuilt per theme
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envMat = (color: number) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const envTop = new THREE.Mesh(new THREE.PlaneGeometry(40, 10), envMat(0x8fa4bf));
    envTop.position.set(0, 10, 0);
    envTop.rotation.x = Math.PI / 2;
    const envSide = new THREE.Mesh(new THREE.PlaneGeometry(6, 30), envMat(0x4fd394));
    envSide.position.set(12, 0, -6);
    envSide.rotation.y = -Math.PI / 2;
    const envSide2 = new THREE.Mesh(new THREE.PlaneGeometry(10, 24), envMat(0x6f7f99));
    envSide2.position.set(-12, 2, 2);
    envSide2.rotation.y = Math.PI / 2;
    envScene.add(envTop, envSide, envSide2);
    let envTex: THREE.Texture | null = null;

    // ---- lights
    const hemi = new THREE.HemisphereLight(0x8094ad, 0x05080d, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(-8, 14, 8);
    key.castShadow = true;
    const shadowPx = phone.matches || forceStill ? 1024 : 2048;
    key.shadow.mapSize.set(shadowPx, shadowPx);
    key.shadow.radius = 8;
    key.shadow.bias = -0.0004;
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -18;
    sc.right = sc.top = 18;
    sc.far = 60;
    const rim = new THREE.DirectionalLight(0x9fd8ff, 2.4);
    rim.position.set(9, 3, -14);
    const rim2 = new THREE.DirectionalLight(0x4fd394, 1.2);
    rim2.position.set(-10, -2, -8);
    scene.add(hemi, key, rim, rim2);

    // ---- materials
    const matBase = new THREE.MeshPhysicalMaterial({
      color: 0x0e141d,
      roughness: 0.42,
      metalness: 0.15,
      clearcoat: 0.6,
      clearcoatRoughness: 0.25,
      reflectivity: 0.5,
      sheen: 0.15,
      sheenColor: new THREE.Color(0x9fb3c8),
    });
    const matAccent = matBase.clone();
    const groundMat = new THREE.MeshPhysicalMaterial({ color: 0x080d15, roughness: 0.55, metalness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.35 });
    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.5 });

    // ---- monoliths
    const defs = phone.matches ? PHONE : DESKTOP;
    const geometries: THREE.BufferGeometry[] = [];
    const boxes = defs.map((d, i) => {
      const geo = new RoundedBoxGeometry(d.w, d.h, d.d, 6, d.r);
      geometries.push(geo);
      const m = new THREE.Mesh(geo, d.accent ? matAccent : matBase);
      m.position.set(d.x, d.y, d.z);
      m.castShadow = m.receiveShadow = true;
      m.userData = {
        base: new THREE.Vector3(d.x, d.y, d.z),
        speed: d.speed,
        phase: i * 1.7,
        axis: new THREE.Vector3(Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7)).normalize(),
      };
      scene.add(m);
      return m;
    });

    // ---- ground: a faint reflective plane far below, plus a shadow-only plane just above it
    const groundGeo = new THREE.PlaneGeometry(120, 120);
    geometries.push(groundGeo);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -7.8;
    ground.receiveShadow = true;
    const groundShadow = new THREE.Mesh(groundGeo, shadowMat);
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.y = -7.79;
    groundShadow.receiveShadow = true;
    scene.add(ground, groundShadow);

    // ---- theme → colours
    const tint = () => {
      const p = readPalette();
      const L = p.light;
      scene.background = p.bg.clone();
      scene.fog = new THREE.Fog(p.bg.clone(), 16, 44);
      renderer.toneMappingExposure = L ? 1.0 : 1.2;

      envScene.background = new THREE.Color(L ? 0xe8ecf1 : 0x0b1119);
      (envTop.material as THREE.MeshBasicMaterial).color.set(L ? 0xffffff : 0x8fa4bf);
      (envSide.material as THREE.MeshBasicMaterial).color.copy(L ? p.accent.clone().lerp(new THREE.Color(0xffffff), 0.55) : p.accent);
      (envSide2.material as THREE.MeshBasicMaterial).color.set(L ? 0xffffff : 0x6f7f99);
      envTex?.dispose();
      envTex = pmrem.fromScene(envScene, 0.04).texture;
      scene.environment = envTex;
      scene.environmentIntensity = L ? 0.9 : 0.7;

      hemi.color.set(L ? 0xffffff : 0x8094ad);
      hemi.groundColor.set(L ? 0xcfd6df : 0x05080d);
      hemi.intensity = L ? 0.9 : 0.5;
      key.intensity = L ? 1.5 : 1.8;
      rim.color.set(L ? 0xb9c6d6 : 0x9fd8ff);
      rim.intensity = L ? 0.7 : 2.4;
      rim2.color.copy(p.accent);
      rim2.intensity = L ? 0.45 : 1.2;

      // Light mode: pale grey / white boxes with soft shadows on white. Dark: near-black matte.
      matBase.color.set(L ? 0xe9edf2 : 0x0e141d);
      matBase.roughness = L ? 0.55 : 0.42;
      matBase.metalness = L ? 0.04 : 0.15;
      matBase.sheenColor.set(L ? 0xffffff : 0x9fb3c8);
      matBase.needsUpdate = true;
      matAccent.color.copy(L ? p.accent.clone().lerp(new THREE.Color(0xffffff), 0.45) : new THREE.Color(0x0f2a22));
      matAccent.roughness = matBase.roughness;
      matAccent.metalness = matBase.metalness;
      matAccent.sheenColor.copy(matBase.sheenColor);
      matAccent.emissive.copy(p.accent);
      matAccent.emissiveIntensity = L ? 0.3 : 0.22;
      matAccent.needsUpdate = true;

      groundMat.color.copy(p.bg.clone().lerp(p.fg, L ? 0.05 : 0.025));
      groundMat.metalness = L ? 0.1 : 0.35;
      shadowMat.opacity = L ? 0.16 : 0.5;
    };

    // ---- state
    const clock = new THREE.Clock();
    let raf = 0;
    let visible = true;
    let hidden = document.hidden;
    let w = 0;
    let h = 0;
    /** Set once frames prove too slow to animate: the last drawn frame stays as the still. */
    let slow = forceStill;
    let frames = 0;
    let measured = 0;
    let lastFrameAt = 0;
    const qq = new THREE.Quaternion();

    const frame = (t: number) => {
      for (const b of boxes) {
        const u = b.userData as { base: THREE.Vector3; speed: number; phase: number; axis: THREE.Vector3 };
        qq.setFromAxisAngle(u.axis, t * u.speed + u.phase);
        b.quaternion.copy(qq);
        b.position.set(
          u.base.x + Math.sin(t * 0.21 + u.phase) * 0.35,
          u.base.y + Math.sin(t * 0.17 + u.phase * 1.3) * 0.5,
          u.base.z + Math.cos(t * 0.15 + u.phase) * 0.3,
        );
      }
      camera.position.x = Math.sin(t * 0.12) * 1.1;
      camera.position.y = 2.2 + Math.cos(t * 0.1) * 0.5;
      camera.lookAt(0, phone.matches ? LOOK_AT_Y.phone : LOOK_AT_Y.desktop, 0);
      renderer.render(scene, camera);
    };

    /** The frame drawn when not animating: a fixed, pleasant pose for stills, else wherever the clock is. */
    const still = () => frame(reduced.matches || slow ? 3.0 : clock.getElapsedTime());

    const running = () => !step && !slow && visible && !hidden && !reduced.matches;
    const loop = (now: number) => {
      raf = 0;
      if (!running()) return;
      // Weak-GPU safety net: average the interval of a few frames after warm-up; too slow → stop at a still.
      if (lastFrameAt && ++frames > WARMUP_FRAMES) {
        measured += now - lastFrameAt;
        if (frames - WARMUP_FRAMES >= MEASURE_FRAMES) {
          if (measured / MEASURE_FRAMES > SLOW_FRAME_MS) {
            slow = true;
            still();
            return;
          }
          frames = -Infinity; // measured once, never again
        }
      }
      lastFrameAt = now;
      frame(clock.getElapsedTime());
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf || !running()) return;
      lastFrameAt = 0;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const sync = () => (running() ? start() : stop());

    const resize = () => {
      const r = host.getBoundingClientRect();
      const nw = Math.max(1, Math.round(r.width));
      const nh = Math.max(1, Math.round(r.height));
      if (nw === w && nh === h) return;
      w = nw;
      h = nh;
      const aspect = w / h;
      // Vertical FOV from the horizontal extent we want to show, clamped so ultrawide/tall frames stay sane.
      const half = phone.matches ? HALF_WIDTH.phone : HALF_WIDTH.desktop;
      const vfov = (2 * Math.atan(half / CAMERA_Z / aspect) * 180) / Math.PI;
      camera.fov = Math.min(64, Math.max(28, vfov));
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      still();
    };

    const onTheme = () => {
      tint();
      still();
    };
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    scheme.addEventListener('change', onTheme);
    const onReduced = () => {
      sync();
      if (reduced.matches) still();
    };
    reduced.addEventListener('change', onReduced);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0 },
    );
    io.observe(host);
    const onVis = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener('visibilitychange', onVis);
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    tint();
    resize();
    sync();
    if (step) window.__meshHero3dStep = (t: number) => frame(t);
    canvas.dataset.ready = '1';

    return () => {
      stop();
      mo.disconnect();
      io.disconnect();
      ro.disconnect();
      scheme.removeEventListener('change', onTheme);
      reduced.removeEventListener('change', onReduced);
      document.removeEventListener('visibilitychange', onVis);
      for (const g of geometries) g.dispose();
      for (const g of [envTop.geometry, envSide.geometry, envSide2.geometry]) g.dispose();
      for (const m of [matBase, matAccent, groundMat, shadowMat, envTop.material, envSide.material, envSide2.material]) (m as THREE.Material).dispose();
      envTex?.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (step) delete window.__meshHero3dStep;
      delete canvas.dataset.ready;
    };
  }, []);

  return <canvas ref={ref} className="hero3d-canvas" data-testid="hero-3d-canvas" />;
}

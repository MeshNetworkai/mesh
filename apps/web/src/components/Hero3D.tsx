import { Suspense, lazy, useEffect, useState } from 'react';

/**
 * The homepage hero's 3D backdrop (pages/Landing.tsx): a handful of slowly tumbling rounded monoliths at the
 * edges of the hero, near-black matte with a clearcoat and a cool rim light in dark mode, pale grey with soft
 * shadows on white in light mode, one or two of them glowing faintly in `--accent`. The centre stays clear
 * for the headline (a `--bg` vignette) and the canvas fades out toward the bottom of the hero so the chat card
 * sits on a clean background (CSS mask on the wrapper, styles.css `.hero3d`).
 *
 * three.js is NOT in the main bundle: the scene (Hero3DScene.tsx) is `React.lazy`-loaded, so three and the
 * RoundedBoxGeometry addon land in their own chunk fetched only on the homepage, and only when WebGL 2 is
 * there. Nothing is rendered until it has loaded. Everything else (pause off-screen or in a hidden tab,
 * reduced motion, theme re-tint, resize, pixel-ratio caps, cleanup) lives in Hero3DScene.tsx.
 *
 * Off switches: `VITE_HERO_3D=0` at build time, or `localStorage.meshHero3d = '0'` in the browser.
 * A software GL renderer (SwiftShader, llvmpipe: headless browsers, some VMs) gets one static frame instead
 * of the animation; `localStorage.meshHero3d = 'force'` animates anyway, and `'step'` renders nothing on its
 * own and exposes `window.__meshHero3dStep(t)` so a recorder can drive the clock frame by frame.
 */

export const HERO_3D_FLAG = 'VITE_HERO_3D';
export const HERO_3D_STORAGE = 'meshHero3d';

export type Hero3DMode = 'off' | 'auto' | 'force' | 'step';

export function hero3dMode(): Hero3DMode {
  const env = import.meta.env.VITE_HERO_3D;
  if (env === '0' || env === 'false' || env === 'off') return 'off';
  try {
    const v = localStorage.getItem(HERO_3D_STORAGE);
    if (v === '0') return 'off';
    if (v === 'force' || v === 'step') return v;
  } catch {
    /* storage blocked: flag stays on */
  }
  return 'auto';
}

export function hero3dEnabled(): boolean {
  return hero3dMode() !== 'off';
}

type GL = 'none' | 'software' | 'gpu';

/** three r16x+ renders through WebGL 2 only. Probe with a throwaway canvas before fetching the chunk. */
function probeWebGL(): GL {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    if (!gl) return 'none';
    let software = false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (info) {
      const r = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
      software = /swiftshader|llvmpipe|softpipe|software|mesa offscreen|microsoft basic render/i.test(r);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return software ? 'software' : 'gpu';
  } catch {
    return 'none';
  }
}

const Scene = lazy(() => import('./Hero3DScene'));

export function Hero3D() {
  const [gl, setGl] = useState<GL>('none');
  useEffect(() => {
    setGl(probeWebGL());
  }, []);
  if (gl === 'none') return null;
  const mode = hero3dMode();
  return (
    <div className="hero3d" aria-hidden="true" data-testid="hero-3d" data-gl={gl}>
      <Suspense fallback={null}>
        <Scene still={gl === 'software' && mode === 'auto'} step={mode === 'step'} />
      </Suspense>
      <div className="hero3d-vignette" />
    </div>
  );
}

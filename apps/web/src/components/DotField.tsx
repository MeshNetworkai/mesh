import { useEffect, useRef } from 'react';

/**
 * A sparse field of slowly drifting dots behind the homepage hero (pages/Landing.tsx). Brand dots only:
 * `--fg` at ~7% and one in twelve in `--accent` at ~35%, a 1px `--fg` line (≤ 6%) fading in between two
 * dots that come within ~110px. No glow, no gradients, no colour shifts. 30fps (20 on phones), paused when
 * the tab is hidden or the hero is off-screen, a single static frame under prefers-reduced-motion. Masked
 * so it fades out under the headline and toward the bottom of the hero (a canvas destination-in mask).
 *
 * Off switches: `VITE_HERO_FIELD=0` at build time, or `localStorage.meshHeroField = '0'` in the browser.
 */

export const HERO_FIELD_FLAG = 'VITE_HERO_FIELD';
export const HERO_FIELD_STORAGE = 'meshHeroField';

export function heroFieldEnabled(): boolean {
  const env = import.meta.env.VITE_HERO_FIELD;
  if (env === '0' || env === 'false' || env === 'off') return false;
  try {
    if (localStorage.getItem(HERO_FIELD_STORAGE) === '0') return false;
  } catch {
    /* storage blocked: flag stays on */
  }
  return true;
}

interface Dot {
  x: number;
  y: number;
  /** heading in radians and speed in px/s */
  a: number;
  v: number;
  /** turn rate, rad/s; re-drawn now and then for the gentle direction changes */
  turn: number;
  accent: boolean;
}

const LINK_PX = 140;
const DOT_ALPHA = 0.28;
const ACCENT_ALPHA = 0.85;
const LINE_ALPHA = 0.18;

/** `--fg` / `--accent` as rgb() so an alpha can be appended. Falls back to near-black/green. */
function readColours(el: HTMLElement): { fg: [number, number, number]; accent: [number, number, number] } {
  const cs = getComputedStyle(el);
  const parse = (v: string, fb: [number, number, number]): [number, number, number] => {
    const s = v.trim();
    const hex = s.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const rgb = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    // Any other syntax: let the browser normalise it through a scratch canvas.
    try {
      const c = document.createElement('canvas').getContext('2d');
      if (c) {
        c.fillStyle = s;
        const out = String(c.fillStyle).match(/^#([0-9a-f]{6})/i);
        if (out) {
          const n = parseInt(out[1], 16);
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
      }
    } catch {
      /* fall through */
    }
    return fb;
  };
  return { fg: parse(cs.getPropertyValue('--fg'), [11, 18, 32]), accent: parse(cs.getPropertyValue('--accent'), [31, 157, 102]) };
}

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function DotField({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const host = canvas.parentElement ?? canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const phone = window.matchMedia('(max-width: 760px)');
    let colours = readColours(document.documentElement);
    let dots: Dot[] = [];
    let w = 0;
    let h = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let visible = true; // hero in view (IntersectionObserver)
    let hidden = document.hidden;
    let lastColourRead = 0;

    const count = () => {
      const target = phone.matches ? 36 : 90;
      // Scale with width around the 1440 reference, within sane bounds.
      return Math.max(12, Math.min(110, Math.round((target * Math.max(320, w)) / (phone.matches ? 390 : 1440))));
    };

    const seed = () => {
      const n = count();
      dots = Array.from({ length: n }, (_, i) => ({
        x: Math.random() * w,
        y: Math.random() * h,
        a: Math.random() * Math.PI * 2,
        v: 6 + Math.random() * 4,
        turn: (Math.random() - 0.5) * 0.3,
        accent: i % 12 === 0,
      }));
    };

    const resize = () => {
      const r = host.getBoundingClientRect();
      const nw = Math.max(1, Math.round(r.width));
      const nh = Math.max(1, Math.round(r.height));
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const first = w === 0;
      // Keep dots in place proportionally on resize.
      if (!first && nw && nh) for (const d of dots) {
        d.x = (d.x / w) * nw;
        d.y = (d.y / h) * nh;
      }
      w = nw;
      h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (first || dots.length !== count()) seed();
      draw();
    };

    const draw = () => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const fg = colours.fg;
      // Lines first, then dots on top.
      ctx.lineWidth = 1;
      for (let i = 0; i < dots.length; i++) {
        const a = dots[i];
        for (let j = i + 1; j < dots.length; j++) {
          const b = dots[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_PX * LINK_PX) continue;
          const t = 1 - Math.sqrt(d2) / LINK_PX;
          ctx.strokeStyle = rgba(fg, LINE_ALPHA * t);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (const d of dots) {
        ctx.fillStyle = d.accent ? rgba(colours.accent, ACCENT_ALPHA) : rgba(fg, DOT_ALPHA);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.accent ? 2.6 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      mask();
    };

    /**
     * Soft mask, multiplied into what was just drawn: a hole under the headline (top-centre) and a fade
     * toward the bottom of the hero, so the field never sits behind text or the figures.
     */
    const mask = () => {
      ctx.globalCompositeOperation = 'destination-in';
      const cx = w / 2;
      const cy = Math.min(h * 0.18, 260);
      const r = Math.max(260, Math.min(w, 1440) * 0.34);
      const hole = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
      hole.addColorStop(0, 'rgba(0,0,0,0)');
      hole.addColorStop(1, 'rgba(0,0,0,1)');
      ctx.fillStyle = hole;
      ctx.fillRect(0, 0, w, h);
      const fade = ctx.createLinearGradient(0, 0, 0, h);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(0.45, 'rgba(0,0,0,1)');
      fade.addColorStop(0.8, 'rgba(0,0,0,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    };

    const step = (dt: number) => {
      for (const d of dots) {
        if (Math.random() < 0.01) d.turn = (Math.random() - 0.5) * 0.3;
        d.a += d.turn * dt;
        d.x += Math.cos(d.a) * d.v * dt;
        d.y += Math.sin(d.a) * d.v * dt;
        // Wrap with a small margin so a dot never pops at the edge.
        if (d.x < -8) d.x = w + 8;
        else if (d.x > w + 8) d.x = -8;
        if (d.y < -8) d.y = h + 8;
        else if (d.y > h + 8) d.y = -8;
      }
    };

    const running = () => visible && !hidden && !reduced.matches;

    const loop = (now: number) => {
      raf = 0;
      if (!running()) return;
      const interval = 1000 / (phone.matches ? 20 : 30);
      if (now - last >= interval) {
        const dt = Math.min(0.1, last ? (now - last) / 1000 : interval / 1000);
        last = now;
        if (now - lastColourRead > 2000) {
          lastColourRead = now;
          colours = readColours(document.documentElement);
        }
        step(dt);
        draw();
      }
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      if (raf || !running()) return;
      last = 0;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    const sync = () => (running() ? start() : stop());

    const onTheme = () => {
      colours = readColours(document.documentElement);
      draw();
    };
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', onTheme);
    reduced.addEventListener('change', sync);
    phone.addEventListener('change', resize);

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

    resize();
    sync();

    return () => {
      stop();
      mo.disconnect();
      io.disconnect();
      ro.disconnect();
      scheme.removeEventListener('change', onTheme);
      reduced.removeEventListener('change', sync);
      phone.removeEventListener('change', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={ref} className={`dotfield ${className}`.trim()} aria-hidden="true" data-testid="hero-field" />;
}

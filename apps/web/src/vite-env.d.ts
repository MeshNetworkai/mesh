/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_PUBLIC_API_URL?: string;
  readonly VITE_MOCK?: string;
  /** Mock mode only: preview the usage-revenue share as switched on. */
  readonly VITE_MOCK_USAGE_SHARE?: string;
  /** Homepage hero 3D backdrop (components/Hero3D.tsx): '0' turns it off. Default on. */
  readonly VITE_HERO_3D?: string;
  /** '0' unlocks /stats (content/flags.ts). Default locked until launch. */
  readonly VITE_STATS_LOCKED?: string;
}

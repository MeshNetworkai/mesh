/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_PUBLIC_API_URL?: string;
  readonly VITE_MOCK?: string;
  /** Mock mode only: preview the usage-revenue share as switched on. */
  readonly VITE_MOCK_USAGE_SHARE?: string;
}

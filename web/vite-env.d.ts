/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HERMES_BUILD_COMMIT?: string;
  readonly VITE_HERMES_DESKTOP_VERSION?: string;
  readonly VITE_HERMES_DASHBOARD_ORIGIN?: string;
}

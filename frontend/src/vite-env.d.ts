/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_BACKEND_DIRECT_URL?: string;
  readonly VITE_DASHBOARD_ASSISTANT_API_PATH?: string;
  readonly VITE_USE_MOCK_API?: string;
}

declare module "*.jsx" {
  const Component: any;
  export default Component;
}

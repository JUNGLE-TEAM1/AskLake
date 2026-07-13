/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DASHBOARD_ASSISTANT_API_PATH?: string;
}

declare module "*.jsx" {
  const Component: any;
  export default Component;
}

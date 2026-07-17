/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_DASHBOARD_ASSISTANT_API_PATH?: string;
  readonly VITE_OBJECT_STORAGE_PROVIDER?: string;
  readonly VITE_S3_REGION?: string;
  readonly VITE_SPARK_OUTPUT_BUCKET?: string;
}

declare module "*.jsx" {
  const Component: any;
  export default Component;
}

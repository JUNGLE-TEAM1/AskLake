import type { PermissionOptionsResponse } from "../types";
import { apiClient } from "./apiClient";

export async function fetchPermissionOptions(): Promise<PermissionOptionsResponse> {
  return apiClient.get<PermissionOptionsResponse>("/api/etl/permission-options");
}

import type { PermissionOptionsResponse } from "../types";
import { apiClient } from "./apiClient";

export async function fetchPermissionOptions(jobId?: string): Promise<PermissionOptionsResponse> {
  const query = jobId ? `?jobId=${encodeURIComponent(jobId)}` : "";
  return apiClient.get<PermissionOptionsResponse>(`/api/etl/permission-options${query}`);
}

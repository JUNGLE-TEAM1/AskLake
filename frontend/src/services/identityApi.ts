import type { CurrentUserResponse } from "../types";
import { apiClient } from "./apiClient";

export async function fetchCurrentUser(): Promise<CurrentUserResponse> {
  return apiClient.get<CurrentUserResponse>("/api/users/me");
}

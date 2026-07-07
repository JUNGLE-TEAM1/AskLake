import { apiClient } from "./apiClient";

export type TargetDatabaseOption = {
  description: string;
  name: string;
};

export type TargetDatabasesResponse = {
  databases: TargetDatabaseOption[];
};

export async function listTargetDatabases() {
  return apiClient.get<TargetDatabasesResponse>("/api/target/databases");
}

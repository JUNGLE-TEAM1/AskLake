import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("live AI conversation adapter covers hydrate and versioned CRUD endpoints", () => {
  const adapter = read("src/services/aiConversationApi.ts");
  const types = read("src/types/ai.ts");

  assert.match(adapter, /const AI_CONVERSATIONS_PATH = "\/api\/ai\/conversations"/);
  assert.match(adapter, /apiClient\.get<AiConversationListResponse>\(AI_CONVERSATIONS_PATH/);
  assert.match(adapter, /apiClient\.post<AiConversation>\(AI_CONVERSATIONS_PATH, request/);
  assert.match(adapter, /apiClient\.patch<AiConversation>/);
  assert.match(adapter, /\?version=\$\{encodeURIComponent\(String\(version\)\)\}/);
  assert.match(adapter, /\/messages`/);
  assert.match(types, /version: number;/);
  assert.match(types, /clientRequestId: string;/);
});

test("AI chat hydrates live state while preserving explicit mock behavior", () => {
  const page = read("src/pages/ai/AiChatPage.tsx");

  assert.match(page, /apiConfig\.useMock \? \[mockInitialConversationRef\.current\] : \[\]/);
  assert.match(page, /listAiConversations\(\)\.then\(async \(\{ items \}\)/);
  assert.match(page, /items\.length > 0 \? items : \[await createAiConversation\(\)\]/);
  assert.match(page, /updateAiConversation\(conversation\.id, \{/);
  assert.match(page, /deleteAiConversation\(deletedConversation\.id, deletedConversation\.version\)/);
  assert.match(page, /createAiConversationMessage\(conversation\.id, \{/);
  assert.match(page, /version: conversation\.version/);
  assert.match(page, /const clearSelectedDatasets = async \(\) =>/);
  assert.match(page, /selectedDatasetIds: \[\]/);
  assert.match(page, />선택 초기화<\/button>/);
  assert.match(page, /await submitMockPrompt/);
  assert.match(page, /await submitLivePrompt/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
});

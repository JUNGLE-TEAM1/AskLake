import type {
  AiConversation,
  AiConversationListResponse,
  CreateAiConversationMessageRequest,
  CreateAiConversationRequest,
  UpdateAiConversationRequest,
} from "../types/ai";
import { apiClient, type ApiRequestOptions } from "./apiClient";

const AI_CONVERSATIONS_PATH = "/api/ai/conversations";

export function listAiConversations(options: ApiRequestOptions = {}) {
  return apiClient.get<AiConversationListResponse>(AI_CONVERSATIONS_PATH, options);
}

export function getAiConversation(conversationId: string, options: ApiRequestOptions = {}) {
  return apiClient.get<AiConversation>(
    `${AI_CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}`,
    options,
  );
}

export function createAiConversation(
  request: CreateAiConversationRequest = {},
  options: ApiRequestOptions = {},
) {
  return apiClient.post<AiConversation>(AI_CONVERSATIONS_PATH, request, options);
}

export function updateAiConversation(
  conversationId: string,
  request: UpdateAiConversationRequest,
  options: ApiRequestOptions = {},
) {
  return apiClient.patch<AiConversation>(
    `${AI_CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}`,
    request,
    options,
  );
}

export function deleteAiConversation(
  conversationId: string,
  version: number,
  options: ApiRequestOptions = {},
) {
  const path = `${AI_CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}?version=${encodeURIComponent(String(version))}`;
  return apiClient.delete<void>(path, options);
}

export function createAiConversationMessage(
  conversationId: string,
  request: CreateAiConversationMessageRequest,
  options: ApiRequestOptions = {},
) {
  return apiClient.post<AiConversation>(
    `${AI_CONVERSATIONS_PATH}/${encodeURIComponent(conversationId)}/messages`,
    request,
    options,
  );
}

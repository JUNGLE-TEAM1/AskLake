export type AiConversationMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  contextNames: string[];
  notices: string[];
  sql?: string | null;
  createdAt: string;
};

export type AiConversation = {
  id: string;
  title: string;
  selectedDatasetIds: string[];
  messages: AiConversationMessage[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AiConversationListResponse = {
  items: AiConversation[];
};

export type CreateAiConversationRequest = {
  title?: string;
  selectedDatasetIds?: string[];
};

export type UpdateAiConversationRequest = {
  version: number;
  title?: string;
  selectedDatasetIds?: string[];
};

export type CreateAiConversationMessageRequest = {
  version: number;
  clientRequestId: string;
  content: string;
};

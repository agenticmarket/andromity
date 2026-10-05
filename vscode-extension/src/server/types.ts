export interface JsonRpcRequest<T = any> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = any> {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface JsonRpcNotification<T = any> {
  jsonrpc: "2.0";
  method: string;
  params: T;
}

export interface SessionInfo {
  id: string;
  name: string;
  status?: string;
  project_path: string;
  parent_session?: string;
  updated_at?: string;
  created_at?: string;
  message_count?: number;
  token_total?: number;
  context_tokens?: number;
  cost_usd?: number;
  provider?: string;
  model?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  desc?: string;
  provider: string;
  context?: string;
  context_limit?: number;
  pricing?: string;
  is_free?: boolean;
  tags?: string[];
  is_pinned?: boolean;
}

export interface PinnedModelInfo {
  id: string;
  provider: string;
  name?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  has_key: boolean;
  portal?: string;
  type?: string;
  base_url?: string;
  model?: string;
  api_version?: string;
  custom?: boolean;
}

export interface PendingInputInfo {
  id: string;
  prompt: string;
  delivery: "queue" | "steer";
  status: string;
  image_uris: string[];
  image_count: number;
}

export interface InputQueueState {
  session_id: string;
  epoch: string;
  revision: number;
  paused: boolean;
  items: PendingInputInfo[];
  supported?: boolean;
}

export interface InputBridgeMessage {
  stripImages?: boolean;
  type: string;
  sessionId?: string;
  requestId?: string;
  inputId?: string;
  prompt?: string;
  images?: string[];
  delivery?: "queue" | "steer";
  attachContext?: boolean;
  profile?: string;
  model?: string;
  provider?: string;
  mode?: string;
  reasoningEffort?: string;
}

export interface ToolApprovalEvent {
  session_id: string;
  approval_id: string;
  tool_name: string;
  args: Record<string, any>;
}

export interface SessionWebviewEvent {
  type: string;
  session_id?: string;
  event_seq?: number;
  [key: string]: unknown;
}

export interface InteractionMessage {
  type: string;
  approvalId?: string;
  questionId?: string;
  scope?: string;
  answers?: string;
}

export interface ClarifyingQuestionsEvent {
  session_id: string;
  question_id: string;
  questions: Array<{
    question: string;
    type?: "single" | "multi" | "text";
    options?: string[];
  }>;
}

export interface SubAgentEvent {
  session_id: string;
  agent_id: string;
  role: string;
  model?: string;
  provider?: string;
  task?: string;
  tool_id?: string;
  status?: string;
  event_type?: string;
  delta_text?: string;
  tool_name?: string;
  tool_args?: string;
  tool_result?: string;
  detail?: string;
  result?: string;
  token_usage?: Record<string, number>;
  duration_ms?: number;
  error?: string;
}


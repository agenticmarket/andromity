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
  has_key?: boolean;
  needs_key?: boolean;
  source?: "live" | "catalog";
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
  key_required?: boolean;
}

/** Reply of config.test_provider. */
export interface ProviderProbeReply {
  success?: boolean;
  error_type?: string;
  message?: string;
  detail?: string;
  model?: string;
  latency_ms?: number;
}

/** Reply of config.refresh_provider_models. */
export interface ProviderModelsReply {
  provider?: string;
  ok?: boolean;
  error_type?: string | null;
  message?: string;
  source?: "live" | "catalog";
  models?: ModelInfo[];
}

export type KeyCheckTone = "ok" | "warn" | "error";

export interface KeyCheckResult {
  ok: boolean;
  tone: KeyCheckTone;
  label: string;
  errorType?: string;
  detail?: string;
  model?: string;
}

export interface ProviderModelsRefresh {
  provider: string;
  ok: boolean;
  message: string;
  models: ModelInfo[] | null;
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
  /** The prompt is text the chat wrote in for a message that holds only images. */
  imageOnly?: boolean;
  delivery?: "queue" | "steer";
  attachContext?: boolean;
  profile?: string;
  model?: string;
  provider?: string;
  mode?: string;
  reasoningEffort?: string;
}

/** The prompt an undo removed: its text and its images as data URIs, full size where the engine still has them. */
export interface UndonePrompt {
  text: string;
  images: string[];
}

export interface SessionUndoResult {
  success: boolean;
  popped_messages?: number;
  turns_undone?: number;
  target_turn_index?: number;
  git_status?: string;
  error?: string;
  undone_prompt?: UndonePrompt;
}

export interface PromptImageMessage {
  type: string;
  name?: unknown;
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
  dismissed?: boolean;
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

export interface IntegrationResult {
  success: boolean;
  error?: string;
  name?: string;
  status?: string;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  category: string;
  url: string;
  description: string;
  needs_client: boolean;
  setup_url: string;
  auth?: "oauth" | "token";
  connected: boolean;
}

export interface ConnectorIcon {
  hex: string;
  path: string;
}

export interface ConnectorConnectResult extends IntegrationResult {
  message?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  type?: string;
  headers?: Record<string, string>;
  oauth?: { client_id?: string; client_secret?: string };
  disabled?: boolean;
}

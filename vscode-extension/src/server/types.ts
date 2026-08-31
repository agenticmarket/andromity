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
  project_path: string;
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
}

export interface ProviderInfo {
  id: string;
  name: string;
  has_key: boolean;
}

export interface ToolApprovalEvent {
  session_id: string;
  approval_id: string;
  tool_name: string;
  args: Record<string, any>;
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


/**
 * Protocol 1 types, mirroring docs/protocol.md. Kept in one file so the shapes
 * the extension relies on are visible in a single place; the contract itself
 * lives in the repository, not in this code.
 */

export const PROTOCOL_VERSION = 1;
export const HANDSHAKE_PREFIX = 'lexiqode-core-ready';

/** The single stdout line the core prints on startup. */
export interface Handshake {
  product: string;
  version: string;
  protocol: number;
  base_url: string;
  host: string;
  port: number;
  token: string;
  pid: number;
  workspace: string;
  started_at?: string;
}

/** core-runtime.json: a handshake that a previous run left behind. */
export interface RuntimeDescriptor {
  product?: string;
  version?: string;
  protocol?: number;
  written_at?: string;
  base_url?: string;
  host?: string;
  port?: number;
  token?: string;
  pid?: number;
  workspace?: string;
}

export interface HealthResponse {
  ok: boolean;
  product: string;
  version: string;
  protocol: number;
  workspace: string;
  pid: number;
}

export interface ModelProfile {
  id: string;
  label: string;
  base_url: string;
  model: string;
  context_window: number;
  max_output_tokens: number;
  temperature: number;
  supports_tools: boolean;
  stream_usage: boolean;
  has_api_key: boolean;
}

export interface AgentSettings {
  max_steps: number;
  auto_approve: boolean;
  approve_writes: boolean;
  approve_commands: boolean;
  command_timeout: number;
}

export type ToolFamily = 'read' | 'write' | 'command';

export interface ToolInfo {
  name: string;
  description: string;
  family: ToolFamily;
  enabled: boolean;
}

export interface TurnState {
  running: boolean;
  message: string;
  mode: string;
  elapsed_ms: number;
  last_error: string;
  last_stopped: string;
}

/** One selectable behaviour, described by the core so the editor cannot drift. */
export interface AgentModeInfo {
  id: string;
  label: string;
  summary: string;
  /** Allowed tool names, or null when the mode places no restriction. */
  tools: string[] | null;
  steps: number | null;
  can_write: boolean;
}

export interface CoreState {
  ok: boolean;
  workspace: string;
  profile: ModelProfile;
  agent: AgentSettings;
  tools: ToolInfo[];
  modes: AgentModeInfo[];
  turn: TurnState;
  pending_approvals: string[];
  history_length: number;
  protocol: number;
  version: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Every frame the core can push on /api/events. */
export type CoreEventName =
  | 'ready'
  | 'turn_start'
  | 'step_start'
  | 'text_delta'
  | 'reasoning_delta'
  | 'assistant_text'
  | 'tool_call_delta'
  | 'tool_start'
  | 'tool_end'
  | 'approval_request'
  | 'error'
  | 'turn_end';

export interface ReadyEvent {
  protocol: number;
}

export interface TurnStartEvent {
  model: string;
  profile: string;
}

export interface StepStartEvent {
  step: number;
  max_steps: number;
}

export interface TextDeltaEvent {
  text: string;
}

export interface AssistantTextEvent {
  text: string;
}

export interface ToolCallDeltaEvent {
  index: number;
  name: string;
}

export interface ToolStartEvent {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolEndEvent {
  id: string;
  name: string;
  ok: boolean;
  elapsed_ms: number;
  meta: Record<string, unknown>;
  content: string;
  cancelled?: boolean;
}

export interface ApprovalRequestEvent {
  id: string;
  tool: string;
  family: ToolFamily;
  summary: string;
  detail: string;
}

export interface ErrorEvent {
  message: string;
  status?: number;
}

export interface TurnEndEvent {
  stopped: 'completed' | 'max_steps' | 'cancelled' | 'error';
  steps: number;
  tool_calls: number;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** One parsed SSE frame. `data` is narrowed by `event`. */
export interface CoreFrame<T = Record<string, unknown>> {
  event: CoreEventName | string;
  data: T;
}
/**
 * Type definitions for Voice AI POC
 */

// ============================================
// CALL TYPES
// ============================================

export interface CallSession {
  id: string;
  phoneNumber: string;
  prospectName?: string;
  companyName?: string;
  startedAt: Date;
  endedAt?: Date;
  status: CallStatus;
  conversationHistory: ConversationTurn[];
  metrics: CallMetrics;
}

export type CallStatus = 
  | 'initiating'
  | 'ringing'
  | 'connected'
  | 'active'
  | 'on_hold'
  | 'ended'
  | 'failed';

export interface ConversationTurn {
  role: 'agent' | 'user';
  content: string;
  timestamp: Date;
  metrics?: TurnMetrics;
}

// ============================================
// METRICS TYPES
// ============================================

export interface CallMetrics {
  totalDuration: number;
  turns: TurnMetrics[];
  averageLatency: LatencyBreakdown;
  peakLatency: LatencyBreakdown;
  fillersUsed: number;
  transcriptionErrors: number;
}

export interface TurnMetrics {
  turnId: string;
  timestamp: Date;
  latency: LatencyBreakdown;
  audioInputDuration: number;
  audioOutputDuration: number;
  fillerUsed: boolean;
  fillerText?: string;
}

export interface LatencyBreakdown {
  /** Tempo do fim do áudio do usuário até transcrição completa */
  stt: number;
  /** Tempo da transcrição até resposta do LLM */
  llm: number;
  /** Tempo da resposta do LLM até primeiro byte de áudio */
  tts: number;
  /** Tempo total voice-to-voice */
  total: number;
  /** Tempo até primeiro áudio (pode ser filler) */
  timeToFirstAudio: number;
}

export interface MetricEvent {
  stage: 'stt_start' | 'stt_end' | 'llm_start' | 'llm_end' | 'tts_start' | 'tts_first_byte' | 'tts_end';
  timestamp: number;
  callId: string;
  turnId: string;
  metadata?: Record<string, any>;
}

// ============================================
// PROVIDER TYPES
// ============================================

// Telnyx
export interface TelnyxConfig {
  apiKey: string;
  connectionId: string;
  phoneNumber: string;
  webhookUrl: string;
}

export interface TelnyxCallEvent {
  type: 'call.initiated' | 'call.answered' | 'call.hangup' | 'call.machine.detection.ended';
  payload: {
    call_control_id: string;
    call_leg_id: string;
    call_session_id: string;
    from: string;
    to: string;
    state: string;
  };
}

// OpenAI
export interface OpenAIConfig {
  apiKey: string;
  transcriptionModel: string;
  llmModel: string;
  useRealtimeApi: boolean;
}

export interface TranscriptionResult {
  text: string;
  confidence?: number;
  language?: string;
  duration: number;
  segments?: TranscriptionSegment[];
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

export interface LLMResponse {
  text: string;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ElevenLabs
export interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  model: string;
  stability: number;
  similarityBoost: number;
  style: number;
  outputFormat: string;
}

export interface TTSResult {
  audioBuffer: Buffer;
  duration: number;
  characterCount: number;
}

// ============================================
// FILLER TYPES
// ============================================

export interface FillerAudio {
  text: string;
  audioBuffer: Buffer;
  duration: number;
  category: FillerCategory;
}

export type FillerCategory = 
  | 'generic'
  | 'withName'
  | 'transition'
  | 'clarification';

export interface FillerContext {
  prospectName?: string;
  lastUserMessage?: string;
  conversationStage: 'intro' | 'qualifying' | 'presenting' | 'closing';
}

// ============================================
// VOICE AGENT TYPES
// ============================================

export interface VoiceAgentConfig {
  telephony: ITelephonyProvider;
  transcriber: ITranscriber;
  llm: ILLM;
  tts: ITTS;
  fillerManager: IFillerManager;
  metrics: IMetricsCollector;
  systemPrompt: string;
}

export interface VoiceAgentEvents {
  'call:started': (callId: string) => void;
  'call:ended': (callId: string, summary: CallSummary) => void;
  'turn:started': (callId: string, turnId: string) => void;
  'turn:ended': (callId: string, turnId: string, metrics: TurnMetrics) => void;
  'filler:played': (callId: string, fillerText: string) => void;
  'metrics:update': (data: { stage: string; duration: number }) => void;
  'error': (error: Error, context: string) => void;
}

export interface CallSummary {
  callId: string;
  duration: number;
  turns: number;
  outcome: 'interested' | 'not_interested' | 'callback' | 'voicemail' | 'no_answer' | 'error';
  metrics: CallMetrics;
  transcript: ConversationTurn[];
}

// ============================================
// PROVIDER INTERFACES
// ============================================

export interface ITelephonyProvider {
  makeCall(phoneNumber: string): Promise<string>;
  endCall(callId: string): Promise<void>;
  sendAudio(callId: string, audioBuffer: Buffer): Promise<void>;
  onAudioReceived(callId: string, callback: (audio: Buffer) => void): void;
  onCallEvent(callback: (event: TelnyxCallEvent) => void): void;
}

export interface ITranscriber {
  transcribe(audioBuffer: Buffer): Promise<TranscriptionResult>;
  startStream?(callId: string): Promise<void>;
  feedAudio?(callId: string, chunk: Buffer): void;
  onTranscript?(callId: string, callback: (result: TranscriptionResult) => void): void;
}

export interface ILLM {
  generate(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<LLMResponse>;
  generateStream?(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse>;
}

export interface ITTS {
  synthesize(text: string): Promise<TTSResult>;
  synthesizeStream?(text: string, onChunk: (chunk: Buffer) => void): Promise<void>;
}

export interface IFillerManager {
  preloadFillers(): Promise<void>;
  getFiller(context: FillerContext): FillerAudio | null;
  getFillerForName(name: string): FillerAudio | null;
}

export interface IMetricsCollector {
  startTurn(callId: string): string;
  recordEvent(event: MetricEvent): void;
  endTurn(callId: string, turnId: string): TurnMetrics;
  getCallMetrics(callId: string): CallMetrics;
  exportMetrics(callId: string): Promise<void>;
}

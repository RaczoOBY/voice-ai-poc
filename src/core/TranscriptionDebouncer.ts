/**
 * TranscriptionDebouncer - Debounce adaptativo de transcrições
 * 
 * Responsável por:
 * - Agregar transcrições consecutivas
 * - Debounce adaptativo (menor para streaming STT, maior para batch)
 * - Integração com detecção de continuação
 * 
 * Evita processar cada fragmento de transcrição separadamente,
 * aguardando um período de silêncio para processar tudo junto.
 */

import { Logger } from '../utils/Logger';

export interface TranscriptionDebouncerConfig {
  /** Debounce para STT streaming (Scribe) em ms - já faz VAD */
  streamingDebounceMs?: number;
  /** Debounce para STT batch (Whisper) em ms - precisa agregar */
  batchDebounceMs?: number;
}

const DEFAULT_CONFIG: Required<TranscriptionDebouncerConfig> = {
  streamingDebounceMs: 150,
  batchDebounceMs: 800,
};

export type DebounceCallback = (text: string) => void | Promise<void>;

interface SessionState {
  pendingText: string;
  timer: NodeJS.Timeout | null;
  callback: DebounceCallback | null;
}

export class TranscriptionDebouncer {
  private logger: Logger;
  private config: Required<TranscriptionDebouncerConfig>;
  private isStreamingSTT: boolean;
  
  // Estado por sessão
  private sessions: Map<string, SessionState> = new Map();
  
  // Modo single-session
  private singleSessionId: string | null = null;

  constructor(isStreamingSTT: boolean, config?: TranscriptionDebouncerConfig) {
    this.logger = new Logger('Debouncer');
    this.isStreamingSTT = isStreamingSTT;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    const mode = isStreamingSTT ? 'streaming' : 'batch';
    const debounce = this.getDebounceMs();
    this.logger.debug(`📝 Modo ${mode} - debounce: ${debounce}ms`);
  }

  /**
   * Define sessão única (modo single-session para StreamingVoiceAgent)
   */
  setSingleSession(callId: string): void {
    this.singleSessionId = callId;
    this.initSession(callId);
  }

  /**
   * Inicializa estado para uma sessão
   */
  initSession(callId: string): void {
    if (!this.sessions.has(callId)) {
      this.sessions.set(callId, {
        pendingText: '',
        timer: null,
        callback: null,
      });
    }
  }

  /**
   * Resolve callId (usa single-session se não fornecido)
   */
  private resolveCallId(callId?: string): string {
    const id = callId || this.singleSessionId;
    if (!id) {
      throw new Error('CallId não fornecido e modo single-session não configurado');
    }
    return id;
  }

  /**
   * Obtém estado da sessão
   */
  private getSession(callId?: string): SessionState {
    const id = this.resolveCallId(callId);
    
    if (!this.sessions.has(id)) {
      this.initSession(id);
    }
    
    return this.sessions.get(id)!;
  }

  /**
   * Obtém o debounce em ms baseado no modo
   */
  getDebounceMs(): number {
    return this.isStreamingSTT 
      ? this.config.streamingDebounceMs 
      : this.config.batchDebounceMs;
  }

  /**
   * Define callback para quando debounce expirar
   */
  setCallback(callback: DebounceCallback, callId?: string): void {
    const session = this.getSession(callId);
    session.callback = callback;
  }

  /**
   * Adiciona texto para debounce
   * Agrega com texto pendente e reseta timer
   */
  add(text: string, callId?: string): void {
    const id = this.resolveCallId(callId);
    const session = this.getSession(id);
    
    // Agregar texto
    const newText = session.pendingText 
      ? `${session.pendingText} ${text}`.trim() 
      : text;
    session.pendingText = newText;
    
    // Cancelar timer anterior se existir
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    
    // Iniciar novo timer
    const debounceMs = this.getDebounceMs();
    session.timer = setTimeout(() => {
      this.flush(id);
    }, debounceMs);
    
    const mode = this.isStreamingSTT ? 'streaming' : 'batch';
    this.logger.debug(`⏳ Debounce (${debounceMs}ms - ${mode}): "${text.substring(0, 30)}..."`);
  }

  /**
   * Força flush do texto pendente (ignora timer)
   */
  flush(callId?: string): string {
    const id = this.resolveCallId(callId);
    const session = this.getSession(id);
    
    // Cancelar timer
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    
    // Obter e limpar texto pendente
    const text = session.pendingText;
    session.pendingText = '';
    
    // Chamar callback se definido
    if (text && session.callback) {
      this.logger.debug(`📝 Flush: "${text.substring(0, 50)}..."`);
      Promise.resolve(session.callback(text)).catch(err => {
        this.logger.error('Erro no callback de debounce:', err);
      });
    }
    
    return text;
  }

  /**
   * Obtém texto pendente sem disparar callback
   */
  getPending(callId?: string): string {
    return this.getSession(callId).pendingText;
  }

  /**
   * Verifica se há texto pendente
   */
  hasPending(callId?: string): boolean {
    return this.getSession(callId).pendingText.length > 0;
  }

  /**
   * Cancela debounce pendente (não dispara callback)
   */
  cancel(callId?: string): string {
    const id = this.resolveCallId(callId);
    const session = this.getSession(id);
    
    // Cancelar timer
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    
    // Obter e limpar texto sem chamar callback
    const text = session.pendingText;
    session.pendingText = '';
    
    if (text) {
      this.logger.debug(`🛑 Debounce cancelado: "${text.substring(0, 30)}..."`);
    }
    
    return text;
  }

  /**
   * Adiciona texto a um pendente existente e retorna combinado
   * Usado quando continuação é detectada
   */
  combine(additionalText: string, callId?: string): string {
    const session = this.getSession(callId);
    const combined = session.pendingText 
      ? `${session.pendingText} ${additionalText}`.trim()
      : additionalText;
    session.pendingText = combined;
    return combined;
  }

  /**
   * Limpa estado da sessão
   */
  clearSession(callId?: string): void {
    const id = this.resolveCallId(callId);
    const session = this.sessions.get(id);
    
    if (session?.timer) {
      clearTimeout(session.timer);
    }
    
    this.sessions.delete(id);
  }

  /**
   * Limpa todas as sessões
   */
  clearAll(): void {
    for (const [id, session] of this.sessions) {
      if (session.timer) {
        clearTimeout(session.timer);
      }
    }
    this.sessions.clear();
    this.singleSessionId = null;
  }
}

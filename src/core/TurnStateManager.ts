/**
 * TurnStateManager - Gerenciamento centralizado de estado do turno
 * 
 * Centraliza as flags e estados duplicados entre VoiceAgent e StreamingVoiceAgent:
 * - isProcessing: Se um turno está sendo processado
 * - pendingTranscription: Texto aguardando debounce
 * - continuationDetected: Se usuário continuou falando durante processamento
 * - shouldCancelProcessing: Flag para cancelar processamento atual
 * - hasStartedPlayback: Se áudio já começou a tocar (não pode mais cancelar)
 * 
 * Suporta:
 * - Multi-session (VoiceAgent com Maps por callId)
 * - Single-session (StreamingVoiceAgent com variáveis simples)
 */

import { Logger } from '../utils/Logger';

export interface TurnState {
  /** Se um turno está sendo processado */
  isProcessing: boolean;
  /** Texto aguardando debounce/agregação */
  pendingTranscription: string;
  /** Se usuário continuou falando durante processamento */
  continuationDetected: boolean;
  /** Flag para cancelar processamento atual */
  shouldCancelProcessing: boolean;
  /** Se áudio já começou a tocar (não pode mais cancelar) */
  hasStartedPlayback: boolean;
  /** Timer de debounce (se ativo) */
  debounceTimer: NodeJS.Timeout | null;
}

const DEFAULT_STATE: TurnState = {
  isProcessing: false,
  pendingTranscription: '',
  continuationDetected: false,
  shouldCancelProcessing: false,
  hasStartedPlayback: false,
  debounceTimer: null,
};

export class TurnStateManager {
  private logger: Logger;
  private states: Map<string, TurnState> = new Map();
  
  // Modo single-session (para StreamingVoiceAgent)
  private singleSessionId: string | null = null;

  constructor() {
    this.logger = new Logger('TurnState');
  }

  /**
   * Inicializa estado para uma sessão
   */
  initSession(callId: string): void {
    if (!this.states.has(callId)) {
      this.states.set(callId, { ...DEFAULT_STATE });
      this.logger.debug(`📋 Estado inicializado para ${callId}`);
    }
  }

  /**
   * Define sessão única (modo single-session para StreamingVoiceAgent)
   */
  setSingleSession(callId: string): void {
    this.singleSessionId = callId;
    this.initSession(callId);
  }

  /**
   * Obtém estado da sessão (ou sessão única se configurada)
   */
  private getState(callId?: string): TurnState {
    const id = callId || this.singleSessionId;
    if (!id) {
      throw new Error('CallId não fornecido e modo single-session não configurado');
    }
    
    if (!this.states.has(id)) {
      this.initSession(id);
    }
    
    return this.states.get(id)!;
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

  // ============================================
  // GETTERS
  // ============================================

  isProcessing(callId?: string): boolean {
    return this.getState(callId).isProcessing;
  }

  getPendingTranscription(callId?: string): string {
    return this.getState(callId).pendingTranscription;
  }

  isContinuationDetected(callId?: string): boolean {
    return this.getState(callId).continuationDetected;
  }

  shouldCancel(callId?: string): boolean {
    return this.getState(callId).shouldCancelProcessing;
  }

  hasPlaybackStarted(callId?: string): boolean {
    return this.getState(callId).hasStartedPlayback;
  }

  getDebounceTimer(callId?: string): NodeJS.Timeout | null {
    return this.getState(callId).debounceTimer;
  }

  // ============================================
  // SETTERS
  // ============================================

  setProcessing(value: boolean, callId?: string): void {
    const state = this.getState(callId);
    state.isProcessing = value;
    
    if (value) {
      this.logger.debug(`🔄 Processamento iniciado`);
    } else {
      this.logger.debug(`✅ Processamento finalizado`);
    }
  }

  setPendingTranscription(text: string, callId?: string): void {
    const state = this.getState(callId);
    state.pendingTranscription = text;
  }

  appendPendingTranscription(text: string, callId?: string): string {
    const state = this.getState(callId);
    const existing = state.pendingTranscription;
    const combined = existing ? `${existing} ${text}`.trim() : text;
    state.pendingTranscription = combined;
    return combined;
  }

  clearPendingTranscription(callId?: string): string {
    const state = this.getState(callId);
    const text = state.pendingTranscription;
    state.pendingTranscription = '';
    return text;
  }

  setContinuationDetected(value: boolean, callId?: string): void {
    const state = this.getState(callId);
    state.continuationDetected = value;
    
    if (value) {
      this.logger.info(`🔄 Continuação detectada - usuário ainda está falando`);
    }
  }

  setShouldCancel(value: boolean, callId?: string): void {
    const state = this.getState(callId);
    state.shouldCancelProcessing = value;
    
    if (value) {
      this.logger.info(`🛑 Cancelamento solicitado`);
    }
  }

  setPlaybackStarted(value: boolean, callId?: string): void {
    const state = this.getState(callId);
    state.hasStartedPlayback = value;
    
    if (value) {
      this.logger.debug(`🔊 Playback iniciado - cancelamento não é mais possível`);
    }
  }

  setDebounceTimer(timer: NodeJS.Timeout | null, callId?: string): void {
    const state = this.getState(callId);
    
    // Limpar timer anterior se existir
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    
    state.debounceTimer = timer;
  }

  // ============================================
  // AÇÕES COMPOSTAS
  // ============================================

  /**
   * Inicia um novo turno de processamento
   * Reseta flags e marca como processando
   */
  startTurn(callId?: string): void {
    const state = this.getState(callId);
    state.isProcessing = true;
    state.hasStartedPlayback = false;
    state.shouldCancelProcessing = false;
    this.logger.debug(`🔄 Turno iniciado`);
  }

  /**
   * Finaliza o turno atual
   * Reseta todas as flags de processamento
   */
  endTurn(callId?: string): void {
    const state = this.getState(callId);
    state.isProcessing = false;
    state.hasStartedPlayback = false;
    
    // Não resetar shouldCancelProcessing e continuationDetected
    // pois podem ser usados na próxima transcrição
    
    this.logger.debug(`✅ Turno finalizado`);
  }

  /**
   * Marca continuação detectada e solicita cancelamento
   * Usado quando usuário volta a falar durante processamento
   */
  markContinuation(pendingText: string, callId?: string): void {
    const state = this.getState(callId);
    
    if (!state.shouldCancelProcessing) {
      state.shouldCancelProcessing = true;
      state.continuationDetected = true;
      state.pendingTranscription = pendingText;
      this.logger.info(`🔄 Usuário continuou falando: "${pendingText.substring(0, 30)}..." - cancelando processamento`);
    }
  }

  /**
   * Verifica se deve cancelar o processamento
   * Retorna true se cancelamento foi solicitado E playback ainda não começou
   */
  shouldCancelNow(callId?: string): boolean {
    const state = this.getState(callId);
    return state.shouldCancelProcessing && !state.hasStartedPlayback;
  }

  /**
   * Reseta flags de continuação após processar
   */
  resetContinuationFlags(callId?: string): void {
    const state = this.getState(callId);
    state.continuationDetected = false;
    state.shouldCancelProcessing = false;
  }

  /**
   * Limpa todos os recursos da sessão
   */
  clearSession(callId?: string): void {
    const id = this.resolveCallId(callId);
    const state = this.states.get(id);
    
    if (state?.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }
    
    this.states.delete(id);
    this.logger.debug(`🧹 Estado limpo para ${id}`);
  }

  /**
   * Limpa todas as sessões
   */
  clearAll(): void {
    for (const [id, state] of this.states) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
    }
    this.states.clear();
    this.singleSessionId = null;
    this.logger.debug(`🧹 Todos os estados limpos`);
  }
}

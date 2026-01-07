/**
 * StreamingVoiceAgent - Orquestrador de voz com streaming
 * 
 * Responsável por:
 * - Pipeline de streaming: LLM gera texto → TTS gera áudio → reproduz imediatamente
 * - Menor latência possível (Time to First Audio)
 * - Suporte a barge-in (interrupção)
 * - Métricas de latência detalhadas
 */

import { EventEmitter } from 'events';
import {
  VoiceAgentConfig,
  CallSession,
  ConversationTurn,
  TurnMetrics,
  FillerContext,
  CallSummary,
  LatencyBreakdown,
  ITranscriber,
  ILLM,
  ITTS,
  IFillerManager,
  IMetricsCollector,
} from '../types';
import { Logger } from '../utils/Logger';
import { LocalAudioProvider } from '../providers/LocalAudioProvider';

// Configurações de streaming
const STREAMING_CONFIG = {
  MIN_CHARS_FOR_TTS: 15,          // Mínimo de caracteres antes de enviar para TTS
  SENTENCE_DELIMITERS: ['.', '!', '?', ':', ';', ','], // Delimitadores de frase
  MAX_BUFFER_CHARS: 50,           // Máximo de caracteres no buffer antes de forçar flush
};

interface StreamingVoiceAgentConfig {
  transcriber: ITranscriber;
  llm: ILLM;
  tts: ITTS;
  fillerManager?: IFillerManager;
  metrics?: IMetricsCollector;
  systemPrompt: string;
  localProvider: LocalAudioProvider;
}

interface StreamingMetrics {
  turnId: string;
  sttStart: number;
  sttEnd: number;
  llmStart: number;
  llmFirstToken: number;
  ttsStart: number;
  ttsFirstChunk: number;
  playbackStart: number;
  playbackEnd: number;
  totalTokens: number;
  interrupted: boolean;
}

export class StreamingVoiceAgent extends EventEmitter {
  private config: StreamingVoiceAgentConfig;
  private logger: Logger;
  private activeSessions: Map<string, CallSession> = new Map();
  private currentMetrics: StreamingMetrics | null = null;
  private isProcessing: boolean = false;
  private isGreetingInProgress: boolean = false; // Bloqueia processamento durante saudação
  private useStreamingSTT: boolean = false; // Usa STT em streaming (Scribe)

  constructor(config: StreamingVoiceAgentConfig) {
    super();
    this.config = config;
    this.logger = new Logger('StreamingAgent');
    
    // Detectar se o transcriber suporta streaming
    this.useStreamingSTT = !!(
      this.config.transcriber.startStream &&
      this.config.transcriber.feedAudio &&
      this.config.transcriber.onTranscript
    );
    
    if (this.useStreamingSTT) {
      this.logger.info('🚀 Modo STT: Streaming (ElevenLabs Scribe)');
    } else {
      this.logger.info('📦 Modo STT: Batch (OpenAI Whisper)');
    }
  }

  /**
   * Inicia uma sessão de conversa local
   */
  async startLocalSession(prospectData?: { name?: string; company?: string }): Promise<string> {
    const callId = await this.config.localProvider.makeCall('+5511999999999');
    
    const session: CallSession = {
      id: callId,
      phoneNumber: 'local',
      prospectName: prospectData?.name,
      companyName: prospectData?.company,
      startedAt: new Date(),
      status: 'active',
      conversationHistory: [],
      metrics: {
        totalDuration: 0,
        turns: [],
        averageLatency: { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 },
        peakLatency: { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 },
        fillersUsed: 0,
        transcriptionErrors: 0,
      },
    };

    this.activeSessions.set(callId, session);
    
    // Configurar modo de VAD baseado no tipo de STT
    if (this.useStreamingSTT) {
      // MODO STREAMING (Scribe): VAD externo, chunks enviados diretamente
      this.config.localProvider.setVADMode('external');
      
      // Iniciar stream do transcriber
      await this.config.transcriber.startStream!(callId);
      
      // Callback para chunks de áudio - envia diretamente para o Scribe
      this.config.localProvider.onAudioChunk(callId, (chunk: Buffer) => {
        if (!this.isGreetingInProgress) {
          this.config.transcriber.feedAudio!(callId, chunk);
        }
      });
      
      // Callback para transcrições finais do Scribe
      this.config.transcriber.onTranscript!(callId, async (result) => {
        if (!this.isGreetingInProgress && !this.isProcessing) {
          await this.processTranscription(callId, result);
        }
      });
      
      // Callback para transcrições parciais (opcional, para feedback)
      if (this.config.transcriber.onPartialTranscript) {
        this.config.transcriber.onPartialTranscript(callId, (text) => {
          this.emit('partial:transcript', callId, text);
        });
      }
    } else {
      // MODO BATCH (Whisper): VAD interno, áudio acumulado
      this.config.localProvider.setVADMode('internal');
      
      // Callback de áudio após VAD detectar fim da fala
      this.config.localProvider.onAudioReceived(callId, async (audio: Buffer) => {
        await this.processStreamingTurn(callId, audio);
      });
    }

    // Listener para barge-in
    this.config.localProvider.on('playback:interrupted', () => {
      if (this.currentMetrics) {
        this.currentMetrics.interrupted = true;
      }
      this.logger.info('🔇 Reprodução interrompida pelo usuário');
    });

    // Iniciar gravação
    await this.config.localProvider.startRecording(callId);

    this.emit('session:started', callId);
    this.logger.info(`✅ Sessão ${callId} iniciada - Fale algo!`);

    // Gerar saudação inicial (bloqueia processamento de áudio)
    this.isGreetingInProgress = true;
    await this.generateGreeting(callId);
    this.isGreetingInProgress = false;

    return callId;
  }

  /**
   * Gera saudação inicial
   */
  private async generateGreeting(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) return;

    this.logger.info('🎤 Gerando saudação inicial...');

    const greetingPrompt = this.buildLLMMessages(session);
    
    // Gerar saudação com streaming
    await this.streamLLMToTTS(callId, greetingPrompt, session);
  }

  /**
   * Toca um filler GENÉRICO imediatamente (antes de saber o que o usuário disse)
   * Usado em paralelo com STT para dar feedback instantâneo
   */
  private async playFillerGeneric(callId: string, session: CallSession): Promise<void> {
    if (!this.config.fillerManager) {
      return; // Fillers não configurados
    }

    try {
      const conversationStage = this.detectConversationStage(session);
      
      // Usar filler genérico (não sabemos ainda o que o usuário disse)
      const filler = this.config.fillerManager.getFiller({
        conversationStage,
        prospectName: session.prospectName,
        // Sem lastUserMessage - força filler genérico
      });

      if (filler) {
        this.logger.info(`🎵 Tocando filler: "${filler.text}"`);
        await this.config.localProvider.sendAudio(callId, filler.audioBuffer);
        session.metrics.fillersUsed++;
      }
    } catch (error) {
      // Falha no filler não deve interromper o fluxo
      this.logger.warn('Erro ao tocar filler:', error);
    }
  }

  /**
   * Detecta o estágio da conversa baseado no histórico
   */
  private detectConversationStage(session: CallSession): 'intro' | 'qualifying' | 'presenting' | 'closing' {
    const turns = session.conversationHistory.length;
    
    if (turns <= 2) return 'intro';
    if (turns <= 6) return 'qualifying';
    if (turns <= 12) return 'presenting';
    return 'closing';
  }

  /**
   * Processa um turno de conversa com streaming completo
   */
  async processStreamingTurn(callId: string, userAudio: Buffer): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }

    // Ignorar áudio durante a saudação inicial
    if (this.isGreetingInProgress) {
      this.logger.debug('Saudação em andamento, ignorando áudio...');
      return;
    }

    // Ignorar áudio enquanto o agente está falando (evita processar enquanto reproduz)
    if (this.config.localProvider.isCurrentlyPlaying()) {
      this.logger.debug('Agente ainda falando, ignorando áudio...');
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Já processando, ignorando...');
      return;
    }

    this.isProcessing = true;
    const turnId = `turn-${Date.now()}`;

    // Inicializar métricas
    this.currentMetrics = {
      turnId,
      sttStart: Date.now(),
      sttEnd: 0,
      llmStart: 0,
      llmFirstToken: 0,
      ttsStart: 0,
      ttsFirstChunk: 0,
      playbackStart: 0,
      playbackEnd: 0,
      totalTokens: 0,
      interrupted: false,
    };

    try {
      // ============================================
      // FASE 0: Tocar filler IMEDIATAMENTE (em paralelo com STT)
      // Isso dá feedback instantâneo ao usuário
      // ============================================
      const fillerPromise = this.playFillerGeneric(callId, session);

      // ============================================
      // FASE 1: Speech-to-Text (em paralelo com filler)
      // ============================================
      this.logger.info('📝 Transcrevendo...');
      
      const transcription = await this.config.transcriber.transcribe(userAudio);
      this.currentMetrics.sttEnd = Date.now();
      
      const sttDuration = this.currentMetrics.sttEnd - this.currentMetrics.sttStart;
      this.logger.info(`📝 STT (${sttDuration}ms): "${transcription.text}"`);

      // Esperar filler terminar antes de continuar
      await fillerPromise;

      // Validar transcrição
      if (!transcription.text || transcription.text.trim().length < 2) {
        this.logger.warn('Transcrição muito curta, ignorando turno');
        this.isProcessing = false;
        return;
      }

      // Adicionar ao histórico
      session.conversationHistory.push({
        role: 'user',
        content: transcription.text,
        timestamp: new Date(),
      });

      this.emit('user:spoke', callId, transcription.text);

      // ============================================
      // FASE 2: LLM Streaming → TTS Streaming → Play
      // ============================================
      const messages = this.buildLLMMessages(session);
      await this.streamLLMToTTS(callId, messages, session);

      // ============================================
      // FASE 3: Calcular métricas
      // ============================================
      this.currentMetrics.playbackEnd = Date.now();
      this.recordTurnMetrics(session);

    } catch (error) {
      this.logger.error(`Erro no turno ${turnId}:`, error);
      this.emit('error', error, `turn:${turnId}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Processa uma transcrição já pronta (modo streaming - Scribe)
   * Pula a etapa de STT pois o Scribe já transcreveu via streaming
   */
  async processTranscription(callId: string, transcription: { text: string; language?: string; duration?: number }): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }

    // Ignorar durante saudação
    if (this.isGreetingInProgress) {
      return;
    }

    // Ignorar enquanto agente fala
    if (this.config.localProvider.isCurrentlyPlaying()) {
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Já processando, ignorando...');
      return;
    }

    this.isProcessing = true;
    const turnId = `turn-${Date.now()}`;

    // Métricas - STT já aconteceu via streaming
    this.currentMetrics = {
      turnId,
      sttStart: Date.now() - (transcription.duration || 0), // Estimar início
      sttEnd: Date.now(),
      llmStart: 0,
      llmFirstToken: 0,
      ttsStart: 0,
      ttsFirstChunk: 0,
      playbackStart: 0,
      playbackEnd: 0,
      totalTokens: 0,
      interrupted: false,
    };

    const sttDuration = transcription.duration || 0;
    this.logger.info(`📝 STT Scribe (${sttDuration}ms): "${transcription.text}"`);

    try {
      // Tocar filler enquanto LLM gera resposta
      const fillerPromise = this.playFillerGeneric(callId, session);

      // Validar transcrição
      if (!transcription.text || transcription.text.trim().length < 2) {
        this.logger.warn('Transcrição muito curta, ignorando turno');
        this.isProcessing = false;
        return;
      }

      // Adicionar ao histórico
      session.conversationHistory.push({
        role: 'user',
        content: transcription.text,
        timestamp: new Date(),
      });

      this.emit('user:spoke', callId, transcription.text);

      // Esperar filler terminar
      await fillerPromise;

      // LLM → TTS → Play
      const messages = this.buildLLMMessages(session);
      await this.streamLLMToTTS(callId, messages, session);

      // Métricas
      this.currentMetrics.playbackEnd = Date.now();
      this.recordTurnMetrics(session);

    } catch (error) {
      this.logger.error(`Erro no turno ${turnId}:`, error);
      this.emit('error', error, `turn:${turnId}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Gera resposta do LLM e sintetiza TTS com streaming
   * Usa buffer inteligente para evitar chiados (preenche com silêncio se necessário)
   */
  private async streamLLMToTTS(
    callId: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    session: CallSession
  ): Promise<void> {
    if (!this.currentMetrics) {
      this.currentMetrics = {
        turnId: `greeting-${Date.now()}`,
        sttStart: Date.now(),
        sttEnd: Date.now(),
        llmStart: Date.now(),
        llmFirstToken: 0,
        ttsStart: 0,
        ttsFirstChunk: 0,
        playbackStart: 0,
        playbackEnd: 0,
        totalTokens: 0,
        interrupted: false,
      };
    }

    this.currentMetrics.llmStart = Date.now();
    
    let fullResponse = '';
    let isFirstAudio = true;

    this.logger.info('🤖 Gerando resposta com streaming...');
    
    // Gerar texto do LLM
    const response = await this.config.llm.generate(messages, { maxTokens: 150 });
    fullResponse = response.text;
    
    this.currentMetrics.llmFirstToken = Date.now();
    const llmDuration = this.currentMetrics.llmFirstToken - this.currentMetrics.llmStart;
    this.logger.info(`✅ LLM (${llmDuration}ms): "${fullResponse.substring(0, 50)}..."`);

    // Checar se foi interrompido
    if (this.currentMetrics?.interrupted) {
      return;
    }

    // Sintetizar com streaming
    this.currentMetrics.ttsStart = Date.now();
    this.logger.info('🔊 Sintetizando com streaming...');
    
    // Resetar estado de interrupção para permitir nova reprodução
    this.currentMetrics.interrupted = false;
    this.config.localProvider.resetInterruptState();
    
    try {
      if (!this.config.tts.synthesizeStream) {
        throw new Error('TTS não suporta streaming');
      }
      await this.config.tts.synthesizeStream(fullResponse, async (audioChunk: Buffer) => {
        if (this.currentMetrics?.interrupted) return;

        if (isFirstAudio) {
          this.currentMetrics!.ttsFirstChunk = Date.now();
          this.currentMetrics!.playbackStart = Date.now();
          
          const timeToFirstAudio = this.currentMetrics!.ttsFirstChunk - this.currentMetrics!.llmStart;
          this.logger.info(`⚡ Time to First Audio: ${timeToFirstAudio}ms`);
          isFirstAudio = false;
        }

        // Enviar para buffer de streaming (com preenchimento de silêncio se necessário)
        await this.config.localProvider.sendAudioStream(callId, audioChunk);
      });
    } catch (error) {
      this.logger.error('Erro no TTS streaming:', error);
      // Fallback para batch
      const ttsResult = await this.config.tts.synthesize(fullResponse);
      await this.config.localProvider.sendAudio(callId, ttsResult.audioBuffer);
    }

    // Finalizar streaming
    this.config.localProvider.endAudioStream();
    
    // Adicionar resposta ao histórico
    session.conversationHistory.push({
      role: 'agent',
      content: fullResponse,
      timestamp: new Date(),
    });

    this.logger.info(`🤖 Resposta: "${fullResponse.substring(0, 80)}${fullResponse.length > 80 ? '...' : ''}"`);
    this.emit('agent:spoke', callId, fullResponse);
  }

  /**
   * Decide se deve enviar o buffer atual para TTS
   */
  private shouldFlushToTTS(buffer: string, lastChunk: string): boolean {
    // Se buffer atingiu tamanho máximo
    if (buffer.length >= STREAMING_CONFIG.MAX_BUFFER_CHARS) {
      return true;
    }

    // Se buffer tem tamanho mínimo E termina com delimitador
    if (buffer.length >= STREAMING_CONFIG.MIN_CHARS_FOR_TTS) {
      const lastChar = buffer.trim().slice(-1);
      if (STREAMING_CONFIG.SENTENCE_DELIMITERS.includes(lastChar)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Constrói mensagens para o LLM
   */
  private buildLLMMessages(session: CallSession): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    let systemPrompt = this.config.systemPrompt
      .replace('{prospectName}', session.prospectName || 'Cliente')
      .replace('{companyName}', session.companyName || 'empresa')
      .replace('{context}', this.generateContext(session));

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Adicionar histórico recente
    const recentHistory = session.conversationHistory.slice(-10);
    for (const turn of recentHistory) {
      messages.push({
        role: turn.role === 'agent' ? 'assistant' : 'user',
        content: turn.content,
      });
    }

    return messages;
  }

  /**
   * Gera contexto dinâmico
   */
  private generateContext(session: CallSession): string {
    const turnCount = session.conversationHistory.length;
    const duration = Date.now() - session.startedAt.getTime();

    let context = `Turno ${turnCount + 1}. Duração: ${Math.round(duration / 1000)}s. `;

    if (turnCount === 0) {
      context += 'Abertura - apresente-se brevemente.';
    } else if (turnCount < 4) {
      context += 'Introdução - descubra interesse.';
    } else if (turnCount < 8) {
      context += 'Qualificação - entenda necessidades.';
    } else {
      context += 'Fechamento - próximo passo.';
    }

    return context;
  }

  /**
   * Registra métricas do turno
   */
  private recordTurnMetrics(session: CallSession): void {
    if (!this.currentMetrics) return;

    const m = this.currentMetrics;
    
    const latency: LatencyBreakdown = {
      stt: m.sttEnd - m.sttStart,
      llm: (m.llmFirstToken || m.playbackEnd) - m.llmStart,
      tts: m.ttsFirstChunk ? m.ttsFirstChunk - m.ttsStart : 0,
      total: m.playbackEnd - m.sttStart,
      timeToFirstAudio: m.playbackStart ? m.playbackStart - m.sttStart : 0,
    };

    const turnMetrics: TurnMetrics = {
      turnId: m.turnId,
      timestamp: new Date(),
      latency,
      audioInputDuration: 0,
      audioOutputDuration: 0,
      fillerUsed: false,
    };

    session.metrics.turns.push(turnMetrics);
    this.updateAggregateMetrics(session);

    // Log métricas
    this.logger.info('📊 Métricas do turno:');
    this.logger.info(`   STT: ${latency.stt}ms | LLM: ${latency.llm}ms | TTS: ${latency.tts}ms`);
    this.logger.info(`   ⚡ Time to First Audio: ${latency.timeToFirstAudio}ms`);
    this.logger.info(`   Total: ${latency.total}ms ${m.interrupted ? '(interrompido)' : ''}`);

    this.emit('metrics', m.turnId, latency);
  }

  /**
   * Atualiza métricas agregadas
   */
  private updateAggregateMetrics(session: CallSession): void {
    const turns = session.metrics.turns;
    if (turns.length === 0) return;

    const sum = turns.reduce(
      (acc, t) => ({
        stt: acc.stt + t.latency.stt,
        llm: acc.llm + t.latency.llm,
        tts: acc.tts + t.latency.tts,
        total: acc.total + t.latency.total,
        timeToFirstAudio: acc.timeToFirstAudio + t.latency.timeToFirstAudio,
      }),
      { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 }
    );

    session.metrics.averageLatency = {
      stt: Math.round(sum.stt / turns.length),
      llm: Math.round(sum.llm / turns.length),
      tts: Math.round(sum.tts / turns.length),
      total: Math.round(sum.total / turns.length),
      timeToFirstAudio: Math.round(sum.timeToFirstAudio / turns.length),
    };
  }

  /**
   * Encerra a sessão
   */
  async endSession(callId: string): Promise<CallSummary | null> {
    const session = this.activeSessions.get(callId);
    if (!session) return null;

    session.status = 'ended';
    session.endedAt = new Date();
    session.metrics.totalDuration = session.endedAt.getTime() - session.startedAt.getTime();

    await this.config.localProvider.endCall(callId);

    const summary: CallSummary = {
      callId,
      duration: session.metrics.totalDuration,
      turns: session.conversationHistory.length,
      outcome: 'not_interested',
      metrics: session.metrics,
      transcript: session.conversationHistory,
    };

    this.activeSessions.delete(callId);
    this.emit('session:ended', callId, summary);

    this.logger.info('📊 Resumo da sessão:');
    this.logger.info(`   Duração: ${Math.round(summary.duration / 1000)}s`);
    this.logger.info(`   Turnos: ${summary.turns}`);
    this.logger.info(`   Latência média: STT=${session.metrics.averageLatency.stt}ms, LLM=${session.metrics.averageLatency.llm}ms`);
    this.logger.info(`   Time to First Audio médio: ${session.metrics.averageLatency.timeToFirstAudio}ms`);

    return summary;
  }

  /**
   * Retorna sessão ativa
   */
  getSession(callId: string): CallSession | undefined {
    return this.activeSessions.get(callId);
  }
}

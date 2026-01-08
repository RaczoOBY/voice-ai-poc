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
  TranscriptionResult,
  STTTimingMetrics,
} from '../types';
import { Logger } from '../utils/Logger';
import { LocalAudioProvider } from '../providers/LocalAudioProvider';
import { ContextualFillerManager } from './ContextualFillerManager';
import { LatencyAnalyzer } from '../utils/LatencyAnalyzer';
import { CallRecorder } from '../utils/CallRecorder';
import { AudioRoom } from '../utils/AudioRoom';
import { config as appConfig, generatePhaseContext } from '../config';
import { ThinkingEngine } from './ThinkingEngine';

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
  // Métricas detalhadas do STT (separadas de speechDuration e vadDelay)
  sttTimingMetrics?: STTTimingMetrics;
}

export class StreamingVoiceAgent extends EventEmitter {
  private config: StreamingVoiceAgentConfig;
  private logger: Logger;
  private activeSessions: Map<string, CallSession> = new Map();
  private currentMetrics: StreamingMetrics | null = null;
  private isProcessing: boolean = false;
  private isGreetingInProgress: boolean = false; // Bloqueia processamento durante saudação
  private useStreamingSTT: boolean = false; // Usa STT em streaming (Scribe)
  private contextualFillerManager: ContextualFillerManager | null = null; // Fillers contextualizados (desabilitados por enquanto)
  private wasInterrupted: boolean = false; // Flag para indicar que houve barge-in
  private bargeInTimestamp: number = 0; // Timestamp do último barge-in
  private static readonly BARGE_IN_GRACE_PERIOD_MS = 800; // Ignorar transcrições por 800ms após barge-in
  private pendingTranscriptionCallId: string | null = null; // CallId da transcrição que está sendo processada
  
  // Pré-processamento com transcrições parciais
  private lastPartialText: string = '';
  private lastPartialTime: number = 0;
  private prebuiltLLMContext: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | null = null;
  private partialSentenceComplete: boolean = false; // Indica se detectamos fim de frase na parcial

  // Gravação de chamadas
  private callRecorder: CallRecorder | null = null;
  private audioRoom: AudioRoom | null = null;

  // Engine de pensamentos internos (opcional - controlado por ENABLE_THINKING_ENGINE)
  private thinkingEngine: ThinkingEngine | null = null;

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
      
      // Inicializar gerador de fillers contextualizados
      this.contextualFillerManager = new ContextualFillerManager({
        llm: this.config.llm,
        tts: this.config.tts,
        useQuickLLM: false, // Usar templates (mais rápido). Mude para true para LLM
      });
      this.logger.info('🎯 Fillers contextualizados habilitados');
    } else {
      this.logger.info('📦 Modo STT: Batch (OpenAI Whisper)');
    }

    // Inicializar engine de pensamentos internos (se habilitado)
    if (appConfig.thinkingEngine.enabled) {
      this.thinkingEngine = new ThinkingEngine({
        llm: this.config.llm,
      });
      this.logger.info('🧠 ThinkingEngine habilitado (ENABLE_THINKING_ENGINE=true)');
    } else {
      this.logger.info('💭 ThinkingEngine desabilitado (ENABLE_THINKING_ENGINE=false)');
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
      prospectName: prospectData?.name || undefined, // Não definir nome inicialmente - será coletado
      companyName: prospectData?.company || undefined,
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
      internalThoughts: [], // Inicializar array de pensamentos internos
    };

    this.activeSessions.set(callId, session);
    
    // Inicializar gravador de chamadas (para transcrições)
    this.callRecorder = new CallRecorder(callId);
    this.callRecorder.start();
    
    // Inicializar AudioRoom (para gravação de áudio mixada)
    const recordingPath = this.callRecorder.getRecordingFolder();
    if (recordingPath) {
      this.audioRoom = new AudioRoom();
      this.audioRoom.start(`${recordingPath}/call_recording.wav`);
    }
    
    // Configurar modo de VAD baseado no tipo de STT
    if (this.useStreamingSTT) {
      // MODO STREAMING (Scribe): VAD externo, chunks enviados diretamente
      this.config.localProvider.setVADMode('external');
      
      // Iniciar stream do transcriber com retry em caso de erro
      try {
        await this.config.transcriber.startStream!(callId);
      } catch (error) {
        this.logger.error('❌ Erro ao iniciar Scribe, tentando reconectar...', error);
        // Tentar reconectar após 1 segundo
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          await this.config.transcriber.startStream!(callId);
          this.logger.info('✅ Reconectado ao Scribe após erro');
        } catch (retryError) {
          this.logger.error('❌ Falha ao reconectar Scribe:', retryError);
          throw retryError;
        }
      }
      
      // Callback para chunks de áudio - envia diretamente para o Scribe
      this.config.localProvider.onAudioChunk(callId, (chunk: Buffer) => {
        // Gravar áudio do usuário no AudioRoom
        if (this.audioRoom) {
          this.audioRoom.feedUserAudio(chunk);
        }
        
        if (!this.isGreetingInProgress) {
          // Verificar se Scribe ainda está conectado antes de enviar
          if (this.config.transcriber.feedAudio) {
            // Verificar conexão antes de enviar (se método disponível)
            const scribe = this.config.transcriber as any;
            if (scribe.isStreamConnected && !scribe.isStreamConnected()) {
              this.logger.warn('⚠️ Scribe desconectado, tentando reconectar...');
              // Tentar reconectar em background (não bloquear)
              this.config.transcriber.startStream!(callId).catch(err => {
                this.logger.error('Erro ao reconectar Scribe:', err);
              });
              return;
            }
            this.config.transcriber.feedAudio(callId, chunk);
          } else {
            this.logger.warn('⚠️ Scribe feedAudio não disponível - chunks não serão enviados');
          }
        }
      });
      
      // Callback para transcrições finais do Scribe
      this.config.transcriber.onTranscript!(callId, async (result) => {
        if (!this.isGreetingInProgress && !this.isProcessing) {
          this.logger.debug(`📝 Recebida transcrição do Scribe: "${result.text}"`);
          await this.processTranscription(callId, result);
        } else {
          this.logger.debug(`⚠️ Transcrição ignorada - greeting: ${this.isGreetingInProgress}, processing: ${this.isProcessing}`);
        }
      });
      
      // Listener para erros do Scribe (se EventEmitter)
      const scribe = this.config.transcriber as any;
      if (scribe.on && typeof scribe.on === 'function') {
        scribe.on('error', (error: Error) => {
          this.logger.error('❌ Erro do Scribe:', error);
          // Tentar reconectar automaticamente
          if (!this.isGreetingInProgress) {
            this.logger.info('🔄 Tentando reconectar Scribe...');
            this.config.transcriber.startStream!(callId).catch(err => {
              this.logger.error('Erro ao reconectar Scribe:', err);
            });
          }
        });
      }
      
      // Callback para transcrições parciais - com pré-processamento para menor latência
      if (this.config.transcriber.onPartialTranscript) {
        this.config.transcriber.onPartialTranscript(callId, (text) => {
          this.emit('partial:transcript', callId, text);
          
          // Pré-processamento: detectar possível fim de frase e pré-construir contexto LLM
          if (!this.isProcessing && !this.isGreetingInProgress && text.length > 5) {
            this.handlePartialTranscriptForPreprocessing(callId, text);
          }
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
    this.config.localProvider.on('playback:interrupted', (interruptedCallId: string) => {
      this.wasInterrupted = true;
      this.bargeInTimestamp = Date.now();
      
      if (this.currentMetrics) {
        this.currentMetrics.interrupted = true;
      }
      
      this.logger.info('🔇 Barge-in detectado - cancelando TODOS os processamentos');
      
      // Interromper gravação do agente no AudioRoom (descartar segmento atual)
      if (this.audioRoom) {
        this.audioRoom.interruptAgent();
      }
      
      // IMPORTANTE: Resetar timers de latência do STT para métricas corretas
      // Isso evita que o tempo de áudio enviado durante fala do agente seja contado como latência
      const scribe = this.config.transcriber as any;
      if (scribe.resetTimingOnBargeIn) {
        scribe.resetTimingOnBargeIn();
      }
      if (scribe.setAgentSpeaking) {
        scribe.setAgentSpeaking(false); // Agente parou de falar (foi interrompido)
      }
      
      // Cancelar processamento atual se estiver em andamento
      if (this.isProcessing) {
        this.logger.warn('⚠️ Cancelando processamento em andamento devido a barge-in');
        this.isProcessing = false;
      }
      
      // Se houver transcrição pendente, marcar para ignorar
      if (this.pendingTranscriptionCallId) {
        this.logger.warn(`⚠️ Ignorando transcrição pendente de ${this.pendingTranscriptionCallId} devido a barge-in`);
        this.pendingTranscriptionCallId = null;
      }
      
      // Auto-reset do flag após grace period
      setTimeout(() => {
        if (this.bargeInTimestamp > 0 && Date.now() - this.bargeInTimestamp >= StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS) {
          this.wasInterrupted = false;
          this.bargeInTimestamp = 0;
          this.logger.debug('✅ Flag de barge-in auto-resetada após grace period');
        }
      }, StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS + 100);
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
   * Gera saudação inicial - Simula ligação de vendas
   * Primeiro coleta o nome, depois se apresenta
   */
  private async generateGreeting(callId: string): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) return;

    this.logger.info('📞 Gerando abertura da ligação...');

    // Usar prompt de saudação do config
    const greetingPrompt = appConfig.agent.greetingPrompt
      .replace('{prospectName}', session.prospectName || 'Ainda não coletado - você precisa perguntar')
      .replace('{companyName}', session.companyName || 'Não informada');

    const greetingMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: greetingPrompt },
    ];

    // Gerar saudação com streaming
    await this.streamLLMToTTS(callId, greetingMessages, session);
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
   * Pré-processa transcrições parciais para reduzir latência
   * Detecta padrões de fim de frase e pré-constrói contexto do LLM
   */
  private handlePartialTranscriptForPreprocessing(callId: string, partialText: string): void {
    const now = Date.now();
    const session = this.activeSessions.get(callId);
    if (!session) return;

    // Detectar se parece fim de frase (pontuação ou pausa)
    const trimmedText = partialText.trim();
    const endsWithPunctuation = /[.!?]$/.test(trimmedText);
    const timeSinceLastPartial = now - this.lastPartialTime;
    const hasSignificantPause = this.lastPartialTime > 0 && timeSinceLastPartial > 200;
    
    // Atualizar estado da transcrição parcial
    this.lastPartialText = trimmedText;
    this.lastPartialTime = now;

    // Se detectamos possível fim de frase, pré-construir contexto do LLM
    if ((endsWithPunctuation || hasSignificantPause) && trimmedText.length >= 10) {
      // Criar cópia temporária do histórico com a transcrição parcial
      const tempHistory = [...session.conversationHistory];
      tempHistory.push({
        role: 'user',
        content: trimmedText,
        timestamp: new Date(),
      });

      // Construir mensagens para o LLM usando histórico temporário
      const tempSession = { ...session, conversationHistory: tempHistory };
      this.prebuiltLLMContext = this.buildLLMMessages(tempSession);
      this.partialSentenceComplete = true;
      
      this.logger.debug(`⚡ Pré-processamento: contexto LLM pré-construído para "${trimmedText.substring(0, 30)}..."`);
    }
  }

  /**
   * Reseta estado de pré-processamento
   */
  private resetPreprocessingState(): void {
    this.lastPartialText = '';
    this.lastPartialTime = 0;
    this.prebuiltLLMContext = null;
    this.partialSentenceComplete = false;
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
      // FASE 1: Speech-to-Text
      // ============================================
      this.logger.info('📝 Transcrevendo...');
      
      const transcription = await this.config.transcriber.transcribe(userAudio);
      this.currentMetrics.sttEnd = Date.now();
      
      const sttDuration = this.currentMetrics.sttEnd - this.currentMetrics.sttStart;
      this.logger.info(`📝 STT (${sttDuration}ms): "${transcription.text}"`);

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
  async processTranscription(callId: string, transcription: TranscriptionResult): Promise<void> {
    const session = this.activeSessions.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }

    // Ignorar durante saudação
    if (this.isGreetingInProgress) {
      return;
    }

    // Verificar se houve barge-in ANTES de qualquer processamento
    // Usar timestamp para garantir que o grace period seja respeitado
    const timeSinceBargeIn = Date.now() - this.bargeInTimestamp;
    if (this.wasInterrupted && timeSinceBargeIn < StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS) {
      this.logger.debug(`⚠️ Ignorando transcrição devido a barge-in recente (${timeSinceBargeIn}ms atrás)`);
      return;
    }
    
    // Resetar flag se passou o grace period
    if (this.wasInterrupted && timeSinceBargeIn >= StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS) {
      this.wasInterrupted = false;
      this.bargeInTimestamp = 0;
      this.logger.debug('✅ Flag de barge-in resetada (grace period expirado)');
    }

    // Ignorar enquanto agente fala (a menos que tenha sido interrompido)
    if (this.config.localProvider.isCurrentlyPlaying()) {
      this.logger.debug('Agente ainda falando, ignorando transcrição...');
      return;
    }

    if (this.isProcessing) {
      this.logger.debug('Já processando, ignorando...');
      return;
    }
    
    // Verificação adicional: se houve barge-in durante o check acima, cancelar
    if (this.wasInterrupted) {
      this.logger.debug('⚠️ Barge-in detectado durante verificação, cancelando');
      return;
    }

    // Marcar transcrição como pendente
    this.pendingTranscriptionCallId = callId;
    this.isProcessing = true;
    const turnId = `turn-${Date.now()}`;

    // Métricas - STT já aconteceu via streaming
    // Usar métricas detalhadas do Scribe se disponíveis
    const timingMetrics = transcription.timingMetrics;
    const sttRealLatency = timingMetrics?.realLatency || transcription.duration || 0;
    
    // IMPORTANTE: sttEnd = momento atual (quando a transcrição final chegou)
    // Isso é o ponto de referência para Time to First Audio
    const now = Date.now();
    
    this.currentMetrics = {
      turnId,
      sttStart: timingMetrics?.startTime || now - sttRealLatency,
      sttEnd: now, // Momento que a transcrição final chegou (início do processamento LLM)
      llmStart: 0,
      llmFirstToken: 0,
      ttsStart: 0,
      ttsFirstChunk: 0,
      playbackStart: 0,
      playbackEnd: 0,
      totalTokens: 0,
      interrupted: false,
      sttTimingMetrics: timingMetrics, // Guardar métricas detalhadas
    };

    const transcriptText = transcription.text.trim();
    
    // Ignorar apenas transcrições extremamente curtas (ruído)
    // Respostas de 1 palavra como "Sim", "Não", "Isso", "Ok" são válidas
    if (transcriptText.length < 2) {
      this.logger.debug(`Ignorando transcrição muito curta: "${transcriptText}"`);
      this.isProcessing = false;
      this.pendingTranscriptionCallId = null;
      return;
    }
    
    // Log com métricas separadas
    if (timingMetrics) {
      this.logger.info(`📝 STT Scribe:`);
      this.logger.info(`   ⚡ Latência REAL: ${timingMetrics.realLatency}ms (target: <300ms)`);
      this.logger.info(`   🗣️ Duração da fala: ${timingMetrics.speechDuration}ms (não é latência)`);
      this.logger.info(`   ⏱️ VAD wait: ${timingMetrics.vadWaitTime}ms`);
      this.logger.info(`   📝 Texto: "${transcriptText}"`);
    } else {
      this.logger.info(`📝 STT Scribe (${sttRealLatency}ms): "${transcriptText}"`);
    }

    try {
      // Verificar barge-in novamente antes de processar (pode ter acontecido durante validação)
      if (this.wasInterrupted) {
        this.logger.debug('⚠️ Barge-in detectado antes de processar, cancelando');
        this.isProcessing = false;
        this.pendingTranscriptionCallId = null;
        return;
      }

      // Fillers genéricos desabilitados - causavam pausas estranhas
      // Apenas fillers contextuais (baseados em transcrições parciais) são usados

      // Adicionar ao histórico (já validado acima)
      session.conversationHistory.push({
        role: 'user',
        content: transcriptText,
        timestamp: new Date(),
      });
      
      // Gravar transcrição do usuário
      if (this.callRecorder) {
        this.callRecorder.addTranscriptEntry('user', transcriptText);
      }

      // Tentar extrair nome se ainda não tiver coletado
      if (!session.prospectName || session.prospectName === 'Visitante' || session.prospectName.length < 2) {
        this.logger.debug(`🔍 Tentando extrair nome de: "${transcriptText}"`);
        const extractedName = this.extractNameFromResponse(transcriptText);
        if (extractedName) {
          session.prospectName = extractedName;
          this.logger.info(`✅ Nome coletado: ${extractedName}`);
        } else {
          this.logger.debug(`⚠️ Nome não extraído de: "${transcriptText}"`);
        }
      }

      this.emit('user:spoke', callId, transcriptText);

      // Verificar barge-in antes de gerar resposta
      if (this.wasInterrupted) {
        this.logger.debug('⚠️ Barge-in detectado antes de gerar resposta, cancelando');
        this.isProcessing = false;
        this.pendingTranscriptionCallId = null;
        this.resetPreprocessingState();
        return;
      }

      // LLM → TTS → Play
      // Usar contexto pré-construído se disponível e texto for similar
      let messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      
      if (this.prebuiltLLMContext && this.partialSentenceComplete && 
          this.lastPartialText && transcriptText.includes(this.lastPartialText.substring(0, 20))) {
        // Usar contexto pré-construído (economiza tempo de construção)
        messages = this.prebuiltLLMContext;
        // Atualizar a última mensagem do usuário com o texto final completo
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === 'user') {
          lastMessage.content = transcriptText;
        }
        this.logger.debug('⚡ Usando contexto LLM pré-construído');
      } else {
        // Construir contexto normalmente
        messages = this.buildLLMMessages(session);
      }
      
      // Resetar estado de pré-processamento
      this.resetPreprocessingState();
      
      await this.streamLLMToTTS(callId, messages, session);

      // Métricas
      this.currentMetrics.playbackEnd = Date.now();
      this.recordTurnMetrics(session);

    } catch (error) {
      this.logger.error(`Erro no turno ${turnId}:`, error);
      this.emit('error', error, `turn:${turnId}`);
    } finally {
      this.isProcessing = false;
      this.pendingTranscriptionCallId = null;
      this.resetPreprocessingState(); // Garantir reset do estado de pré-processamento
      // Flag de barge-in é resetada automaticamente após o grace period (800ms)
    }
  }

  /**
   * Gera resposta do LLM e sintetiza TTS com streaming REAL
   * 
   * FLUXO OTIMIZADO (streaming chunk por chunk):
   * 1. LLM começa a gerar texto (streaming)
   * 2. Assim que tiver uma frase/cláusula completa, envia para TTS
   * 3. TTS sintetiza e envia áudio enquanto LLM continua gerando
   * 4. Reduz Time to First Audio significativamente
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
    let llmFirstTokenTime = 0;

    this.logger.info('🤖 Gerando resposta com streaming REAL...');
    
    // Resetar estado de interrupção para permitir nova reprodução
    this.currentMetrics.interrupted = false;
    this.config.localProvider.resetInterruptState();
    
    // Notificar STT que agente vai começar a falar (para métricas corretas)
    const scribe = this.config.transcriber as any;
    if (scribe.setAgentSpeaking) {
      scribe.setAgentSpeaking(true);
    }
    
    // ===== STREAMING REAL: LLM → TTS chunk por chunk =====
    // Delimitadores de sentença/cláusula para dividir texto
    const SENTENCE_DELIMITERS = ['.', '!', '?'];
    const CLAUSE_DELIMITERS = [',', ';', ':'];
    const MIN_CHARS_FOR_TTS = 20; // Mínimo de caracteres antes de enviar para TTS (aumentado para evitar fragmentação)
    const MAX_BUFFER_CHARS = 80; // Máximo de caracteres antes de forçar envio
    
    let textBuffer = ''; // Buffer de texto acumulado do LLM
    let chunkIndex = 0;
    
    // Fila de chunks de texto para processar SEQUENCIALMENTE (evita buffer underflow)
    const textChunkQueue: { text: string; isLast: boolean }[] = [];
    let isProcessingQueue = false;
    
    // Função para processar a fila de chunks sequencialmente
    const processQueueSequentially = async (): Promise<void> => {
      if (isProcessingQueue) return; // Já está processando
      isProcessingQueue = true;
      
      while (textChunkQueue.length > 0) {
        const item = textChunkQueue.shift()!;
        await processTextChunk(item.text, item.isLast);
      }
      
      isProcessingQueue = false;
    };
    
    // Função para processar um chunk de texto no TTS
    const processTextChunk = async (text: string, isLast: boolean = false): Promise<void> => {
      if (!text.trim() || this.currentMetrics?.interrupted) return;
      
      const idx = chunkIndex++;
      this.logger.debug(`📝 TTS chunk ${idx}: "${text.substring(0, 30)}..."`);
      
      if (idx === 0) {
        this.currentMetrics!.ttsStart = Date.now();
      }
      
      try {
        if (!this.config.tts.synthesizeStream) {
          throw new Error('TTS não suporta streaming');
        }
        
        await this.config.tts.synthesizeStream(text, async (audioChunk: Buffer) => {
          if (this.currentMetrics?.interrupted) return;

          if (isFirstAudio) {
            this.currentMetrics!.ttsFirstChunk = Date.now();
            this.currentMetrics!.playbackStart = Date.now();
            
            const timeToFirstAudio = this.currentMetrics!.ttsFirstChunk - this.currentMetrics!.sttEnd;
            this.logger.info(`⚡ Time to First Audio: ${timeToFirstAudio}ms (LLM: ${llmFirstTokenTime - this.currentMetrics!.llmStart}ms)`);
            isFirstAudio = false;
          }

          // Gravar áudio do agente no AudioRoom
          if (this.audioRoom) {
            this.audioRoom.feedAgentAudio(audioChunk);
          }

          // Enviar para buffer de streaming
          await this.config.localProvider.sendAudioStream(callId, audioChunk);
        });
      } catch (error) {
        this.logger.error(`Erro no TTS chunk ${idx}:`, error);
      }
    };
    
    // Adicionar chunk à fila e processar
    const enqueueTextChunk = (text: string, isLast: boolean = false): void => {
      textChunkQueue.push({ text, isLast });
      // Iniciar processamento se não estiver rodando
      processQueueSequentially().catch(err => {
        this.logger.error('Erro ao processar fila TTS:', err);
      });
    };
    
    // Usar LLM com streaming real
    if (this.config.llm.generateStream) {
      try {
        const response = await this.config.llm.generateStream(messages, (chunk: string) => {
          if (this.currentMetrics?.interrupted) return;
          
          // Marcar primeiro token
          if (llmFirstTokenTime === 0) {
            llmFirstTokenTime = Date.now();
            this.currentMetrics!.llmFirstToken = llmFirstTokenTime;
          }
          
          fullResponse += chunk;
          textBuffer += chunk;
          
          // Verificar se temos uma sentença completa (prioridade) ou cláusula
          const trimmedBuffer = textBuffer.trim();
          const lastChar = trimmedBuffer.slice(-1);
          const hasSentenceEnd = SENTENCE_DELIMITERS.includes(lastChar);
          const hasClauseEnd = CLAUSE_DELIMITERS.includes(lastChar);
          const hasEnoughChars = trimmedBuffer.length >= MIN_CHARS_FOR_TTS;
          const bufferFull = trimmedBuffer.length >= MAX_BUFFER_CHARS;
          
          // Enviar para TTS se:
          // 1. Sentença completa com chars suficientes, OU
          // 2. Buffer cheio (forçar envio)
          if ((hasSentenceEnd && hasEnoughChars) || bufferFull) {
            enqueueTextChunk(trimmedBuffer);
            textBuffer = '';
          }
          // Cláusula só envia se buffer está quase cheio
          else if (hasClauseEnd && trimmedBuffer.length >= MAX_BUFFER_CHARS * 0.7) {
            enqueueTextChunk(trimmedBuffer);
            textBuffer = '';
          }
        });
        
        // Processar texto restante no buffer
        if (textBuffer.trim()) {
          enqueueTextChunk(textBuffer.trim(), true);
        }
        
        // Aguardar fila de TTS terminar
        while (textChunkQueue.length > 0 || isProcessingQueue) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        const llmDuration = llmFirstTokenTime - this.currentMetrics.llmStart;
        this.logger.info(`✅ LLM Streaming (${llmDuration}ms first token): "${fullResponse.substring(0, 50)}..."`);
        
      } catch (error) {
        this.logger.warn('Erro no LLM streaming, usando fallback batch:', error);
        // Fallback para modo batch
        const response = await this.config.llm.generate(messages, { maxTokens: 80 });
        fullResponse = response.text;
        this.currentMetrics.llmFirstToken = Date.now();
        await processTextChunk(fullResponse, true);
      }
    } else {
      // Fallback: LLM não suporta streaming
      const response = await this.config.llm.generate(messages, { maxTokens: 80 });
      fullResponse = response.text;
      this.currentMetrics.llmFirstToken = Date.now();
      
      const llmDuration = this.currentMetrics.llmFirstToken - this.currentMetrics.llmStart;
      this.logger.info(`✅ LLM Batch (${llmDuration}ms): "${fullResponse.substring(0, 50)}..."`);
      
      await processTextChunk(fullResponse, true);
    }

    // Finalizar streaming
    this.config.localProvider.endAudioStream();
    
    // Finalizar segmento de áudio do agente no AudioRoom
    if (this.audioRoom) {
      this.audioRoom.endAgentSegment();
    }
    
    // Notificar STT que agente parou de falar
    if (scribe.setAgentSpeaking) {
      scribe.setAgentSpeaking(false);
    }
    
    // Adicionar resposta ao histórico
    session.conversationHistory.push({
      role: 'agent',
      content: fullResponse,
      timestamp: new Date(),
    });
    
    // Gravar transcrição do agente
    if (this.callRecorder) {
      this.callRecorder.addTranscriptEntry('agent', fullResponse);
    }

    this.logger.info(`🤖 Resposta: "${fullResponse.substring(0, 80)}${fullResponse.length > 80 ? '...' : ''}"`);
    this.emit('agent:spoke', callId, fullResponse);

    // Disparar processamento de pensamentos em paralelo (não bloqueia)
    // Aproveita o tempo de reprodução do áudio (~1-3s) enquanto o usuário ouve
    // Só processa se não for saudação inicial (tem mensagem do usuário) e se ThinkingEngine estiver habilitado
    if (this.thinkingEngine) {
      const userMessages = session.conversationHistory.filter(t => t.role === 'user');
      if (userMessages.length > 0) {
        this.processThoughtsInParallel(callId, session, fullResponse).catch(err => {
          this.logger.warn('Erro ao processar pensamentos (não crítico):', err);
        });
      }
    }
  }

  /**
   * Processa pensamentos internos em paralelo (não bloqueia)
   * Executa durante a reprodução do áudio para aproveitar tempo "morto"
   */
  private async processThoughtsInParallel(
    callId: string,
    session: CallSession,
    agentResponse: string
  ): Promise<void> {
    // Verificar se ThinkingEngine está habilitado
    if (!this.thinkingEngine) return;

    // Encontrar última mensagem do usuário
    const userMessages = session.conversationHistory.filter(t => t.role === 'user');
    const lastUserMessage = userMessages.length > 0 
      ? userMessages[userMessages.length - 1].content 
      : '';

    if (!lastUserMessage) {
      // Não há mensagem do usuário ainda (pode ser saudação inicial)
      return;
    }

    const turnId = this.currentMetrics?.turnId || `turn-${Date.now()}`;

    try {
      const thoughts = await this.thinkingEngine.processThoughts(
        session,
        lastUserMessage,
        agentResponse,
        turnId
      );

      if (thoughts) {
        // Inicializar array se não existir
        if (!session.internalThoughts) {
          session.internalThoughts = [];
        }

        session.internalThoughts.push(thoughts);

        // Registrar no CallRecorder
        if (this.callRecorder) {
          this.callRecorder.addThoughts(thoughts);
        }

        this.logger.debug(`💭 Pensamentos registrados para turno ${turnId}`);
      }
    } catch (error) {
      // Erro não deve interromper o fluxo principal
      this.logger.warn('Erro ao processar pensamentos (não crítico):', error);
    }
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
      .replace('{prospectName}', session.prospectName || 'Ainda não coletado')
      .replace('{companyName}', session.companyName || 'Não informada')
      .replace('{context}', this.generateContext(session));

    // Adicionar pensamentos anteriores ao contexto (últimos 2)
    if (session.internalThoughts && session.internalThoughts.length > 0) {
      const recentThoughts = session.internalThoughts.slice(-2);
      const thoughtsContext = ThinkingEngine.formatThoughtsForContext(recentThoughts);
      
      if (thoughtsContext) {
        systemPrompt += `\n\n═══════════════════════════════════════════════════════════════════════════════
💭 SEUS PENSAMENTOS ANTERIORES (use para manter coerência no raciocínio):
═══════════════════════════════════════════════════════════════════════════════
${thoughtsContext}
═══════════════════════════════════════════════════════════════════════════════`;
      }
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Adicionar histórico recente (6 para prompt slim, 10 para normal)
    const historyLimit = appConfig.agent.useSlimPrompt ? -6 : -10;
    const recentHistory = session.conversationHistory.slice(historyLimit);
    for (const turn of recentHistory) {
      messages.push({
        role: turn.role === 'agent' ? 'assistant' : 'user',
        content: turn.content,
      });
    }

    return messages;
  }

  /**
   * Extrai nome da resposta do usuário
   * Tenta identificar padrões como "Meu nome é X", "Sou o X", "Eu sou X", etc.
   */
  private extractNameFromResponse(text: string): string | null {
    const lower = text.toLowerCase().trim();
    
    // Palavras comuns que NÃO são nomes (lista expandida)
    const commonWords = [
      // Respostas curtas
      'sim', 'não', 'ok', 'tá', 'ah', 'oi', 'olá', 'bom', 'boa', 'tarde', 'dia', 'noite',
      // Conjunções e preposições
      'se', 'for', 'como', 'é', 'o', 'a', 'de', 'da', 'do', 'que', 'qual', 'quando', 'onde', 'quem',
      // Verbos comuns
      'posso', 'cair', 'tudo', 'bem', 'meu', 'minha', 'sou', 'estou', 'falo', 'fala',
      'pode', 'fazer', 'faz', 'está', 'estão', 'tem', 'têm', 'ter',
      // Preposições
      'com', 'para', 'por', 'sobre',
      // Artigos
      'um', 'uma', 'uns', 'umas',
      // Pronomes
      'eu', 'você', 'ele', 'ela', 'nós', 'eles', 'elas',
      // Outras palavras comuns
      'fogo', 'seu', 'sua', 'nosso', 'nossa',
      // Palavras que podem começar frase mas não são nomes
      'essa', 'esse', 'esta', 'este', 'aqui', 'agora', 'mesma', 'mesmo', 'aquela', 'aquele',
    ];
    
    // Padrões explícitos de apresentação (mais confiáveis)
    const explicitPatterns = [
      /(?:meu nome é|eu sou|sou o|sou a|me chamo|chamo-me|é o|é a|chamo)\s+([a-záàâãéêíóôõúç]{3,25})/i,
      /(?:fala com|está falando com|falo com)\s+([a-záàâãéêíóôõúç]{3,25})/i,
      // Padrão para "com [Nome]" no final ou meio da frase (ex: "Essa mesma noite, com Oscar")
      /,?\s*com\s+([A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,20})\.?$/i,
      // Padrão para "aqui é [Nome]" ou "aqui é o [Nome]"
      /aqui (?:é|fala)\s+(?:o\s+|a\s+)?([a-záàâãéêíóôõúç]{3,25})/i,
    ];

    for (const pattern of explicitPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Validar: mínimo 3 caracteres, máximo 25, e não é palavra comum
        if (name.length >= 3 && name.length <= 25 && !commonWords.includes(name.toLowerCase())) {
          // Verificar se parece nome (não é número, não tem caracteres especiais estranhos)
          if (/^[a-záàâãéêíóôõúç]+$/i.test(name)) {
            // Capitalizar primeira letra
            return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
          }
        }
      }
    }

    // Se resposta é muito curta (1 palavra) e parece ser só o nome
    const words = text.trim().split(/\s+/);
    if (words.length === 1) {
      const word = words[0];
      // Validar: mínimo 3 caracteres, máximo 20, não é palavra comum, parece nome
      if (word.length >= 3 && word.length <= 20 && 
          !commonWords.includes(word.toLowerCase()) &&
          /^[a-záàâãéêíóôõúç]+$/i.test(word)) {
        // Se começa com maiúscula ou tem 4+ caracteres, provavelmente é nome
        if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(word) || word.length >= 4) {
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }
      }
    }

    // NOVA LÓGICA: Procurar por palavras que parecem nomes próprios na frase
    // (palavras com maiúscula inicial ou palavras que não são comuns)
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const cleanWord = word.replace(/[.,!?;:]$/, ''); // Remove pontuação final
      const lowerWord = cleanWord.toLowerCase();
      
      // Se a palavra começa com maiúscula e tem 3+ caracteres, provavelmente é nome próprio
      if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,20}$/.test(cleanWord)) {
        // Verificar se não é palavra comum
        if (!commonWords.includes(lowerWord) && /^[a-záàâãéêíóôõúç]+$/i.test(cleanWord)) {
          this.logger.debug(`✅ Nome detectado por maiúscula inicial: ${cleanWord}`);
          return cleanWord; // Já está capitalizado
        }
      }
      
      // Se a palavra tem 3+ caracteres, não é comum, e parece nome próprio
      if (cleanWord.length >= 3 && cleanWord.length <= 20 &&
          !commonWords.includes(lowerWord) &&
          /^[a-záàâãéêíóôõúç]+$/i.test(cleanWord)) {
        // Verificar se está em contexto de apresentação (próximo a palavras como "com", "o", "a")
        const prevWord = i > 0 ? words[i - 1].replace(/[.,!?;:]$/, '').toLowerCase() : '';
        const nextWord = i < words.length - 1 ? words[i + 1].replace(/[.,!?;:]$/, '').toLowerCase() : '';
        
        // Se está após "com", "o", "a", "do", "da", "de", "seu", "sua", provavelmente é nome
        if (['com', 'o', 'a', 'do', 'da', 'de', 'seu', 'sua', 'meu', 'minha'].includes(prevWord)) {
          this.logger.debug(`✅ Nome detectado por contexto (após "${prevWord}"): ${cleanWord}`);
          return cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1).toLowerCase();
        }
        
        // Se está antes de pontuação final e tem 4+ caracteres, pode ser nome
        if (word.endsWith('.') && cleanWord.length >= 4) {
          this.logger.debug(`✅ Nome detectado no final da frase: ${cleanWord}`);
          return cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1).toLowerCase();
        }
      }
    }

    return null;
  }

  /**
   * Gera contexto dinâmico
   * Usa as fases configuradas em config.conversationPhases
   */
  private generateContext(session: CallSession): string {
    const turnCount = session.conversationHistory.length;
    const duration = Date.now() - session.startedAt.getTime();
    const hasName = !!(session.prospectName && session.prospectName !== 'Visitante' && session.prospectName.length > 2);

    let context = `Turno ${turnCount + 1}. Duração: ${Math.round(duration / 1000)}s. `;

    // Usa função do config para determinar fase atual
    const phaseContext = generatePhaseContext(turnCount, hasName, session.prospectName || 'Cliente');
    context += phaseContext;

    return context;
  }

  /**
   * Registra métricas do turno
   */
  private recordTurnMetrics(session: CallSession): void {
    if (!this.currentMetrics) return;

    const m = this.currentMetrics;
    
    // Usar métricas detalhadas do STT se disponíveis
    const sttTiming = m.sttTimingMetrics;
    const sttRealLatency = sttTiming?.realLatency || (m.sttEnd - m.sttStart);
    
    const latency: LatencyBreakdown = {
      // Usar latência REAL do STT (tempo até primeira parcial)
      stt: sttRealLatency,
      llm: (m.llmFirstToken || m.playbackEnd) - m.llmStart,
      tts: m.ttsFirstChunk ? m.ttsFirstChunk - m.ttsStart : 0,
      // Total = STT real + LLM + TTS (sem contar tempo de fala do usuário)
      total: sttRealLatency + ((m.llmFirstToken || m.playbackEnd) - m.llmStart) + (m.ttsFirstChunk ? m.ttsFirstChunk - m.ttsStart : 0),
      timeToFirstAudio: m.playbackStart ? m.playbackStart - m.sttEnd : 0,
      // Novas métricas separadas
      speechDuration: sttTiming?.speechDuration,
      vadDelay: sttTiming?.vadWaitTime,
    };

    const turnMetrics: TurnMetrics = {
      turnId: m.turnId,
      timestamp: new Date(),
      latency,
      audioInputDuration: sttTiming?.speechDuration || 0,
      audioOutputDuration: 0,
      fillerUsed: false,
    };

    session.metrics.turns.push(turnMetrics);
    this.updateAggregateMetrics(session);

    // Log métricas com separação clara entre latência e tempo de fala
    this.logger.info('📊 Métricas do turno:');
    this.logger.info(`   ⚡ Latências: STT=${latency.stt}ms | LLM=${latency.llm}ms | TTS=${latency.tts}ms`);
    if (latency.speechDuration !== undefined) {
      this.logger.info(`   🗣️ Info: Duração da fala=${latency.speechDuration}ms | VAD wait=${latency.vadDelay}ms`);
    }
    this.logger.info(`   ⏱️ Time to First Audio: ${latency.timeToFirstAudio}ms`);
    this.logger.info(`   📈 Total (latência real): ${latency.total}ms ${m.interrupted ? '(interrompido)' : ''}`);

    // Análise de gargalos (apenas se latência estiver alta)
    if (latency.total > 2000 || latency.timeToFirstAudio > 2000) {
      const analyzer = new LatencyAnalyzer();
      analyzer.logAnalysis(latency);
    }

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

    // Parar AudioRoom (gravação de áudio mixada)
    if (this.audioRoom) {
      await this.audioRoom.stop();
      this.audioRoom = null;
    }
    
    // Salvar transcrição da chamada
    if (this.callRecorder) {
      const recordingMetrics = {
        averageSTT: session.metrics.averageLatency.stt,
        averageLLM: session.metrics.averageLatency.llm,
        averageTTS: session.metrics.averageLatency.tts,
        averageTimeToFirstAudio: session.metrics.averageLatency.timeToFirstAudio,
      };
      const recordingPath = await this.callRecorder.stop(recordingMetrics);
      if (recordingPath) {
        this.logger.info(`📁 Gravação salva em: ${recordingPath}`);
      }
      this.callRecorder = null;
    }

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

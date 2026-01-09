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
import { config as appConfig } from '../config';
import { VoiceIntelligence } from './VoiceIntelligence';
import { TurnStateManager } from './TurnStateManager';
import { EchoFilter } from './EchoFilter';
import { AcknowledgmentManager } from './AcknowledgmentManager';

// Configurações de streaming
const STREAMING_CONFIG = {
  MIN_CHARS_FOR_TTS: 80,          // Mínimo de caracteres antes de enviar para TTS (aumentado)
  SENTENCE_DELIMITERS: ['.', '!', '?', ':', ';', ','], // Delimitadores de frase
  MAX_BUFFER_CHARS: 250,          // Máximo de caracteres no buffer antes de forçar flush (aumentado)
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
  private greetingTranscription: string = ''; // Buffer para transcrições durante saudação (combinadas com próxima fala)
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

  // Sistema de cancelamento e reprocessamento
  // Quando usuário volta a falar durante processamento (antes do áudio), cancela e reprocessa
  private shouldCancelProcessing: boolean = false; // Flag para cancelar processamento atual
  private pendingTranscriptionText: string = ''; // Transcrição que estava sendo processada
  private continuationDetected: boolean = false; // Usuário continuou falando
  private hasStartedPlayback: boolean = false; // Flag para saber se já enviamos áudio (mais preciso que isCurrentlyPlaying)
  
  // 🆕 Transcrição parcial durante reprodução (para usar após barge-in)
  private partialDuringPlayback: string = ''; // Guarda transcrição parcial enquanto agente fala
  private lastPartialDuringPlaybackTime: number = 0; // Timestamp da última parcial durante playback
  
  // 🆕 Anti-eco: guardar última resposta do agente para filtrar
  private lastAgentResponse: string = ''; // Última resposta do agente
  private lastCancelLogTime: number = 0; // Para debounce de logs de cancelamento
  private static readonly CANCEL_LOG_DEBOUNCE_MS = 500; // Mínimo entre logs de cancelamento

  // Gravação de chamadas
  private callRecorder: CallRecorder | null = null;
  private audioRoom: AudioRoom | null = null;

  // Camada de inteligência centralizada (pensamentos, contexto, extração de nome)
  private intelligence: VoiceIntelligence;
  
  // Módulos de gerenciamento de estado (compartilhados com VoiceAgent)
  private turnState: TurnStateManager;
  private echoFilter: EchoFilter;
  private acknowledgmentManager: AcknowledgmentManager;

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

    // Inicializar camada de inteligência centralizada
    this.intelligence = new VoiceIntelligence({
      llm: this.config.llm,
      systemPrompt: this.config.systemPrompt,
      enableThinking: appConfig.thinkingEngine?.enabled ?? false,
    });
    
    // Inicializar módulos de gerenciamento de estado
    this.turnState = new TurnStateManager();
    this.echoFilter = new EchoFilter();
    this.acknowledgmentManager = new AcknowledgmentManager(this.config.tts);
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
    
    // Configurar módulos de estado para modo single-session
    this.turnState.setSingleSession(callId);
    this.echoFilter.setSingleSession(callId);
    this.acknowledgmentManager.setSingleSession(callId);
    
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
      // NOTA: Durante a saudação, o LocalAudioProvider só envia chunks que não são eco
      // Isso permite capturar a fala do usuário (ex: "Alô?") para combinar com próxima fala
      this.config.localProvider.onAudioChunk(callId, (chunk: Buffer) => {
        // Gravar áudio do usuário no AudioRoom
        if (this.audioRoom) {
          this.audioRoom.feedUserAudio(chunk);
        }
        
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
      });
      
      // Callback para transcrições finais do Scribe
      // LÓGICA DA MAIN: Simples e direta
      this.config.transcriber.onTranscript!(callId, async (result) => {
        const resultText = result.text.trim();
        
        // PRIMEIRO: Verificar se é eco do agente (ignorar completamente)
        if (this.echoFilter.isLikelyAgentEcho(resultText)) {
          this.logger.info(`🔇 Ignorando eco do agente na transcrição final: "${resultText}"`);
          // Resetar flags de cancelamento se estavam setadas
          if (this.shouldCancelProcessing) {
            this.shouldCancelProcessing = false;
            this.continuationDetected = false;
          }
          return; // Não processar eco
        }
        
        // Verificar se transcrição parece corrompida (eco do agente, onomatopeias)
        const isLikelyCorrupted = this.echoFilter.isTranscriptionCorrupted(resultText);
        
        // Se temos transcrição parcial capturada durante playback e resultado parece corrompido
        if (this.partialDuringPlayback && isLikelyCorrupted) {
          this.logger.warn(`⚠️ Transcrição final parece corrompida: "${resultText}"`);
          this.logger.info(`🔄 Usando transcrição parcial capturada: "${this.partialDuringPlayback.substring(0, 50)}..."`);
          
          // Usar a transcrição parcial em vez da corrompida
          const fixedResult: TranscriptionResult = {
            ...result,
            text: this.partialDuringPlayback,
          };
          
          // Resetar
          this.partialDuringPlayback = '';
          this.continuationDetected = false;
          this.pendingTranscriptionText = '';
          
          if (!this.isGreetingInProgress) {
            await this.processTranscription(callId, fixedResult);
          }
          return;
        }
        
        // Se detectamos continuação, esta é a transcrição completa - juntar com anterior
        if (this.continuationDetected && this.pendingTranscriptionText) {
          const combinedText = `${this.pendingTranscriptionText} ${result.text}`.trim();
          this.logger.info(`🔗 Transcrições combinadas: "${combinedText.substring(0, 50)}..."`);
          
          // Criar novo resultado com texto combinado
          const combinedResult: TranscriptionResult = {
            ...result,
            text: combinedText,
          };
          
          // Resetar flags
          this.continuationDetected = false;
          this.pendingTranscriptionText = '';
          this.shouldCancelProcessing = false;
          this.partialDuringPlayback = '';
          
          // Processar transcrição combinada
          await this.processTranscription(callId, combinedResult);
          return;
        }
        
        // Resetar transcrição parcial (não usada)
        this.partialDuringPlayback = '';
        
        // Durante a saudação: guardar transcrição para combinar com próxima fala
        // O "Alô?" do usuário é resposta natural, não deve causar barge-in
        if (this.isGreetingInProgress) {
          const existingText = this.greetingTranscription;
          this.greetingTranscription = existingText ? `${existingText} ${resultText}` : resultText;
          this.logger.info(`👋 Transcrição durante saudação guardada: "${resultText}" - será combinada com próxima fala`);
          return;
        }
        
        // Combinar com transcrição guardada durante saudação (se houver)
        let textToProcess = resultText;
        if (this.greetingTranscription) {
          textToProcess = `${this.greetingTranscription} ${resultText}`.trim();
          this.greetingTranscription = '';
          this.logger.info(`🔗 Transcrição combinada com saudação: "${textToProcess.substring(0, 50)}..."`);
        }
        
        if (!this.isProcessing) {
          this.logger.debug(`📝 Recebida transcrição do Scribe: "${textToProcess}"`);
          const processResult: TranscriptionResult = { ...result, text: textToProcess };
          await this.processTranscription(callId, processResult);
        } else {
          // Estamos processando, mas não detectamos continuação via parciais
          // Pode acontecer se a fala foi muito rápida - marcar para reprocessar
          this.logger.debug(`⚠️ Nova transcrição durante processamento: "${textToProcess.substring(0, 30)}..."`);
          if (!this.config.localProvider.isCurrentlyPlaying()) {
            // Ainda não começou áudio - marcar para cancelar e reprocessar
            this.shouldCancelProcessing = true;
            this.continuationDetected = true;
            // A próxima transcrição vai combinar
          }
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
          
          const trimmedText = text.trim();
          
          // Filtrar eco do agente (resíduos que podem vazar mesmo com filtro no LocalAudioProvider)
          if (this.echoFilter.isLikelyAgentEcho(trimmedText)) {
            this.logger.debug(`🔇 Ignorando eco do agente: "${trimmedText.substring(0, 30)}..."`);
            return; // Não processar eco
          }
          
          // Filtrar transcrições muito curtas ou onomatopeias
          const isNoise = /^(h+[um]+|hum+|uhum+|ah+|eh+|oh+|uh+)[.!?,\s]*$/i.test(trimmedText) 
                         || trimmedText.length < 5;
          if (isNoise) {
            this.logger.debug(`🔇 Ignorando ruído/onomatopeia: "${trimmedText}"`);
            return;
          }
          
          // DURANTE SAUDAÇÃO: Guardar transcrição parcial para usar depois
          // Não processamos, mas guardamos para o handler de playback:interrupted
          if (this.isGreetingInProgress && this.config.localProvider.isCurrentlyPlaying() && trimmedText.length > 5) {
            const isLikelyEcho = /^(oi[,.\s]*)+$/i.test(trimmedText);
            if (!isLikelyEcho && trimmedText.length > this.partialDuringPlayback.length) {
              this.partialDuringPlayback = trimmedText;
              this.logger.info(`👂 Transcrição parcial durante saudação: "${trimmedText.substring(0, 40)}..." (será combinada)`);
            }
          }
          
          // DETECÇÃO DE CONTINUAÇÃO: Se estamos processando E usuário volta a falar
          // Cancela processamento atual para reprocessar com transcrição completa
          if (this.isProcessing && !this.isGreetingInProgress && trimmedText.length > 5) {
            
            if (!this.hasStartedPlayback) {
              // CASO 1: Áudio ainda não começou - cancela silenciosamente e reprocessa
              if (!this.shouldCancelProcessing) {
                this.logger.info(`🔄 Usuário continuou falando: "${trimmedText.substring(0, 30)}..." - cancelando processamento`);
                this.shouldCancelProcessing = true;
                this.continuationDetected = true;
                this.pendingTranscriptionText = trimmedText; // Guardar para combinar depois
                
                // 🎵 Tocar onomatopeia de escuta ativa ("Uhum", "Hm", "Ok")
                this.playListeningAcknowledgment(callId).catch(err => {
                  this.logger.debug('Erro ao tocar acknowledgment (não crítico):', err);
                });
              }
            } else {
              // CASO 2: Áudio já começou - guardar transcrição parcial e fazer barge-in
              // Essa transcrição pode vir do buffer flushed após barge-in via VAD de energia,
              // ou de áudio que passou pelo EchoCanceller como não-eco
              const isLikelyEcho = /^(oi[,.\s]*)+$/i.test(trimmedText);
              
              if (!isLikelyEcho && trimmedText.length > this.partialDuringPlayback.length) {
                this.partialDuringPlayback = trimmedText;
                this.lastPartialDuringPlaybackTime = Date.now();
                this.logger.info(`👂 Transcrição parcial durante playback: "${trimmedText.substring(0, 40)}..."`);
                
                // 🔇 Disparar barge-in via código (backup do VAD de energia)
                if (!this.wasInterrupted) {
                  this.logger.info('🔇 Barge-in via transcrição parcial - usuário está falando!');
                  this.config.localProvider.stopPlayback();
                  // Nota: o evento playback:interrupted será emitido pelo LocalAudioProvider
                }
              }
            }
          }
          
          // 🆕 CASO 3: Barge-in durante reprodução (quando isProcessing já é false)
          // Isso acontece quando o LLM/TTS terminou mas o áudio ainda está sendo reproduzido
          // A main tinha isso como parte do CASO 2, mas só funciona se isProcessing = true
          if (!this.isProcessing && !this.isGreetingInProgress && 
              this.config.localProvider.isCurrentlyPlaying() && trimmedText.length > 5) {
            const isLikelyEcho = /^(oi[,.\s]*)+$/i.test(trimmedText);
            
            if (!isLikelyEcho && !this.wasInterrupted) {
              this.partialDuringPlayback = trimmedText;
              this.logger.info(`👂 Transcrição parcial durante playback (pós-processamento): "${trimmedText.substring(0, 40)}..."`);
              this.logger.info('🔇 Barge-in via transcrição parcial - usuário está falando!');
              this.config.localProvider.stopPlayback();
              // Nota: o evento playback:interrupted será emitido pelo LocalAudioProvider
            }
          }
          
          // Pré-processamento: detectar possível fim de frase e pré-construir contexto LLM
          if (!this.isProcessing && !this.isGreetingInProgress && 
              !this.config.localProvider.isCurrentlyPlaying() && trimmedText.length > 5) {
            this.handlePartialTranscriptForPreprocessing(callId, trimmedText);
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
      // Durante a saudação: guardar transcrição parcial para combinar depois
      // NÃO processamos imediatamente, mas guardamos para uso posterior
      if (this.isGreetingInProgress) {
        // Guardar transcrição parcial (se houver) em greetingTranscription
        if (this.partialDuringPlayback) {
          const existingText = this.greetingTranscription;
          this.greetingTranscription = existingText 
            ? `${existingText} ${this.partialDuringPlayback}` 
            : this.partialDuringPlayback;
          this.logger.info(`👋 Transcrição durante saudação (barge-in) guardada: "${this.partialDuringPlayback}" - será combinada com próxima fala`);
          this.partialDuringPlayback = '';
        } else {
          this.logger.info(`👋 Barge-in durante saudação detectado - aguardando transcrição`);
        }
        return;
      }
      
      this.wasInterrupted = true;
      this.bargeInTimestamp = Date.now();
      
      if (this.currentMetrics) {
        this.currentMetrics.interrupted = true;
      }
      
      // Se temos transcrição parcial capturada durante playback, logar
      if (this.partialDuringPlayback) {
        this.logger.info(`🔇 Barge-in detectado - transcrição parcial capturada: "${this.partialDuringPlayback.substring(0, 50)}..."`);
        // Guardar a transcrição parcial como "pendente" para usar quando vier a completa
        this.pendingTranscriptionText = this.partialDuringPlayback;
        this.continuationDetected = true;
      } else {
        this.logger.info('🔇 Barge-in detectado - cancelando TODOS os processamentos');
      }
      
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
      
      // Resetar hasStartedPlayback (agente parou de falar)
      this.hasStartedPlayback = false;
      
      // Auto-reset do flag após grace period
      setTimeout(() => {
        if (this.bargeInTimestamp > 0 && Date.now() - this.bargeInTimestamp >= StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS) {
          this.wasInterrupted = false;
          this.bargeInTimestamp = 0;
          // 🆕 Resetar transcrição parcial após grace period
          this.partialDuringPlayback = '';
          this.logger.debug('✅ Flag de barge-in auto-resetada após grace period');
        }
      }, StreamingVoiceAgent.BARGE_IN_GRACE_PERIOD_MS + 100);
    });

    // Iniciar gravação
    await this.config.localProvider.startRecording(callId);

    // Pré-carregar áudios de acknowledgment em background (latência zero quando precisar)
    this.acknowledgmentManager.preload().catch(err => {
      this.logger.debug('Erro ao pré-carregar acknowledgments (não crítico):', err);
    });

    this.emit('session:started', callId);
    this.logger.info(`✅ Sessão ${callId} iniciada - Fale algo!`);

    // Gerar saudação inicial
    // Durante a saudação: DESABILITAR barge-in mas CONTINUAR capturando áudio
    // O "Alô?" do usuário é resposta natural, não deve interromper a apresentação
    // Mas queremos capturar essa fala para combinar com a próxima
    this.isGreetingInProgress = true;
    this.config.localProvider.setBargeInEnabled(false); // Desabilita barge-in durante saudação
    
    await this.generateGreeting(callId);
    
    // Aguardar playback terminar naturalmente (sem interrupção)
    await this.waitForPlaybackEnd(callId);
    
    this.config.localProvider.setBargeInEnabled(true); // Reabilita barge-in após saudação
    this.isGreetingInProgress = false;
    
    // Se houve transcrição durante saudação, logar
    if (this.greetingTranscription) {
      this.logger.info(`👋 Transcrição guardada durante saudação: "${this.greetingTranscription}" - será combinada com próxima fala`);
    }

    return callId;
  }

  /**
   * Aguarda o playback terminar ou ser interrompido
   * Usado após a saudação para não processar "Alô?" como barge-in
   */
  private waitForPlaybackEnd(callId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      // Se não está reproduzindo, resolver imediatamente
      if (!this.config.localProvider.isCurrentlyPlaying()) {
        resolve();
        return;
      }

      const MAX_WAIT_MS = 10000; // Timeout máximo de 10s (segurança)
      let resolved = false;

      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          this.config.localProvider.off('playback:ended', onEnded);
          this.config.localProvider.off('playback:interrupted', onInterrupted);
          resolve();
        }
      };

      const onEnded = (endedCallId: string) => {
        if (endedCallId === callId) {
          this.logger.info('✅ Saudação finalizada naturalmente');
          cleanup();
        }
      };

      const onInterrupted = (interruptedCallId: string) => {
        if (interruptedCallId === callId) {
          this.logger.info('👋 Saudação interrompida pelo usuário');
          cleanup();
        }
      };

      this.config.localProvider.on('playback:ended', onEnded);
      this.config.localProvider.on('playback:interrupted', onInterrupted);

      // Timeout de segurança
      setTimeout(cleanup, MAX_WAIT_MS);
    });
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
      const conversationStage = this.intelligence.detectConversationStage(session);
      
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

  // NOTA: detectConversationStage foi movido para VoiceIntelligence
  // NOTA: isTranscriptionCorrupted e isLikelyAgentEcho foram movidos para EchoFilter

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
      this.prebuiltLLMContext = this.intelligence.buildLLMMessages(tempSession);
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
   * Toca uma onomatopeia curta de escuta ativa ("Uhum", "Hm", "Ok")
   * Usado quando detectamos que o usuário continuou falando
   * Dá feedback de que o agente está ouvindo
   */
  private async playListeningAcknowledgment(callId: string): Promise<void> {
    try {
      const ack = await this.acknowledgmentManager.getAcknowledgment();
      if (!ack) {
        // Cooldown ou desabilitado
        return;
      }

      // Gravar no AudioRoom se disponível
      if (this.audioRoom) {
        this.audioRoom.feedAgentAudio(ack.audio);
      }

      // Tocar áudio (não bloqueia - é só um feedback rápido)
      await this.config.localProvider.sendAudio(callId, ack.audio);
      
      // Finalizar segmento
      if (this.audioRoom) {
        this.audioRoom.endAgentSegment();
      }
    } catch (error) {
      // Erro não crítico - não deve interromper o fluxo
      this.logger.debug('Erro ao tocar acknowledgment:', error);
    }
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
      const messages = this.intelligence.buildLLMMessages(session);
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
    this.partialDuringPlayback = ''; // Reset - novo processamento
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

      // Verificar se deve cancelar (usuário continuou falando)
      if (this.shouldCancelProcessing) {
        this.logger.info(`🔄 Cancelando processamento - aguardando continuação do usuário`);
        this.pendingTranscriptionText = transcriptText; // Salvar para combinar depois
        this.shouldCancelProcessing = false;
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

      // Tentar extrair nome se ainda não tiver coletado (usa inteligência centralizada)
      this.intelligence.tryUpdateProspectName(session, transcriptText);

      this.emit('user:spoke', callId, transcriptText);

      // Verificar barge-in ou continuação antes de gerar resposta
      if (this.wasInterrupted) {
        this.logger.debug('⚠️ Barge-in detectado antes de gerar resposta, cancelando');
        this.isProcessing = false;
        this.pendingTranscriptionCallId = null;
        this.resetPreprocessingState();
        return;
      }
      
      // 🆕 Verificar se deve cancelar (usuário continuou falando)
      if (this.shouldCancelProcessing) {
        this.logger.info(`🔄 Cancelando antes de LLM - usuário ainda está falando`);
        this.pendingTranscriptionText = transcriptText;
        this.shouldCancelProcessing = false;
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
        // Construir contexto normalmente (usa inteligência centralizada)
        messages = this.intelligence.buildLLMMessages(session);
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
      
      // 🆕 Resetar flags de continuação se processamento completou com sucesso
      if (!this.shouldCancelProcessing) {
        this.pendingTranscriptionText = '';
        this.continuationDetected = false;
      }
      
      // Resetar flag de playback
      this.hasStartedPlayback = false;
      
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
    
    // 🆕 Resetar flag de playback - ainda não enviamos áudio
    this.hasStartedPlayback = false;
    
    // NOTA: NÃO chamar setAgentSpeaking(true) aqui - só quando primeiro áudio for enviado
    // Isso permite detectar se usuário continua falando durante processamento LLM
    const scribe = this.config.transcriber as any;
    
    // ===== STREAMING REAL: LLM → TTS chunk por chunk =====
    // Delimitadores de sentença/cláusula para dividir texto
    const SENTENCE_DELIMITERS = ['.', '!', '?'];
    const CLAUSE_DELIMITERS = [',', ';', ':'];
    // Chunks MUITO maiores para evitar buffer underflow
    // O TTS leva ~300-400ms para processar cada chunk, então precisamos de chunks grandes
    const MIN_CHARS_FOR_TTS = 80; // Aumentado: chunks maiores = menos gaps
    const MAX_BUFFER_CHARS = 250; // Aumentado: permite 2-3 frases completas
    
    let textBuffer = ''; // Buffer de texto acumulado do LLM
    let chunkIndex = 0;
    
    // Fila de chunks de texto para processar SEQUENCIALMENTE (evita buffer underflow)
    const textChunkQueue: { text: string; isLast: boolean }[] = [];
    let isProcessingQueue = false;
    
    /**
     * Encontra ponto de corte seguro (não fragmenta palavras)
     * Procura último espaço ou pontuação antes do limite
     */
    const findSafeBreakPoint = (text: string, maxChars: number): number => {
      if (text.length <= maxChars) return text.length;
      
      // Procura último espaço ou pontuação antes do limite
      let breakPoint = maxChars;
      for (let i = maxChars - 1; i >= Math.min(maxChars - 30, MIN_CHARS_FOR_TTS); i--) {
        const char = text[i];
        if (char === ' ' || SENTENCE_DELIMITERS.includes(char) || CLAUSE_DELIMITERS.includes(char)) {
          breakPoint = i + 1; // Inclui o espaço/pontuação
          break;
        }
      }
      return breakPoint;
    };
    
    // Função para processar a fila de chunks sequencialmente
    const processQueueSequentially = async (): Promise<void> => {
      if (isProcessingQueue) return; // Já está processando
      isProcessingQueue = true;
      
      while (textChunkQueue.length > 0) {
        // 🆕 Verificar cancelamento antes de processar cada chunk da fila
        if (this.shouldCancelProcessing && !this.hasStartedPlayback) {
          this.logger.debug(`🔄 Limpando fila TTS (${textChunkQueue.length} chunks) - usuário continuou falando`);
          textChunkQueue.length = 0; // Limpar fila
          break;
        }
        
        const item = textChunkQueue.shift()!;
        await processTextChunk(item.text, item.isLast);
      }
      
      isProcessingQueue = false;
    };
    
    // Função para processar um chunk de texto no TTS
    const processTextChunk = async (text: string, isLast: boolean = false): Promise<void> => {
      if (!text.trim() || this.currentMetrics?.interrupted) return;
      
      // 🆕 Verificar se deve cancelar antes de enviar para TTS
      if (this.shouldCancelProcessing && !this.hasStartedPlayback) {
        this.logger.debug('🔄 Cancelando TTS - usuário continuou falando');
        return;
      }
      
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

          // 🆕 Verificar cancelamento ANTES de iniciar reprodução
          // Isso é crítico: se usuário voltou a falar durante LLM/TTS, não reproduzir
          if (this.shouldCancelProcessing && !this.hasStartedPlayback) {
            this.logger.debug('🔄 Cancelando reprodução - usuário continuou falando');
            return; // Não reproduzir este chunk nem os próximos
          }

          if (isFirstAudio) {
            this.currentMetrics!.ttsFirstChunk = Date.now();
            this.currentMetrics!.playbackStart = Date.now();
            
            const timeToFirstAudio = this.currentMetrics!.ttsFirstChunk - this.currentMetrics!.sttEnd;
            this.logger.info(`⚡ Time to First Audio: ${timeToFirstAudio}ms (LLM: ${llmFirstTokenTime - this.currentMetrics!.llmStart}ms)`);
            isFirstAudio = false;
            
            // 🆕 Marcar que já começamos a reproduzir (não pode mais cancelar)
            this.hasStartedPlayback = true;
            
            // 🔊 AGORA sim o agente está falando - notificar STT
            // Isso permite que transcrições parciais sejam detectadas ANTES do áudio começar
            if (scribe.setAgentSpeaking) {
              scribe.setAgentSpeaking(true);
            }
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
      // 🆕 Não adicionar à fila se cancelamento foi solicitado
      if (this.shouldCancelProcessing && !this.hasStartedPlayback) {
        this.logger.debug('🔄 Ignorando chunk TTS - cancelamento solicitado');
        return;
      }
      
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
          
          // 🆕 Verificar se deve cancelar (usuário continuou falando)
          if (this.shouldCancelProcessing) {
            if (this.hasStartedPlayback) {
              // Já enviamos algum áudio, não podemos cancelar mais - continuar normalmente
              return;
            } else {
              // Ainda não enviamos áudio - podemos cancelar
              // 🆕 Debounce para não logar várias vezes
              const now = Date.now();
              if (now - this.lastCancelLogTime > StreamingVoiceAgent.CANCEL_LOG_DEBOUNCE_MS) {
                this.logger.info('🔄 Cancelando LLM streaming - usuário continuou falando');
                this.lastCancelLogTime = now;
              }
              return;
            }
          }
          
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
          // 2. Buffer cheio (usar ponto de corte seguro para não fragmentar palavras)
          if (hasSentenceEnd && hasEnoughChars) {
            enqueueTextChunk(trimmedBuffer);
            textBuffer = '';
          } else if (bufferFull) {
            // IMPORTANTE: Encontrar ponto de corte seguro para não fragmentar palavras
            const breakPoint = findSafeBreakPoint(trimmedBuffer, MAX_BUFFER_CHARS);
            const textToSend = trimmedBuffer.substring(0, breakPoint).trim();
            const remaining = trimmedBuffer.substring(breakPoint);
            
            if (textToSend.length >= MIN_CHARS_FOR_TTS) {
              enqueueTextChunk(textToSend);
              textBuffer = remaining;
            }
          }
          // Cláusula só envia se buffer está MUITO cheio (reduz fragmentação)
          // Aumentado de 0.7 para 0.9 para evitar underflows
          else if (hasClauseEnd && trimmedBuffer.length >= MAX_BUFFER_CHARS * 0.9) {
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

    // 🆕 Se foi cancelado antes de qualquer áudio, não adicionar ao histórico
    if (this.shouldCancelProcessing && !this.hasStartedPlayback) {
      this.logger.info('🔄 Processamento cancelado antes do áudio - aguardando continuação');
      // Notificar STT que agente não está mais "falando" (nunca começou)
      if (scribe.setAgentSpeaking) {
        scribe.setAgentSpeaking(false);
      }
      return; // Sair sem adicionar ao histórico
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
    
    // Guardar resposta para filtrar eco
    this.lastAgentResponse = fullResponse;
    this.echoFilter.registerAgentResponse(fullResponse);

    // Disparar processamento de pensamentos em paralelo (não bloqueia)
    // Aproveita o tempo de reprodução do áudio (~1-3s) enquanto o usuário ouve
    // Usa inteligência centralizada para processamento de pensamentos
    if (this.intelligence.isThinkingEnabled()) {
      const userMessages = session.conversationHistory.filter(t => t.role === 'user');
      if (userMessages.length > 0) {
        this.intelligence.processThoughtsInParallel(session, fullResponse).catch(err => {
          this.logger.warn('Erro ao processar pensamentos (não crítico):', err);
        });
      }
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

  // NOTA: buildLLMMessages, extractNameFromResponse e generateContext foram movidos
  // para VoiceIntelligence para centralizar a lógica de inteligência do agente

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

    // Limpar módulos de gerenciamento de estado
    this.turnState.clearSession(callId);
    this.echoFilter.clearSession(callId);
    this.acknowledgmentManager.clearSession(callId);
    this.greetingTranscription = ''; // Limpar transcrição guardada da saudação

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

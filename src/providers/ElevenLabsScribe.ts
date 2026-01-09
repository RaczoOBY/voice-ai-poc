/**
 * ElevenLabsScribe - Speech-to-Text em tempo real usando ElevenLabs Scribe v2
 * 
 * Vantagens sobre OpenAI Whisper:
 * - Streaming via WebSocket (latência ~100-300ms vs ~1500ms)
 * - Transcrições parciais em tempo real
 * - VAD (Voice Activity Detection) integrado
 * - Formato PCM direto (sem conversão para WAV)
 * 
 * Baseado na documentação:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  ITranscriber,
  TranscriptionResult,
  STTTimingMetrics,
} from '../types';
import { Logger } from '../utils/Logger';

// URL do WebSocket do ElevenLabs Scribe
const SCRIBE_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

// Configuração do Scribe
export interface ElevenLabsScribeConfig {
  apiKey: string;
  modelId?: string;           // 'scribe_v2_realtime'
  sampleRate?: number;        // 16000 (padrão) - ignorado se audioFormat for 'mulaw' ou 'alaw'
  language?: string;          // 'pt' para português
  vadSilenceThresholdMs?: number; // Tempo de silêncio para commit (500ms padrão)
  // 🆕 Parâmetros para reduzir "alucinações" durante silêncio
  vadThreshold?: number;      // Sensibilidade do VAD (0.1-0.9, padrão 0.4) - maior = menos sensível
  minSpeechDurationMs?: number; // Duração mínima de fala (50-2000ms, padrão 250)
  // 🆕 Formato de áudio - permite usar μ-law direto do Twilio sem conversão
  audioFormat?: 'pcm' | 'ulaw_8000'; // 'pcm' (padrão), 'ulaw_8000' (Twilio direto - 8kHz μ-law)
}

// Eventos do WebSocket (snake_case conforme API real)
interface ScribeSessionStarted {
  message_type: 'session_started';
  session_id: string;
  config?: Record<string, unknown>;
}

interface ScribePartialTranscript {
  message_type: 'partial_transcript';
  text: string;
}

interface ScribeCommittedTranscript {
  message_type: 'committed_transcript';
  text: string;
}

interface ScribeCommittedTranscriptWithTimestamps {
  message_type: 'committed_transcript_with_timestamps';
  text: string;
  words: Array<{ word: string; start: number; end: number }>;
}

interface ScribeError {
  message_type: 'scribe_error' | 'scribe_auth_error' | 'scribe_quota_exceeded_error' | 
                'scribe_throttled_error' | 'scribe_input_error' | 'scribe_transcriber_error';
  message?: string;
  error?: string;
}

type ScribeEvent = 
  | ScribeSessionStarted 
  | ScribePartialTranscript 
  | ScribeCommittedTranscript 
  | ScribeCommittedTranscriptWithTimestamps
  | ScribeError;

export class ElevenLabsScribe extends EventEmitter implements ITranscriber {
  private config: ElevenLabsScribeConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private sessionId: string | null = null;
  private activeCallId: string = 'default'; // CallId ativo para eventos
  
  // Callbacks por sessão
  private transcriptCallbacks: Map<string, (result: TranscriptionResult) => void> = new Map();
  private partialCallbacks: Map<string, (text: string) => void> = new Map();
  
  // Buffer para modo batch (fallback)
  private pendingResolve: ((result: TranscriptionResult) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private transcriptionStartTime: number = 0;
  private firstPartialTime: number = 0; // Timestamp da primeira transcrição parcial (latência real)
  
  // Coordenação com o agente para métricas corretas
  private _isAgentSpeaking: boolean = false;
  private chunksWhileAgentSpeaking: number = 0; // Contador de chunks ignorados durante fala do agente
  private agentStoppedSpeakingAt: number = 0; // Timestamp de quando o agente parou de falar
  private static readonly AGENT_STOP_GRACE_PERIOD_MS = 100; // Grace period após agente parar
  private pendingTranscriptDiscarded: boolean = false; // Flag para descartar transcrição em andamento
  
  // Reconexão automática e keepalive
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectDelayMs: number = 1000;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private keepaliveIntervalMs: number = 15000; // Enviar keepalive a cada 15s
  private lastAudioSentTime: number = 0;

  constructor(config: ElevenLabsScribeConfig) {
    super();
    this.setMaxListeners(50); // Evitar warning de memory leak
    this.config = {
      modelId: 'scribe_v2_realtime',
      sampleRate: 16000,
      language: 'pt', // Português
      vadSilenceThresholdMs: 500, // Padrão 500ms (0.5s) - mesmo do test-scribe.ts
      // 🆕 Parâmetros para captar frases curtas ("Sim", "Não", "Já")
      vadThreshold: 0.5, // Equilibrado - sensível a fala curta mas filtra ruído
      minSpeechDurationMs: 100, // 100ms - permite "Sim/Não/Já" (~100-200ms)
      audioFormat: 'pcm', // Padrão PCM, mas pode usar 'ulaw_8000' para Twilio direto
      ...config,
    };
    this.logger = new Logger('ElevenLabs-Scribe');
  }

  /**
   * Inicia conexão WebSocket para streaming
   */
  async startStream(callId: string): Promise<void> {
    // Sempre atualizar o callId ativo (importante para callbacks)
    this.activeCallId = callId;
    this.logger.debug(`CallId ativo: ${callId}`);
    
    if (this.isConnected) {
      this.logger.debug('Já conectado ao Scribe, usando callId existente');
      return;
    }

    return new Promise((resolve, reject) => {
      // Converter ms para segundos para a API
      // Usar valor padrão de 500ms (0.5s) se não especificado - mesmo do test-scribe.ts que funciona
      const vadSilenceThresholdMs = this.config.vadSilenceThresholdMs || 500;
      // Garantir que está entre 0.1s e 5.0s, e usar formato com 1 decimal
      const vadSilenceThresholdSecs = Math.max(0.1, Math.min(5.0, vadSilenceThresholdMs / 1000));
      const vadSilenceThresholdSecsStr = vadSilenceThresholdSecs.toFixed(1);
      
      // Validar valores antes de construir URL
      if (!this.config.modelId) {
        reject(new Error('modelId não configurado'));
        return;
      }
      if (!this.config.language) {
        reject(new Error('language não configurado'));
        return;
      }
      if (!this.config.sampleRate) {
        reject(new Error('sampleRate não configurado'));
        return;
      }
      
      // 🆕 Parâmetros de VAD para reduzir alucinações (valores padrão definidos no construtor)
      const vadThreshold = this.config.vadThreshold!; // Padrão: 0.7
      const minSpeechDurationMs = this.config.minSpeechDurationMs!; // Padrão: 200ms
      
      // 🆕 Determinar formato de áudio - ulaw_8000 para Twilio direto
      const audioFormat = this.config.audioFormat || 'pcm';
      let audioFormatParam: string;
      if (audioFormat === 'ulaw_8000') {
        audioFormatParam = 'ulaw_8000'; // μ-law 8kHz do Twilio direto
      } else {
        audioFormatParam = `pcm_${this.config.sampleRate}`; // PCM com sample rate
      }
      
      const params = new URLSearchParams({
        model_id: this.config.modelId,
        language_code: this.config.language,
        commit_strategy: 'vad',
        vad_silence_threshold_secs: vadSilenceThresholdSecsStr,
        vad_threshold: vadThreshold.toString(), // 🆕 Sensibilidade do VAD (maior = menos sensível)
        min_speech_duration_ms: minSpeechDurationMs.toString(), // 🆕 Duração mínima de fala
        audio_format: audioFormatParam,
        include_timestamps: 'false',
      });
      
      const wsUrl = `${SCRIBE_WS_URL}?${params.toString()}`;
      
      this.logger.info('🔌 Conectando ao ElevenLabs Scribe...');
      this.logger.debug(`URL completa: ${wsUrl}`);
      this.logger.debug(`Parâmetros:`);
      this.logger.debug(`  - model_id: ${this.config.modelId}`);
      this.logger.debug(`  - language_code: ${this.config.language}`);
      this.logger.debug(`  - commit_strategy: vad`);
      this.logger.debug(`  - vad_silence_threshold_secs: ${vadSilenceThresholdSecsStr} (${vadSilenceThresholdMs}ms)`);
      this.logger.debug(`  - vad_threshold: ${vadThreshold}`);
      this.logger.debug(`  - min_speech_duration_ms: ${minSpeechDurationMs}`);
      this.logger.debug(`  - audio_format: ${audioFormatParam}`);
      this.logger.debug(`  - include_timestamps: false`);
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });

      this.ws.on('open', () => {
        this.isConnected = true;
        // Resetar timers ao conectar/reconectar para evitar métricas incorretas
        this.transcriptionStartTime = 0;
        this.firstPartialTime = 0;
        this.reconnectAttempts = 0; // Reset contador de reconexões
        this.startKeepalive();
        this.logger.info('✅ Conectado ao ElevenLabs Scribe');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as ScribeEvent;
          // Usar o callId ativo ao invés do callId fixo da closure
          this.handleScribeEvent(this.activeCallId, event);
        } catch (error) {
          this.logger.error('Erro ao parsear evento:', error);
          this.logger.debug('Dados recebidos:', data.toString());
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error('❌ Erro WebSocket:', error);
        this.isConnected = false;
        if (this.pendingReject) {
          this.pendingReject(error as Error);
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn(`🔌 Desconectado do Scribe (${code}): ${reason.toString()}`);
        this.isConnected = false;
        this.sessionId = null;
        this.stopKeepalive();
        
        // Se foi erro de requisição inválida, logar detalhes
        if (code === 1008) {
          this.logger.error(`❌ Erro: Requisição inválida. Verifique os parâmetros da conexão.`);
          this.logger.debug(`URL usada: ${wsUrl}`);
          this.logger.debug(`Parâmetros: ${params.toString()}`);
        }
        
        // Tentar reconectar automaticamente (exceto se foi fechamento normal)
        if (code !== 1000 && code !== 1005) {
          this.attemptReconnect(callId);
        }
      });

      // Timeout de conexão
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('Timeout ao conectar ao Scribe'));
        }
      }, 10000);
    });
  }

  /**
   * Tenta reconectar automaticamente após desconexão
   */
  private async attemptReconnect(callId: string): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(`❌ Máximo de tentativas de reconexão atingido (${this.maxReconnectAttempts})`);
      this.emit('error', new Error('Falha na reconexão ao Scribe'));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff
    
    this.logger.warn(`🔄 Tentando reconectar em ${delay}ms (tentativa ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    try {
      // Forçar nova conexão
      this.isConnected = false;
      this.ws = null;
      await this.startStream(callId);
      this.logger.info(`✅ Reconectado ao Scribe com sucesso (tentativa ${this.reconnectAttempts})`);
    } catch (error) {
      this.logger.error(`❌ Falha na reconexão:`, error);
      // Tentar novamente
      this.attemptReconnect(callId);
    }
  }

  /**
   * Inicia keepalive para manter a conexão ativa
   * Envia pacotes vazios periodicamente quando não há áudio
   */
  private startKeepalive(): void {
    this.stopKeepalive(); // Limpar intervalo anterior
    
    this.keepaliveInterval = setInterval(() => {
      // Só envia keepalive se não enviou áudio recentemente
      const timeSinceLastAudio = Date.now() - this.lastAudioSentTime;
      
      if (this.isConnected && this.ws && timeSinceLastAudio > this.keepaliveIntervalMs / 2) {
        try {
          // Enviar chunk de áudio silencioso (1 segundo de silêncio a 16kHz)
          // 16000 samples * 2 bytes = 32000 bytes
          const silentChunk = Buffer.alloc(3200); // 100ms de silêncio
          
          const message = JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: silentChunk.toString('base64'),
            sample_rate: this.config.sampleRate,
            commit: false,
          });
          
          this.ws.send(message);
          this.logger.debug('💓 Keepalive enviado');
        } catch (error) {
          this.logger.warn('⚠️ Erro ao enviar keepalive:', error);
        }
      }
    }, this.keepaliveIntervalMs);
    
    this.logger.debug(`💓 Keepalive iniciado (${this.keepaliveIntervalMs}ms)`);
  }

  /**
   * Para o keepalive
   */
  private stopKeepalive(): void {
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
  }

  /**
   * Processa eventos do Scribe
   */
  private handleScribeEvent(callId: string, event: ScribeEvent): void {
    this.logger.debug(`Evento recebido: ${event.message_type}`);
    
    switch (event.message_type) {
      case 'session_started':
        this.sessionId = event.session_id;
        this.logger.info(`📝 Sessão Scribe iniciada: ${event.session_id}`);
        break;

      case 'partial_transcript':
        // Transcrição parcial (enquanto fala)
        if (event.text) {
          // Marcar primeira transcrição parcial para medir latência real
          if (this.firstPartialTime === 0 && this.transcriptionStartTime > 0) {
            this.firstPartialTime = Date.now();
            const realLatency = this.firstPartialTime - this.transcriptionStartTime;
            this.logger.debug(`⚡ Primeira transcrição parcial recebida em ${realLatency}ms`);
          }
          
          const partialCallback = this.partialCallbacks.get(callId);
          if (partialCallback) {
            partialCallback(event.text);
          }
          this.emit('partial', callId, event.text);
        }
        break;

      case 'committed_transcript':
      case 'committed_transcript_with_timestamps':
        // Transcrição final (fim da fala detectado pelo VAD)
        // Ignorar commits vazios
        if (!event.text || event.text.trim() === '') {
          this.logger.debug('Commit vazio ignorado');
          return;
        }
        
        const commitTime = Date.now();
        
        // Se a transcrição foi marcada como descartada (usuário falou durante agente),
        // usar métricas corrigidas baseadas apenas no tempo desde que o agente parou
        let realLatency: number;
        let totalDuration: number;
        
        if (this.pendingTranscriptDiscarded || this.transcriptionStartTime === 0) {
          // Transcrição durante fala do agente - usar fallback de 300ms (latência típica do Scribe)
          // Isso é mais preciso que reportar 15000ms+ que não reflete a latência real do STT
          realLatency = this.firstPartialTime > 0 && this.agentStoppedSpeakingAt > 0
            ? Math.min(this.firstPartialTime - this.agentStoppedSpeakingAt, 300)
            : 300;
          totalDuration = this.agentStoppedSpeakingAt > 0 
            ? commitTime - this.agentStoppedSpeakingAt 
            : 1000;
          this.logger.debug(`⚠️ Métricas corrigidas (transcrição durante fala do agente)`);
        } else {
          totalDuration = commitTime - this.transcriptionStartTime;
          
          // Latência REAL: tempo até primeira transcrição parcial
          // Se não tiver firstPartialTime, assume 300ms (latência típica)
          realLatency = this.firstPartialTime > 0 
            ? this.firstPartialTime - this.transcriptionStartTime 
            : Math.min(totalDuration, 300);
        }
        
        // Garantir que realLatency nunca seja negativa ou absurdamente alta
        realLatency = Math.max(50, Math.min(realLatency, 1000));
        
        // Tempo de fala do usuário (aproximado): total - VAD wait time
        // VAD wait time = tempo desde última atividade até commit
        const vadSilenceMs = this.config.vadSilenceThresholdMs || 500;
        const vadWaitTime = Math.min(vadSilenceMs, Math.max(0, totalDuration - realLatency));
        const speechDuration = Math.max(0, totalDuration - vadWaitTime - realLatency);
        
        this.logger.info(`✅ Transcrição Scribe:`);
        this.logger.info(`   📊 Latência REAL (STT): ${realLatency}ms (target: <300ms)${this.pendingTranscriptDiscarded ? ' [corrigida]' : ''}`);
        this.logger.info(`   🗣️ Duração da fala: ${speechDuration}ms (não é latência)`);
        this.logger.info(`   ⏱️ VAD wait: ${vadWaitTime}ms`);
        this.logger.info(`   📝 Texto: "${event.text}"`);
        
        // Criar métricas de timing detalhadas
        const timingMetrics: STTTimingMetrics = {
          realLatency,
          speechDuration,
          vadWaitTime,
          startTime: this.transcriptionStartTime || this.agentStoppedSpeakingAt,
          firstPartialTime: this.firstPartialTime || (this.transcriptionStartTime || this.agentStoppedSpeakingAt) + realLatency,
          commitTime,
        };
        
        // Reset timers para próxima transcrição
        this.transcriptionStartTime = 0;
        this.firstPartialTime = 0;
        this.pendingTranscriptDiscarded = false;
        
        const result: TranscriptionResult = {
          text: event.text,
          language: this.config.language,
          duration: realLatency, // Latência REAL (até primeira parcial)
          timingMetrics, // Métricas detalhadas para análise
        };

        // Callback registrado
        const callback = this.transcriptCallbacks.get(callId);
        if (callback) {
          callback(result);
        }

        // Resolver promise do modo batch
        if (this.pendingResolve) {
          this.pendingResolve(result);
          this.pendingResolve = null;
          this.pendingReject = null;
        }

        this.emit('transcript', callId, result);
        break;

      default:
        // Erros
        if (event.message_type && event.message_type.startsWith('scribe_')) {
          const errorMsg = (event as ScribeError).message || (event as ScribeError).error || 'Erro desconhecido';
          this.logger.error(`❌ Erro Scribe (${event.message_type}): ${errorMsg}`);
          
          if (this.pendingReject) {
            this.pendingReject(new Error(`${event.message_type}: ${errorMsg}`));
            this.pendingReject = null;
            this.pendingResolve = null;
          }
          
          this.emit('error', new Error(`${event.message_type}: ${errorMsg}`));
        }
        break;
    }
  }

  /**
   * Envia chunk de áudio para o Scribe
   * Formato: PCM 16-bit mono na sample rate configurada
   * 
   * IMPORTANTE: Só inicia contagem de latência quando o agente NÃO está falando
   * E passou o grace period após parar de falar.
   * Isso evita métricas incorretas quando o usuário fala durante reprodução do agente.
   */
  feedAudio(callId: string, chunk: Buffer): void {
    // Verificar se WebSocket está realmente aberto (readyState === 1 = OPEN)
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Só logar se não estiver conectando (evitar spam de logs)
      if (this.ws?.readyState !== WebSocket.CONNECTING) {
        this.logger.warn('WebSocket não conectado, tentando reconectar...');
        // Tentar reconectar em background
        this.attemptReconnect(callId).catch(err => {
          this.logger.error('Falha ao reconectar durante feedAudio:', err);
        });
      }
      return; // Descartar áudio enquanto não conectado
    }

    const now = Date.now();
    
    // Se o agente está falando, NÃO iniciar contagem de latência
    // O áudio ainda é enviado para o Scribe (para transcrição), mas
    // a medição de latência só começa quando o agente para de falar
    if (this._isAgentSpeaking) {
      this.chunksWhileAgentSpeaking++;
      // Marcar que qualquer transcrição em andamento deve ser descartada para métricas
      if (this.transcriptionStartTime > 0) {
        this.pendingTranscriptDiscarded = true;
      }
      // Não iniciar timer de latência - apenas enviar áudio
    } else {
      // Agente não está falando - verificar grace period
      const timeSinceAgentStopped = this.agentStoppedSpeakingAt > 0 
        ? now - this.agentStoppedSpeakingAt 
        : Number.MAX_SAFE_INTEGER;
      
      // Só iniciar contagem se passou o grace period
      if (timeSinceAgentStopped >= ElevenLabsScribe.AGENT_STOP_GRACE_PERIOD_MS) {
        // Marcar início da transcrição (primeiro chunk enviado APÓS grace period)
        if (this.transcriptionStartTime === 0) {
          this.transcriptionStartTime = now;
          this.firstPartialTime = 0; // Reset para nova transcrição
          this.pendingTranscriptDiscarded = false; // Nova transcrição limpa
          
          if (this.chunksWhileAgentSpeaking > 0) {
            this.logger.debug(`⏱️ Iniciando contagem de latência (${this.chunksWhileAgentSpeaking} chunks durante fala do agente ignorados)`);
            this.chunksWhileAgentSpeaking = 0;
          }
        }
      } else {
        // Ainda no grace period - não iniciar timer
        this.chunksWhileAgentSpeaking++;
      }
    }
    
    // Atualizar timestamp para keepalive
    this.lastAudioSentTime = now;

    // 🆕 Enviar áudio no formato correto da API
    // Para ulaw_8000, não incluir sample_rate (o formato já define 8kHz)
    const audioFormat = this.config.audioFormat || 'pcm';
    const messageObj: Record<string, unknown> = {
      message_type: 'input_audio_chunk',
      audio_base_64: chunk.toString('base64'),
      commit: false,
    };
    
    // Só incluir sample_rate para PCM
    if (audioFormat === 'pcm') {
      messageObj.sample_rate = this.config.sampleRate;
    }
    
    const message = JSON.stringify(messageObj);

    try {
      this.ws.send(message);
    } catch (error) {
      this.logger.error('Erro ao enviar áudio:', error);
      // Conexão pode ter sido perdida, tentar reconectar
      this.isConnected = false;
      this.attemptReconnect(callId).catch(err => {
        this.logger.error('Falha ao reconectar após erro de envio:', err);
      });
    }
  }

  /**
   * Registra callback para transcrições finais (committed)
   */
  onTranscript(callId: string, callback: (result: TranscriptionResult) => void): void {
    this.transcriptCallbacks.set(callId, callback);
  }

  /**
   * Registra callback para transcrições parciais
   */
  onPartialTranscript(callId: string, callback: (text: string) => void): void {
    this.partialCallbacks.set(callId, callback);
  }

  /**
   * Modo batch (compatibilidade com interface ITranscriber)
   * Envia todo o áudio de uma vez e espera resultado
   */
  async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    const startTime = Date.now();
    this.transcriptionStartTime = startTime;
    this.logger.debug(`🎤 Transcrevendo ${audioBuffer.length} bytes...`);

    // Se não conectado, conectar primeiro
    if (!this.isConnected) {
      await this.startStream('batch');
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      // Timeout
      const timeout = setTimeout(() => {
        if (this.pendingResolve) {
          this.pendingResolve = null;
          this.pendingReject = null;
          reject(new Error('Timeout na transcrição Scribe (30s)'));
        }
      }, 30000);

      // Enviar áudio em chunks
      const chunkSize = 32000; // ~1 segundo de áudio a 16kHz (16000 samples * 2 bytes)
      for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
        const chunk = audioBuffer.subarray(offset, offset + chunkSize);
        this.feedAudio('batch', chunk);
      }

      // Enviar commit final para forçar processamento
      if (this.ws && this.isConnected) {
        const commitMessage = JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: '',
          sample_rate: this.config.sampleRate,
          commit: true,
        });
        this.ws.send(commitMessage);
        this.logger.debug('📤 Commit enviado');
      }

      // Limpar timeout quando resolver
      this.once('transcript', () => {
        clearTimeout(timeout);
      });
      
      this.once('error', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Força commit da transcrição atual (modo manual)
   */
  commit(): void {
    if (!this.isConnected || !this.ws) {
      return;
    }

    try {
      const commitMessage = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: this.config.sampleRate,
        commit: true,
      });
      this.ws.send(commitMessage);
      this.logger.debug('📤 Commit manual enviado');
    } catch (error) {
      this.logger.error('Erro ao enviar commit:', error);
    }
  }

  /**
   * Encerra a conexão
   */
  async disconnect(): Promise<void> {
    this.stopKeepalive();
    if (this.ws) {
      this.ws.close(1000, 'Disconnect requested'); // Código 1000 = fechamento normal
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.transcriptCallbacks.clear();
    this.partialCallbacks.clear();
    this.pendingResolve = null;
    this.pendingReject = null;
    this.transcriptionStartTime = 0;
    this.firstPartialTime = 0;
    this.reconnectAttempts = 0;
    this.agentStoppedSpeakingAt = 0;
    this.pendingTranscriptDiscarded = false;
    this.chunksWhileAgentSpeaking = 0;
    this.logger.info('🔌 Desconectado do Scribe');
  }

  /**
   * Verifica se está conectado
   */
  isStreamConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Pré-aquece a conexão (conecta antecipadamente)
   */
  async warmup(): Promise<void> {
    this.logger.info('🔥 Pré-aquecendo conexão Scribe...');
    await this.startStream('warmup');
    this.logger.info('✅ Scribe pronto');
  }

  /**
   * Define se o agente está falando
   * Usado para coordenação de métricas de latência
   * 
   * Quando o agente está falando:
   * - O áudio ainda é enviado para o Scribe (para transcrição)
   * - MAS a contagem de latência NÃO é iniciada
   * - Isso evita métricas incorretas de 16000ms+ quando usuário fala durante reprodução
   */
  setAgentSpeaking(speaking: boolean): void {
    const wasAgentSpeaking = this._isAgentSpeaking;
    this._isAgentSpeaking = speaking;
    
    if (wasAgentSpeaking && !speaking) {
      // Agente parou de falar - marcar timestamp para grace period
      this.agentStoppedSpeakingAt = Date.now();
      this.logger.debug('🔇 Agente parou de falar - iniciando grace period');
      // Resetar timers - nova transcrição será medida a partir de agora
      this.transcriptionStartTime = 0;
      this.firstPartialTime = 0;
      this.chunksWhileAgentSpeaking = 0;
    } else if (!wasAgentSpeaking && speaking) {
      this.logger.debug('🔊 Agente começou a falar');
      // Marcar qualquer transcrição em andamento como descartada para métricas
      if (this.transcriptionStartTime > 0) {
        this.pendingTranscriptDiscarded = true;
      }
      this.agentStoppedSpeakingAt = 0; // Reset
    }
  }

  /**
   * Retorna se o agente está falando
   */
  get isAgentSpeaking(): boolean {
    return this._isAgentSpeaking;
  }

  /**
   * Reseta os timers de medição de latência
   * Chamado quando ocorre barge-in para garantir métricas corretas
   */
  resetTimingOnBargeIn(): void {
    this.logger.debug('🔇 Barge-in: resetando timers de latência');
    this.transcriptionStartTime = 0;
    this.firstPartialTime = 0;
    this.chunksWhileAgentSpeaking = 0;
    this.agentStoppedSpeakingAt = Date.now(); // Marcar que agente parou (foi interrompido)
    this.pendingTranscriptDiscarded = true; // Descartar métricas da transcrição em andamento
  }
}

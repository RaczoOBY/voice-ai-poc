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
} from '../types';
import { Logger } from '../utils/Logger';

// URL do WebSocket do ElevenLabs Scribe
const SCRIBE_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

// Configuração do Scribe
export interface ElevenLabsScribeConfig {
  apiKey: string;
  modelId?: string;           // 'scribe_v2_realtime'
  sampleRate?: number;        // 16000 (padrão)
  language?: string;          // 'pt' para português
  vadSilenceThresholdMs?: number; // Tempo de silêncio para commit (500ms padrão)
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

  constructor(config: ElevenLabsScribeConfig) {
    super();
    this.setMaxListeners(50); // Evitar warning de memory leak
    this.config = {
      modelId: 'scribe_v2_realtime',
      sampleRate: 16000,
      language: 'pt',
      vadSilenceThresholdMs: 500,
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
      const vadSilenceThresholdSecs = (this.config.vadSilenceThresholdMs || 500) / 1000;
      
      const params = new URLSearchParams({
        model_id: this.config.modelId!,
        language_code: this.config.language!,
        commit_strategy: 'vad',
        vad_silence_threshold_secs: vadSilenceThresholdSecs.toString(),
        audio_format: `pcm_${this.config.sampleRate}`,
        include_timestamps: 'false',
      });

      const wsUrl = `${SCRIBE_WS_URL}?${params.toString()}`;
      
      this.logger.info('🔌 Conectando ao ElevenLabs Scribe...');
      this.logger.debug(`URL: ${wsUrl}`);
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'xi-api-key': this.config.apiKey,
        },
      });

      this.ws.on('open', () => {
        this.isConnected = true;
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
        this.logger.info(`🔌 Desconectado do Scribe (${code}): ${reason.toString()}`);
        this.isConnected = false;
        this.sessionId = null;
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
        
        const duration = Date.now() - this.transcriptionStartTime;
        this.logger.info(`✅ Transcrição Scribe (${duration}ms): "${event.text}"`);
        
        // Reset timer para próxima transcrição
        this.transcriptionStartTime = Date.now();
        
        const result: TranscriptionResult = {
          text: event.text,
          language: this.config.language,
          duration,
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
   */
  feedAudio(callId: string, chunk: Buffer): void {
    if (!this.isConnected || !this.ws) {
      this.logger.warn('WebSocket não conectado, ignorando chunk');
      return;
    }

    // Marcar início da transcrição
    if (this.transcriptionStartTime === 0) {
      this.transcriptionStartTime = Date.now();
    }

    // Enviar áudio no formato correto da API
    const message = JSON.stringify({
      message_type: 'input_audio_chunk',
      audio_base_64: chunk.toString('base64'),
      sample_rate: this.config.sampleRate,
      commit: false,
    });

    try {
      this.ws.send(message);
    } catch (error) {
      this.logger.error('Erro ao enviar áudio:', error);
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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.sessionId = null;
    this.transcriptCallbacks.clear();
    this.partialCallbacks.clear();
    this.pendingResolve = null;
    this.pendingReject = null;
    this.transcriptionStartTime = 0;
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
}

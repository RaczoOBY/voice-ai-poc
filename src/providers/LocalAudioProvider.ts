/**
 * LocalAudioProvider - Provider de áudio local para testes
 * 
 * Responsável por:
 * - Capturar áudio do microfone com VAD (Voice Activity Detection)
 * - Reproduzir áudio no alto-falante com streaming
 * - Suportar barge-in (interrupção pelo usuário)
 * 
 * Isso permite testar todo o pipeline STT → LLM → TTS sem telefonia
 */

import { EventEmitter } from 'events';
import { Writable } from 'stream';
import {
  ITelephonyProvider,
  TelnyxCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';

// Interface para Speaker
interface SpeakerOptions {
  channels?: number;
  bitDepth?: number;
  sampleRate?: number;
  signed?: boolean;
  float?: boolean;
  samplesPerFrame?: number;
}

interface SpeakerInstance extends Writable {
  close(flush?: boolean): void;
}

// Tipo para construtor do Speaker
type SpeakerConstructor = new (options: SpeakerOptions) => SpeakerInstance;

// Tipo para o módulo de gravação
interface RecordingInstance {
  stream(): NodeJS.ReadableStream;
  stop(): void;
  pause(): void;
  resume(): void;
}

interface RecordModule {
  record(options?: {
    sampleRate?: number;
    channels?: number;
    threshold?: number;
    silence?: string;
    recorder?: string;
    device?: string;
    endOnSilence?: boolean;
  }): RecordingInstance;
}

// Constantes de áudio - 22050Hz é o padrão do ElevenLabs PCM
const SAMPLE_RATE = 22050;
const CHANNELS = 1;
const BIT_DEPTH = 16;

// Configurações de VAD simples baseada em energia
const VAD_CONFIG = {
  ENERGY_THRESHOLD: 0.02,        // Threshold de energia para detectar fala
  SILENCE_DURATION_MS: 1000,     // 1s de silêncio = fim da fala
  MIN_SPEECH_DURATION_MS: 500,   // Mínimo de 500ms para considerar fala
  FRAME_SIZE_MS: 30,             // Tamanho do frame para análise (30ms)
  // Configurações de confirmação de barge-in
  BARGE_IN_CONFIRM_FRAMES: 5,    // Frames consecutivos com fala para confirmar barge-in (~150ms)
  BARGE_IN_ENERGY_MULTIPLIER: 1.5, // Energia deve ser 1.5x o threshold para barge-in
  // Proteção contra feedback (microfone capturando o speaker)
  // ⚠️ Se true: sem feedback, mas sem barge-in
  // ⚠️ Se false: com barge-in, mas pode ter feedback (use fones de ouvido!)
  MUTE_MIC_DURING_PLAYBACK: false,  // Desabilitado para permitir barge-in
  PLAYBACK_COOLDOWN_MS: 300,        // Esperar 300ms após parar de tocar antes de ouvir
};

export class LocalAudioProvider extends EventEmitter implements ITelephonyProvider {
  private logger: Logger;
  private isRecording: boolean = false;
  private isPlaying: boolean = false;
  private recorder: any = null;
  private currentSpeaker: SpeakerInstance | null = null;
  private Speaker: SpeakerConstructor | null = null;
  
  // Callbacks
  private audioCallbacks: Map<string, (audio: Buffer) => void> = new Map();
  private callEventCallback?: (event: TelnyxCallEvent) => void;
  
  // Estado do VAD
  private audioBuffer: Buffer[] = [];
  private isSpeaking: boolean = false;
  private silenceStart: number | null = null;
  private speechStart: number | null = null;
  
  // Estado de reprodução para barge-in
  private playbackInterrupted: boolean = false;
  private audioQueue: Buffer[] = [];
  
  // Confirmação de barge-in (evita falsos positivos)
  private consecutiveSpeechFrames: number = 0;
  private bargeInTriggered: boolean = false;
  
  // Proteção contra feedback de áudio
  private lastPlaybackEndTime: number = 0;
  
  // Lock para evitar inicialização múltipla simultânea
  private speakerInitPromise: Promise<void> | null = null;
  private speakerInitialized: boolean = false;

  constructor() {
    super();
    this.logger = new Logger('LocalAudio');
  }

  /**
   * Inicializa os módulos de áudio (lazy loading, com lock)
   */
  private async initAudioModules(): Promise<void> {
    // Se já inicializou, retorna imediatamente
    if (this.speakerInitialized) {
      return;
    }
    
    // Se está inicializando, espera a mesma Promise
    if (this.speakerInitPromise) {
      return this.speakerInitPromise;
    }
    
    // Inicia a inicialização com lock
    this.speakerInitPromise = (async () => {
      if (!this.Speaker) {
        try {
          // Dynamic import para evitar erros se não estiver instalado
          const speakerModule = await import('speaker');
          this.Speaker = speakerModule.default || speakerModule;
          this.speakerInitialized = true;
          this.logger.info('✅ Módulo speaker carregado');
        } catch (error) {
          this.logger.error('❌ Erro ao carregar speaker. Instale: npm install speaker');
          this.logger.error('   No macOS: brew install portaudio');
          this.speakerInitPromise = null; // Permite retry
          throw error;
        }
      }
    })();
    
    return this.speakerInitPromise;
  }

  /**
   * "Inicia uma chamada" - No modo local, apenas inicia a gravação
   */
  async makeCall(phoneNumber: string): Promise<string> {
    const callId = `local-${Date.now()}`;
    this.logger.info(`📞 Iniciando sessão local: ${callId}`);
    this.logger.info(`   (Número simulado: ${phoneNumber})`);
    
    // Simular evento de chamada iniciada
    this.emitCallEvent('call.initiated', callId);
    
    return callId;
  }

  /**
   * Inicia a captura de áudio do microfone
   */
  async startRecording(callId: string): Promise<void> {
    if (this.isRecording) {
      this.logger.warn('Já está gravando');
      return;
    }

    this.logger.info('🎙️ Iniciando captura do microfone...');

    try {
      const record = require('node-record-lpcm16');
      
      this.recorder = record.record({
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS,
        threshold: 0, // Captura tudo, VAD é feito manualmente
        recorder: 'sox', // Usa SoX no macOS/Linux
        silence: '10.0', // Não para por silêncio (controlamos via VAD)
        endOnSilence: false,
      });

      const audioStream = this.recorder.stream();
      this.isRecording = true;
      
      let chunkCount = 0;
      let lastLogTime = Date.now();
      
      // Processar chunks de áudio
      audioStream.on('data', (chunk: Buffer) => {
        chunkCount++;
        
        // Log a cada 3 segundos para confirmar que está recebendo áudio
        if (Date.now() - lastLogTime > 3000) {
          this.logger.debug(`🎤 Recebendo áudio: ${chunkCount} chunks (${chunk.length} bytes cada)`);
          lastLogTime = Date.now();
          chunkCount = 0;
        }
        
        this.processAudioChunk(callId, chunk);
      });

      audioStream.on('error', (error: Error) => {
        this.logger.error('❌ Erro no stream de áudio:', error);
        this.logger.error('   Verifique se o Terminal/Cursor tem permissão de microfone:');
        this.logger.error('   Configurações > Privacidade > Microfone');
      });

      this.logger.info('✅ Microfone ativo - Fale algo!');
      this.logger.info('💡 Se não funcionar, verifique as permissões em:');
      this.logger.info('   Configurações > Privacidade e Segurança > Microfone');
      
      // Simular evento de chamada atendida
      this.emitCallEvent('call.answered', callId);
      
    } catch (error) {
      this.logger.error('❌ Erro ao iniciar gravação:', error);
      this.logger.error('   Certifique-se de ter o SoX instalado: brew install sox');
      throw error;
    }
  }

  /**
   * Processa chunk de áudio e faz VAD simples
   * Com confirmação de barge-in para evitar falsos positivos
   * Com proteção contra feedback (microfone capturando speaker)
   */
  private processAudioChunk(callId: string, chunk: Buffer): void {
    const now = Date.now();
    
    // PROTEÇÃO CONTRA FEEDBACK:
    // Ignorar microfone enquanto está reproduzindo ou logo após parar
    if (VAD_CONFIG.MUTE_MIC_DURING_PLAYBACK) {
      const timeSincePlayback = now - this.lastPlaybackEndTime;
      
      // Se está reproduzindo, ignorar completamente
      if (this.isPlaying) {
        return;
      }
      
      // Se acabou de parar de reproduzir, esperar cooldown
      if (timeSincePlayback < VAD_CONFIG.PLAYBACK_COOLDOWN_MS) {
        return;
      }
    }
    
    // Calcular energia do chunk
    const energy = this.calculateEnergy(chunk);
    
    // Threshold mais alto para barge-in (evita ruídos)
    const bargeInThreshold = VAD_CONFIG.ENERGY_THRESHOLD * VAD_CONFIG.BARGE_IN_ENERGY_MULTIPLIER;
    
    // Detectar início de fala
    if (energy > VAD_CONFIG.ENERGY_THRESHOLD) {
      // Contar frames consecutivos de fala para confirmação
      this.consecutiveSpeechFrames++;
      
      if (!this.isSpeaking) {
        // Início de fala detectado
        this.isSpeaking = true;
        this.speechStart = now;
        this.silenceStart = null;
        this.audioBuffer = [];
        this.bargeInTriggered = false;
        
        this.logger.debug('🗣️ Possível fala detectada...');
      }
      
      // BARGE-IN com confirmação:
      // - Deve estar reproduzindo áudio
      // - Energia deve ser forte o suficiente (acima do threshold multiplicado)
      // - Deve ter frames consecutivos suficientes para confirmar que é fala
      // - Não deve ter sido triggered ainda nesta sessão de fala
      if (this.isPlaying && 
          !this.bargeInTriggered && 
          energy > bargeInThreshold &&
          this.consecutiveSpeechFrames >= VAD_CONFIG.BARGE_IN_CONFIRM_FRAMES) {
        this.logger.info(`🔇 Barge-in confirmado! (${this.consecutiveSpeechFrames} frames, energia: ${energy.toFixed(4)})`);
        this.stopPlayback();
        this.playbackInterrupted = true;
        this.bargeInTriggered = true;
        this.emit('playback:interrupted', callId);
      }
      
      this.audioBuffer.push(chunk);
      this.silenceStart = null;
      
    } else {
      // Silêncio - resetar contador de frames consecutivos
      this.consecutiveSpeechFrames = 0;
      
      if (this.isSpeaking) {
        // Silêncio durante fala
        this.audioBuffer.push(chunk);
        
        if (!this.silenceStart) {
          this.silenceStart = now;
        }
        
        // Verificar se silêncio é longo o suficiente para fim de fala
        const silenceDuration = now - this.silenceStart;
        if (silenceDuration >= VAD_CONFIG.SILENCE_DURATION_MS) {
          const speechDuration = now - (this.speechStart || now);
          
          // Só processa se a fala foi longa o suficiente
          if (speechDuration >= VAD_CONFIG.MIN_SPEECH_DURATION_MS) {
            this.logger.debug(`🤫 Fim da fala (${speechDuration}ms)`);
            
            // Concatenar buffer e enviar para processamento
            const fullAudio = Buffer.concat(this.audioBuffer);
            const callback = this.audioCallbacks.get(callId);
            
            if (callback) {
              callback(fullAudio);
            }
          }
          
          // Reset estado
          this.isSpeaking = false;
          this.speechStart = null;
          this.silenceStart = null;
          this.audioBuffer = [];
          this.bargeInTriggered = false;
        }
      }
    }
  }

  /**
   * Calcula energia RMS do chunk de áudio
   */
  private calculateEnergy(chunk: Buffer): number {
    let sum = 0;
    const samples = chunk.length / 2; // 16-bit = 2 bytes por sample
    
    for (let i = 0; i < chunk.length; i += 2) {
      const sample = chunk.readInt16LE(i) / 32768; // Normaliza para -1 a 1
      sum += sample * sample;
    }
    
    return Math.sqrt(sum / samples); // RMS
  }

  /**
   * Encerra a "chamada" - Para gravação e reprodução
   */
  async endCall(callId: string): Promise<void> {
    this.logger.info(`📴 Encerrando sessão ${callId}`);
    
    this.stopRecording();
    this.stopPlayback();
    
    this.audioCallbacks.delete(callId);
    this.emitCallEvent('call.hangup', callId);
    
    this.logger.info('✅ Sessão encerrada');
  }

  /**
   * Para a gravação do microfone
   */
  private stopRecording(): void {
    if (this.recorder) {
      this.recorder.stop();
      this.recorder = null;
      this.isRecording = false;
      this.logger.info('🎙️ Microfone parado');
    }
  }

  /**
   * Envia áudio para reprodução (batch)
   */
  async sendAudio(callId: string, audioBuffer: Buffer): Promise<void> {
    await this.initAudioModules();
    
    if (this.playbackInterrupted) {
      this.logger.debug('Reprodução cancelada (barge-in anterior)');
      this.playbackInterrupted = false;
      return;
    }

    this.logger.debug(`🔊 Reproduzindo ${audioBuffer.length} bytes...`);
    
    return new Promise((resolve, reject) => {
      if (!this.Speaker) {
        reject(new Error('Speaker não inicializado'));
        return;
      }

      this.isPlaying = true;
      
      this.currentSpeaker = new this.Speaker({
        channels: CHANNELS,
        bitDepth: BIT_DEPTH,
        sampleRate: SAMPLE_RATE,
        signed: true,
      });

      this.currentSpeaker.on('close', () => {
        this.isPlaying = false;
        this.currentSpeaker = null;
        resolve();
      });

      this.currentSpeaker.on('error', (error: Error) => {
        this.isPlaying = false;
        this.currentSpeaker = null;
        reject(error);
      });

      // Escreve todo o buffer
      this.currentSpeaker.write(audioBuffer);
      this.currentSpeaker.end();
    });
  }

  // Buffer para streaming com pre-buffer
  private streamBuffer: Buffer[] = [];
  private streamBufferSize: number = 0;
  private isStreamingStarted: boolean = false;
  private streamDrainInterval: NodeJS.Timeout | null = null;
  
  // Configuração do buffer de streaming
  // PRE_BUFFER: acumular este mínimo antes de começar a reproduzir
  // CHUNK_SIZE: tamanho ideal de cada chunk enviado ao speaker
  private static readonly PRE_BUFFER_MS = 200; // 200ms de buffer inicial
  private static readonly PRE_BUFFER_BYTES = Math.floor(SAMPLE_RATE * 2 * (200 / 1000)); // ~8820 bytes
  private static readonly DRAIN_INTERVAL_MS = 20; // Drenar buffer a cada 20ms
  private static readonly CHUNK_SIZE = Math.floor(SAMPLE_RATE * 2 * (20 / 1000)); // ~882 bytes por 20ms

  /**
   * Reseta o estado de interrupção para permitir nova reprodução
   */
  resetInterruptState(): void {
    this.playbackInterrupted = false;
  }

  /**
   * Envia áudio para reprodução em streaming (com buffer inteligente)
   * - Acumula um PRE_BUFFER antes de começar a reproduzir
   * - Preenche com silêncio se os chunks atrasarem
   */
  async sendAudioStream(callId: string, audioChunk: Buffer): Promise<void> {
    await this.initAudioModules();
    
    // Se foi interrompido, ignorar este chunk (mas não bloquear futuros)
    if (this.playbackInterrupted) {
      return;
    }

    // Adicionar ao buffer
    this.streamBuffer.push(audioChunk);
    this.streamBufferSize += audioChunk.length;

    // Se ainda não começou a reproduzir, verificar se temos buffer suficiente
    if (!this.isStreamingStarted) {
      if (this.streamBufferSize >= LocalAudioProvider.PRE_BUFFER_BYTES) {
        this.startStreamPlayback();
      }
      return;
    }
  }

  /**
   * Inicia a reprodução do stream após acumular buffer suficiente
   */
  private startStreamPlayback(): void {
    if (!this.Speaker || this.isStreamingStarted) return;

    this.isStreamingStarted = true;
    this.isPlaying = true;

    this.currentSpeaker = new this.Speaker({
      channels: CHANNELS,
      bitDepth: BIT_DEPTH,
      sampleRate: SAMPLE_RATE,
      signed: true,
    });

    this.currentSpeaker.on('close', () => {
      this.isPlaying = false;
      this.currentSpeaker = null;
      this.clearStreamState();
    });

    this.currentSpeaker.on('error', (error: Error) => {
      this.logger.error('Erro no speaker:', error);
      this.isPlaying = false;
      this.currentSpeaker = null;
      this.clearStreamState();
    });

    // Iniciar loop de drenagem do buffer
    this.streamDrainInterval = setInterval(() => {
      this.drainStreamBuffer();
    }, LocalAudioProvider.DRAIN_INTERVAL_MS);

    this.logger.debug('▶️ Streaming iniciado com buffer de ' + this.streamBufferSize + ' bytes');
  }

  /**
   * Drena o buffer de streaming, preenchendo com silêncio se necessário
   */
  private drainStreamBuffer(): void {
    if (!this.currentSpeaker || !this.isPlaying) {
      return;
    }

    const targetBytes = LocalAudioProvider.CHUNK_SIZE;
    
    if (this.streamBufferSize > 0) {
      // Temos dados no buffer - enviar
      const chunk = this.getFromStreamBuffer(targetBytes);
      this.currentSpeaker.write(chunk);
    } else {
      // Sem dados - enviar silêncio para evitar underflow
      const silence = Buffer.alloc(targetBytes, 0);
      this.currentSpeaker.write(silence);
    }
  }

  /**
   * Extrai bytes do buffer de streaming
   */
  private getFromStreamBuffer(bytes: number): Buffer {
    const chunks: Buffer[] = [];
    let collected = 0;

    while (collected < bytes && this.streamBuffer.length > 0) {
      const chunk = this.streamBuffer[0];
      const needed = bytes - collected;

      if (chunk.length <= needed) {
        // Usar chunk inteiro
        chunks.push(chunk);
        collected += chunk.length;
        this.streamBuffer.shift();
        this.streamBufferSize -= chunk.length;
      } else {
        // Usar parte do chunk
        chunks.push(chunk.subarray(0, needed));
        this.streamBuffer[0] = chunk.subarray(needed);
        this.streamBufferSize -= needed;
        collected += needed;
      }
    }

    // Se não coletamos o suficiente, preencher com silêncio
    if (collected < bytes) {
      chunks.push(Buffer.alloc(bytes - collected, 0));
    }

    return Buffer.concat(chunks);
  }

  /**
   * Limpa o estado do streaming
   */
  private clearStreamState(): void {
    if (this.streamDrainInterval) {
      clearInterval(this.streamDrainInterval);
      this.streamDrainInterval = null;
    }
    this.streamBuffer = [];
    this.streamBufferSize = 0;
    this.isStreamingStarted = false;
  }

  /**
   * Finaliza o streaming de áudio
   */
  endAudioStream(): void {
    // Drenar buffer restante
    if (this.currentSpeaker && this.isPlaying && this.streamBufferSize > 0) {
      const remaining = Buffer.concat(this.streamBuffer);
      this.currentSpeaker.write(remaining);
    }
    
    // Parar o loop de drenagem
    if (this.streamDrainInterval) {
      clearInterval(this.streamDrainInterval);
      this.streamDrainInterval = null;
    }

    // Finalizar speaker
    if (this.currentSpeaker && this.isPlaying) {
      this.currentSpeaker.end();
    }

    this.clearStreamState();
  }

  /**
   * Para a reprodução imediatamente (barge-in)
   */
  stopPlayback(): void {
    if (this.currentSpeaker) {
      try {
        this.currentSpeaker.close(false); // Fecha sem flush
      } catch {
        // Ignora erros ao fechar
      }
      this.currentSpeaker = null;
    }
    this.isPlaying = false;
    this.audioQueue = [];
  }

  /**
   * Registra callback para áudio capturado
   */
  onAudioReceived(callId: string, callback: (audio: Buffer) => void): void {
    this.audioCallbacks.set(callId, callback);
  }

  /**
   * Registra callback para eventos de chamada
   */
  onCallEvent(callback: (event: TelnyxCallEvent) => void): void {
    this.callEventCallback = callback;
  }

  /**
   * Emite evento de chamada (simulado)
   */
  private emitCallEvent(type: string, callId: string): void {
    const event: TelnyxCallEvent = {
      type: type as TelnyxCallEvent['type'],
      payload: {
        call_control_id: callId,
        call_leg_id: callId,
        call_session_id: callId,
        from: 'local-mic',
        to: 'local-speaker',
        state: type === 'call.hangup' ? 'ended' : 'active',
      },
    };

    if (this.callEventCallback) {
      this.callEventCallback(event);
    }
  }

  /**
   * Verifica se está reproduzindo áudio
   */
  isCurrentlyPlaying(): boolean {
    return this.isPlaying;
  }

  /**
   * Verifica se está gravando áudio
   */
  isCurrentlyRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Retorna status do provider
   */
  getStatus(): {
    isRecording: boolean;
    isPlaying: boolean;
    isSpeaking: boolean;
  } {
    return {
      isRecording: this.isRecording,
      isPlaying: this.isPlaying,
      isSpeaking: this.isSpeaking,
    };
  }
}

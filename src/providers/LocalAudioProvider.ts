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
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import {
  ITelephonyProvider,
  TelnyxCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';
import { config } from '../config';

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

// Constantes de áudio
// IMPORTANTE: Scribe (STT) usa 16000Hz, TTS usa 22050Hz
const MIC_SAMPLE_RATE = 16000;      // Para gravação do microfone (Scribe espera 16kHz)
const PLAYBACK_SAMPLE_RATE = 22050; // Para reprodução do TTS (ElevenLabs envia 22050Hz)
const CHANNELS = 1;
const BIT_DEPTH = 16;

// Configurações de VAD simples baseada em energia
const VAD_CONFIG = {
  ENERGY_THRESHOLD: 0.02,        // Threshold de energia para detectar fala
  SILENCE_DURATION_MS: 1000,     // 1s de silêncio = fim da fala
  MIN_SPEECH_DURATION_MS: 500,   // Mínimo de 500ms para considerar fala
  FRAME_SIZE_MS: 30,             // Tamanho do frame para análise (30ms)
  // Configurações de confirmação de barge-in - MAIS SENSÍVEL
  BARGE_IN_CONFIRM_FRAMES: 3,    // Frames consecutivos (~90ms) - reduzido de 5 para detecção mais rápida
  BARGE_IN_ENERGY_MULTIPLIER: 1.2, // Energia deve ser 1.2x o threshold - reduzido de 1.5 para maior sensibilidade
  // Proteção contra feedback (microfone capturando o speaker)
  // ⚠️ Se true: sem feedback, mas sem barge-in
  // ⚠️ Se false: com barge-in, mas pode ter feedback (use fones de ouvido!)
  MUTE_MIC_DURING_PLAYBACK: false,  // Desabilitado para permitir barge-in
  PLAYBACK_COOLDOWN_MS: 100,        // Esperar 100ms após parar de tocar (reduzido de 300ms)
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
  private audioChunkCallbacks: Map<string, (chunk: Buffer) => void> = new Map(); // Para streaming (Scribe)
  private callEventCallback?: (event: TelnyxCallEvent) => void;
  
  // Modo de VAD: 'internal' (manual) ou 'external' (Scribe)
  private vadMode: 'internal' | 'external' = 'internal';
  
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
  private static readonly PLAYBACK_COOLDOWN_MS = 100; // Esperar 100ms após parar de tocar (reduzido de 300ms)
  
  // Lock para evitar inicialização múltipla simultânea
  private speakerInitPromise: Promise<void> | null = null;
  private speakerInitialized: boolean = false;
  
  // Áudio de fundo (música ambiente)
  private backgroundMusicProcess: ChildProcess | null = null;
  private backgroundMusicEnabled: boolean = config.backgroundMusic?.enabled ?? true;
  private backgroundMusicVolume: number = config.backgroundMusic?.volume ?? 0.12;
  private backgroundMusicPath: string = path.resolve(process.cwd(), config.backgroundMusic?.filePath ?? 'src/audio/fundo.mp3');

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
        sampleRate: MIC_SAMPLE_RATE, // 16kHz para Scribe
        channels: CHANNELS,
        threshold: 0, // Captura tudo, VAD é feito manualmente
        recorder: 'sox', // Usa SoX no macOS/Linux
        silence: '10.0', // Não para por silêncio (controlamos via VAD)
        endOnSilence: false,
      });

      const audioStream = this.recorder.stream();
      this.isRecording = true;
      
      // Iniciar música de fundo
      this.startBackgroundMusic();
      
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
   * Processa chunk de áudio
   * 
   * Modo 'external' (Scribe): Envia chunks diretamente para o Scribe que tem VAD integrado
   * Modo 'internal' (Whisper): Faz VAD manual baseado em energia
   * 
   * Em ambos os modos, mantém a lógica de barge-in para interromper reprodução
   */
  private processAudioChunk(callId: string, chunk: Buffer): void {
    const now = Date.now();
    const energy = this.calculateEnergy(chunk);
    
    // MODO EXTERNO (Scribe): Envia chunks diretamente, VAD é feito pelo Scribe
    if (this.vadMode === 'external') {
      // PROTEÇÃO CONTRA FEEDBACK: Não enviar áudio para o Scribe enquanto está reproduzindo
      // ou logo após parar (evita transcrever o próprio áudio do agente)
      const timeSincePlayback = now - this.lastPlaybackEndTime;
      
      if (this.isPlaying) {
        // Enquanto está reproduzindo, apenas verificar barge-in, mas NÃO enviar para Scribe
        const bargeInThreshold = VAD_CONFIG.ENERGY_THRESHOLD * VAD_CONFIG.BARGE_IN_ENERGY_MULTIPLIER;
        
        // Log de debug para monitorar níveis de energia durante playback
        if (energy > VAD_CONFIG.ENERGY_THRESHOLD * 0.5) {
          this.logger.debug(`🎤 Durante playback: energia=${energy.toFixed(4)}, threshold=${bargeInThreshold.toFixed(4)}, frames=${this.consecutiveSpeechFrames}`);
        }
        
        if (energy > bargeInThreshold) {
          this.consecutiveSpeechFrames++;
          this.logger.debug(`🎤 Barge-in potencial: ${this.consecutiveSpeechFrames}/${VAD_CONFIG.BARGE_IN_CONFIRM_FRAMES} frames`);
          
          if (!this.bargeInTriggered && 
              this.consecutiveSpeechFrames >= VAD_CONFIG.BARGE_IN_CONFIRM_FRAMES) {
            this.logger.info(`🔇 Barge-in confirmado! (energia: ${energy.toFixed(4)})`);
            this.stopPlayback();
            this.playbackInterrupted = true;
            this.bargeInTriggered = true;
            this.emit('playback:interrupted', callId);
            // Após barge-in, resetar cooldown para começar a escutar imediatamente
            this.lastPlaybackEndTime = Date.now() - LocalAudioProvider.PLAYBACK_COOLDOWN_MS;
          }
        } else {
          // Resetar apenas se energia caiu significativamente
          if (this.consecutiveSpeechFrames > 0) {
            this.logger.debug(`🎤 Barge-in reset: energia muito baixa (${energy.toFixed(4)})`);
          }
          this.consecutiveSpeechFrames = 0;
          this.bargeInTriggered = false;
        }
        return; // Não enviar para Scribe enquanto está reproduzindo
      }
      
      // Se acabou de parar de reproduzir, esperar cooldown antes de enviar para Scribe
      // (exceto se foi barge-in, que já resetou o cooldown)
      if (timeSincePlayback < LocalAudioProvider.PLAYBACK_COOLDOWN_MS) {
        return; // Ainda em cooldown, não enviar
      }
      
      // Agora sim, enviar chunk para o Scribe em tempo real
      const chunkCallback = this.audioChunkCallbacks.get(callId);
      if (chunkCallback) {
        chunkCallback(chunk);
      } else {
        // Log apenas em debug para não poluir logs, mas importante para diagnóstico
        if (this.logger) {
          this.logger.debug(`⚠️ Nenhum callback registrado para callId: ${callId}`);
        }
      }
      
      // Resetar flag de barge-in quando não há mais reprodução
      if (this.bargeInTriggered && !this.isPlaying) {
        this.bargeInTriggered = false;
        this.consecutiveSpeechFrames = 0;
      }
      
      return;
    }
    
    // MODO INTERNO (Whisper): VAD manual baseado em energia
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
    this.stopBackgroundMusic();
    
    this.audioCallbacks.delete(callId);
    this.emitCallEvent('call.hangup', callId);
    
    this.logger.info('✅ Sessão encerrada');
  }

  /**
   * Inicia a música de fundo em loop
   * Usa afplay no macOS com volume baixo
   */
  startBackgroundMusic(): void {
    this.logger.debug(`🎵 startBackgroundMusic chamado - enabled: ${this.backgroundMusicEnabled}`);
    
    if (!this.backgroundMusicEnabled) {
      this.logger.debug('🎵 Música de fundo desabilitada nas configurações');
      return;
    }

    if (this.backgroundMusicProcess) {
      this.logger.debug('🎵 Música de fundo já está tocando');
      return;
    }

    try {
      // Verificar se o arquivo existe
      const fs = require('fs');
      this.logger.debug(`🎵 Verificando arquivo: ${this.backgroundMusicPath}`);
      
      if (!fs.existsSync(this.backgroundMusicPath)) {
        this.logger.warn(`⚠️ Arquivo de música de fundo não encontrado: ${this.backgroundMusicPath}`);
        this.logger.warn(`   CWD: ${process.cwd()}`);
        return;
      }
      
      this.logger.debug(`🎵 Arquivo encontrado! Iniciando player...`);

      // Detectar SO e usar player apropriado
      const platform = process.platform;
      
      if (platform === 'darwin') {
        // macOS: usar afplay com volume baixo
        this.startBackgroundMusicLoop();
      } else if (platform === 'linux') {
        this.logger.warn('⚠️ Música de fundo não suportada no Linux ainda');
      } else {
        this.logger.warn(`⚠️ Música de fundo não suportada no ${platform}`);
      }
    } catch (error) {
      this.logger.error('❌ Erro ao iniciar música de fundo:', error);
    }
  }

  /**
   * Loop de música de fundo para macOS
   */
  private startBackgroundMusicLoop(): void {
    const playOnce = () => {
      if (!this.backgroundMusicEnabled) {
        return;
      }

      this.logger.debug(`🎵 Tocando: ${this.backgroundMusicPath} (volume: ${this.backgroundMusicVolume})`);
      
      // afplay -v volume (0.0 a 1.0)
      this.backgroundMusicProcess = spawn('afplay', [
        '-v', this.backgroundMusicVolume.toString(),
        this.backgroundMusicPath,
      ]);

      this.backgroundMusicProcess.on('exit', (code, signal) => {
        this.logger.debug(`🎵 afplay exit: code=${code}, signal=${signal}`);
        // Se terminou normalmente (code 0), reiniciar para loop
        if (code === 0 && this.backgroundMusicEnabled) {
          // Pequeno delay antes de reiniciar
          setTimeout(() => playOnce(), 100);
        }
      });

      this.backgroundMusicProcess.on('error', (err) => {
        this.logger.error('❌ Erro no player de música de fundo:', err);
        this.backgroundMusicProcess = null;
      });
      
      // Capturar stderr para debug
      this.backgroundMusicProcess.stderr?.on('data', (data) => {
        this.logger.warn(`⚠️ afplay stderr: ${data.toString()}`);
      });
    };

    this.logger.info(`🎵 Música de fundo iniciada (volume: ${Math.round(this.backgroundMusicVolume * 100)}%)`);
    this.logger.info(`   Arquivo: ${this.backgroundMusicPath}`);
    playOnce();
  }

  /**
   * Para a música de fundo
   */
  stopBackgroundMusic(): void {
    if (this.backgroundMusicProcess) {
      this.backgroundMusicProcess.kill();
      this.backgroundMusicProcess = null;
      this.logger.info('🎵 Música de fundo parada');
    }
  }

  /**
   * Habilita/desabilita música de fundo
   */
  setBackgroundMusicEnabled(enabled: boolean): void {
    this.backgroundMusicEnabled = enabled;
    if (!enabled) {
      this.stopBackgroundMusic();
    }
  }

  /**
   * Define o volume da música de fundo (0.0 a 1.0)
   */
  setBackgroundMusicVolume(volume: number): void {
    this.backgroundMusicVolume = Math.max(0, Math.min(1, volume));
    this.logger.info(`🎵 Volume da música de fundo: ${this.backgroundMusicVolume * 100}%`);
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
        sampleRate: PLAYBACK_SAMPLE_RATE, // 22050Hz para TTS
        signed: true,
      });

      this.currentSpeaker.on('close', () => {
        this.isPlaying = false;
        this.lastPlaybackEndTime = Date.now();
        this.currentSpeaker = null;
        resolve();
      });

      this.currentSpeaker.on('error', (error: Error) => {
        this.isPlaying = false;
        this.lastPlaybackEndTime = Date.now();
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
  
  // Configuração do buffer de streaming (para playback a 22050Hz)
  // PRE_BUFFER: acumular este mínimo antes de começar a reproduzir
  // CHUNK_SIZE: tamanho ideal de cada chunk enviado ao speaker
  private static readonly PRE_BUFFER_MS = 200; // 200ms de buffer inicial
  private static readonly PRE_BUFFER_BYTES = Math.floor(PLAYBACK_SAMPLE_RATE * 2 * (200 / 1000)); // ~8820 bytes
  private static readonly DRAIN_INTERVAL_MS = 20; // Drenar buffer a cada 20ms
  private static readonly CHUNK_SIZE = Math.floor(PLAYBACK_SAMPLE_RATE * 2 * (20 / 1000)); // ~882 bytes por 20ms

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
      sampleRate: PLAYBACK_SAMPLE_RATE, // 22050Hz para TTS
      signed: true,
    });

    this.currentSpeaker.on('close', () => {
      this.isPlaying = false;
      this.lastPlaybackEndTime = Date.now();
      this.currentSpeaker = null;
      this.clearStreamState();
    });

    this.currentSpeaker.on('error', (error: Error) => {
      this.logger.error('Erro no speaker:', error);
      this.isPlaying = false;
      this.lastPlaybackEndTime = Date.now();
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
      // lastPlaybackEndTime será atualizado no evento 'close' do speaker
    } else if (this.isPlaying) {
      // Se não há speaker mas ainda está marcado como playing, atualizar manualmente
      this.isPlaying = false;
      this.lastPlaybackEndTime = Date.now();
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
    this.lastPlaybackEndTime = Date.now();
    this.audioQueue = [];
  }

  /**
   * Registra callback para áudio capturado (após VAD detectar fim da fala)
   * Usado no modo 'internal' VAD (OpenAI Whisper)
   */
  onAudioReceived(callId: string, callback: (audio: Buffer) => void): void {
    this.audioCallbacks.set(callId, callback);
  }

  /**
   * Registra callback para chunks de áudio em tempo real
   * Usado no modo 'external' VAD (ElevenLabs Scribe)
   * Cada chunk é enviado imediatamente sem esperar VAD
   */
  onAudioChunk(callId: string, callback: (chunk: Buffer) => void): void {
    this.audioChunkCallbacks.set(callId, callback);
  }

  /**
   * Define o modo de VAD
   * - 'internal': VAD manual baseado em energia (para OpenAI Whisper)
   * - 'external': Repassa chunks diretamente (para ElevenLabs Scribe com VAD integrado)
   */
  setVADMode(mode: 'internal' | 'external'): void {
    this.vadMode = mode;
    this.logger.info(`🎛️ Modo VAD: ${mode === 'internal' ? 'Interno (manual)' : 'Externo (Scribe)'}`);
  }

  /**
   * Retorna o modo de VAD atual
   */
  getVADMode(): 'internal' | 'external' {
    return this.vadMode;
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

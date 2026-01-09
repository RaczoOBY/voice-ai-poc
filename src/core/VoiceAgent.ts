/**
 * VoiceAgent - Orquestrador principal do sistema
 * 
 * Responsável por:
 * - Gerenciar o fluxo de chamadas
 * - Coordenar STT → LLM → TTS (com streaming)
 * - Usar fillers para reduzir latência percebida
 * - Suporte a barge-in (interrupção)
 * - Gravação de chamadas
 * - Coletar métricas detalhadas
 */

import { EventEmitter } from 'events';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import {
  VoiceAgentConfig,
  VoiceAgentEvents,
  CallSession,
  ConversationTurn,
  TurnMetrics,
  FillerContext,
  CallSummary,
  LatencyBreakdown,
  TelephonyCallEvent,
  TelnyxCallEvent,
  TwilioCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';
import { config as globalConfig } from '../config';
import { VoiceIntelligence } from './VoiceIntelligence';
import { TurnStateManager } from './TurnStateManager';
import { EchoFilter } from './EchoFilter';
import { AcknowledgmentManager } from './AcknowledgmentManager';

// Configurações de streaming LLM → TTS
const STREAMING_CONFIG = {
  MIN_CHARS_FOR_TTS: 60,           // Mínimo de caracteres antes de enviar para TTS
  SENTENCE_DELIMITERS: ['.', '!', '?', ':', ';'], // Delimitadores de frase
  MAX_BUFFER_CHARS: 200,           // Máximo antes de forçar flush
};

export class VoiceAgent extends EventEmitter {
  private config: VoiceAgentConfig;
  private activeCalls: Map<string, CallSession> = new Map();
  private logger: Logger;
  
  // Mapa de conexões Twilio Media Stream: callSid -> { ws, streamSid }
  private twilioStreams: Map<string, { ws: WebSocket; streamSid: string }> = new Map();
  
  // Barge-in: controle de interrupção
  private isPlayingAudio: Map<string, boolean> = new Map();
  private bargeInDetected: Map<string, boolean> = new Map();
  
  // Gravação de chamadas
  private callRecordings: Map<string, { userAudio: Buffer[]; agentAudio: Buffer[]; transcript: any[] }> = new Map();
  
  // Fila de TTS para serializar streams e evitar sobreposição de áudio
  private ttsQueue: Map<string, Promise<void>> = new Map();
  
  // Controle de processamento para evitar turnos simultâneos e agregar transcrições
  private isProcessing: Map<string, boolean> = new Map();
  private pendingTranscription: Map<string, string> = new Map();
  private transcriptionDebounceTimer: Map<string, NodeJS.Timeout> = new Map();
  // Debounce adaptativo: menor para streaming (Scribe já faz VAD), maior para batch
  private static readonly TRANSCRIPTION_DEBOUNCE_STREAMING_MS = 150; // Streaming STT (Scribe) - já faz VAD
  private static readonly TRANSCRIPTION_DEBOUNCE_BATCH_MS = 800; // Batch STT (Whisper) - precisa agregar
  
  // 🆕 Detecção de continuação (paridade com StreamingVoiceAgent)
  private continuationDetected: Map<string, boolean> = new Map();
  private shouldCancelProcessing: Map<string, boolean> = new Map();
  private hasStartedPlayback: Map<string, boolean> = new Map();
  private lastAcknowledgmentTime: Map<string, number> = new Map();
  private static readonly ACKNOWLEDGMENT_COOLDOWN_MS = 3000; // Cooldown entre acknowledgments
  
  // 🆕 Texto parcial capturado durante barge-in (caso Scribe não termine antes de desligar)
  private pendingBargeInText: Map<string, string> = new Map();
  
  // Rastreamento de duração da reprodução (para detectar barge-in durante playback no Twilio)
  private audioPlaybackEndTime: Map<string, number> = new Map();
  private totalAudioBytesSent: Map<string, number> = new Map();
  private audioPlaybackStartTime: Map<string, number> = new Map();
  
  // Grace period para evitar falsos positivos de barge-in por eco
  private static readonly BARGE_IN_GRACE_PERIOD_MS = 1500; // Ignora barge-in nos primeiros 1.5s de cada resposta
  private static readonly BARGE_IN_RMS_THRESHOLD = 800; // Threshold de energia
  // NOTA: Durante a saudação, barge-in é desabilitado completamente (não apenas grace period)
  // Isso permite que o usuário diga "Alô?" naturalmente sem interromper a apresentação
  
  // 🆕 Flag para indicar que a saudação está em andamento
  private isGreetingPlaying: Map<string, boolean> = new Map();
  
  // 🆕 Buffer para transcrições durante saudação (combinadas com próxima fala)
  private greetingTranscription: Map<string, string> = new Map();
  
  // 🆕 Controle de throttling para evitar queue_overflow no Scribe
  // IMPORTANTE: Agora usa BUFFER em vez de descartar chunks
  private lastAudioSentTime: Map<string, number> = new Map();
  private audioAccumulationBuffer: Map<string, Buffer[]> = new Map(); // Buffer para acumular chunks
  private static readonly MIN_AUDIO_INTERVAL_MS = 40; // Intervalo de envio ao Scribe (40ms = 25 envios/s)
  private static readonly MAX_BUFFER_SIZE_BYTES = 3200; // Máximo de ~400ms de áudio μ-law 8kHz antes de flush

  // Camada de inteligência centralizada (pensamentos, contexto, etc)
  private intelligence: VoiceIntelligence;
  
  // Módulos de gerenciamento de estado (compartilhados com StreamingVoiceAgent)
  private turnState: TurnStateManager;
  private echoFilter: EchoFilter;
  private acknowledgmentManager: AcknowledgmentManager;

  constructor(config: VoiceAgentConfig) {
    super();
    this.config = config;
    this.logger = new Logger('VoiceAgent');
    
    // Inicializar camada de inteligência
    this.intelligence = new VoiceIntelligence({
      llm: config.llm,
      systemPrompt: config.systemPrompt,
      enableThinking: globalConfig.thinkingEngine?.enabled ?? false,
    });
    
    // Inicializar módulos de gerenciamento de estado
    this.turnState = new TurnStateManager();
    this.echoFilter = new EchoFilter();
    this.acknowledgmentManager = new AcknowledgmentManager(config.tts);
    
    // Pré-carregar acknowledgments em background
    this.acknowledgmentManager.preload().catch(err => {
      this.logger.warn('Erro ao pré-carregar acknowledgments (não crítico):', err);
    });
  }

  /**
   * Envia áudio para a chamada (detecta automaticamente Twilio ou Telnyx)
   */
  private async sendAudioToCall(callId: string, audioBuffer: Buffer): Promise<void> {
    // Verificar se é uma chamada Twilio (tem stream registrado)
    const twilioStream = this.twilioStreams.get(callId);
    
    if (twilioStream) {
      // É Twilio - enviar via WebSocket diretamente
      this.sendTwilioAudio(callId, audioBuffer);
    } else {
      // É Telnyx ou outro - usar o provider
      await this.config.telephony.sendAudio(callId, audioBuffer);
    }
  }

  // Tabela de lookup para conversão linear → μ-law (mais precisa)
  private static readonly LINEAR_TO_MULAW: number[] = (() => {
    const table: number[] = new Array(65536);
    for (let i = 0; i < 65536; i++) {
      // Converter de unsigned para signed
      let sample = i < 32768 ? i : i - 65536;
      
      const BIAS = 0x84;
      const CLIP = 32635;
      const sign = (sample >> 8) & 0x80;
      
      if (sign !== 0) sample = -sample;
      if (sample > CLIP) sample = CLIP;
      
      sample = sample + BIAS;
      
      let exponent = 7;
      for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
      
      const mantissa = (sample >> (exponent + 3)) & 0x0F;
      const mulaw = ~(sign | (exponent << 4) | mantissa);
      
      table[i] = mulaw & 0xFF;
    }
    return table;
  })();

  // Tabela de lookup para conversão μ-law → linear
  private static readonly MULAW_TO_LINEAR: number[] = (() => {
    const table: number[] = new Array(256);
    for (let i = 0; i < 256; i++) {
      const mulaw = ~i;
      const sign = mulaw & 0x80;
      const exponent = (mulaw >> 4) & 0x07;
      const mantissa = mulaw & 0x0F;
      let sample = ((mantissa << 3) + 0x84) << exponent;
      sample -= 0x84;
      table[i] = sign !== 0 ? -sample : sample;
    }
    return table;
  })();

  /**
   * Converte PCM 16-bit 16kHz para μ-law 8kHz (formato Twilio)
   */
  private convertPcmToMulaw(pcmBuffer: Buffer): Buffer {
    const inputSamples = pcmBuffer.length / 2;
    const outputSamples = Math.floor(inputSamples / 2); // Downsample 2x
    const mulawBuffer = Buffer.alloc(outputSamples);
    
    for (let i = 0; i < outputSamples; i++) {
      // Ler sample PCM 16-bit e fazer média com o próximo (anti-aliasing simples)
      const sample1 = pcmBuffer.readInt16LE(i * 4);
      const sample2 = pcmBuffer.readInt16LE(i * 4 + 2);
      const avgSample = Math.round((sample1 + sample2) / 2);
      
      // Converter para unsigned e usar tabela de lookup
      const unsigned = avgSample < 0 ? avgSample + 65536 : avgSample;
      mulawBuffer[i] = VoiceAgent.LINEAR_TO_MULAW[unsigned];
    }
    
    return mulawBuffer;
  }

  /**
   * Converte μ-law 8kHz para PCM 16-bit 16kHz (para STT)
   */
  private convertMulawToPcm(mulawBuffer: Buffer): Buffer {
    // Upsample 2x (8kHz → 16kHz) com interpolação linear
    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 4); // 2x samples, 2 bytes cada
    
    for (let i = 0; i < mulawBuffer.length; i++) {
      const sample = VoiceAgent.MULAW_TO_LINEAR[mulawBuffer[i]];
      const nextSample = i < mulawBuffer.length - 1 
        ? VoiceAgent.MULAW_TO_LINEAR[mulawBuffer[i + 1]]
        : sample;
      
      // Escrever sample original
      pcmBuffer.writeInt16LE(sample, i * 4);
      // Interpolar para o sample intermediário
      pcmBuffer.writeInt16LE(Math.round((sample + nextSample) / 2), i * 4 + 2);
    }
    
    return pcmBuffer;
  }

  /**
   * Envia áudio para Twilio Media Stream
   * Se outputFormat='ulaw_8000', envia direto. Senão, converte PCM 16kHz para mulaw 8kHz
   */
  private sendTwilioAudio(callId: string, audioBuffer: Buffer): void {
    const stream = this.twilioStreams.get(callId);
    if (!stream) {
      this.logger.warn(`Twilio stream não encontrado para call ${callId}`);
      return;
    }

    const { ws, streamSid } = stream;
    if (ws.readyState !== WebSocket.OPEN) {
      this.logger.warn(`WebSocket não está aberto para call ${callId}`);
      return;
    }

    // Verificar se já está em μ-law (ElevenLabs outputFormat='ulaw_8000')
    const isAlreadyMulaw = globalConfig.elevenlabs?.outputFormat === 'ulaw_8000';
    const mulawBuffer = isAlreadyMulaw ? audioBuffer : this.convertPcmToMulaw(audioBuffer);
    
    // Rastrear bytes enviados para calcular tempo de reprodução
    // μ-law 8kHz = 8000 bytes/segundo
    const currentBytes = this.totalAudioBytesSent.get(callId) || 0;
    const newTotalBytes = currentBytes + mulawBuffer.length;
    this.totalAudioBytesSent.set(callId, newTotalBytes);
    
    // Calcular duração do chunk atual em ms
    const chunkDurationMs = (mulawBuffer.length / 8000) * 1000;
    const now = Date.now();
    const currentEndTime = this.audioPlaybackEndTime.get(callId) || 0;
    
    // Se já tem um tempo de término no futuro, adicionar a duração do novo chunk
    // Senão, começar do agora + duração do chunk
    let newEndTime: number;
    if (currentEndTime > now) {
      // Áudio já está em reprodução - adicionar ao final
      newEndTime = currentEndTime + chunkDurationMs;
    } else {
      // Primeiro chunk ou áudio anterior já terminou
      newEndTime = now + chunkDurationMs;
    }
    
    this.audioPlaybackEndTime.set(callId, newEndTime);
    
    // Calcular tempo total de áudio restante para reprodução
    const totalRemainingMs = newEndTime - now;
    this.logger.debug(`📊 Áudio: +${Math.round(chunkDurationMs)}ms, total restante: ${Math.round(totalRemainingMs)}ms, termina em: ${new Date(newEndTime).toISOString().substring(11, 23)}`);
    
    // Enviar áudio em chunks de 20ms (160 samples a 8kHz = 160 bytes)
    const chunkSize = 160;
    const totalChunks = Math.ceil(mulawBuffer.length / chunkSize);
    
    for (let i = 0; i < mulawBuffer.length; i += chunkSize) {
      const chunk = mulawBuffer.subarray(i, Math.min(i + chunkSize, mulawBuffer.length));
      const base64Audio = chunk.toString('base64');
      
      const message = JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: base64Audio,
        },
      });

      ws.send(message);
    }
  }

  /**
   * Inicia o servidor HTTP para webhooks
   */
  async start(port: number): Promise<void> {
    const server = createServer(this.handleWebhook.bind(this));
    
    // Criar WebSocket servers sem path (vamos rotear manualmente)
    const wssAudio = new WebSocket.Server({ noServer: true });
    this.setupAudioWebSocket(wssAudio);
    
    const wssMediaStream = new WebSocket.Server({ noServer: true });
    this.setupTwilioMediaStream(wssMediaStream);
    
    // Handler para upgrade de conexão WebSocket
    server.on('upgrade', (request, socket, head) => {
      const pathname = request.url || '';
      this.logger.info(`🔌 WebSocket upgrade request: ${pathname}`);
      
      if (pathname === '/audio' || pathname.startsWith('/audio?')) {
        wssAudio.handleUpgrade(request, socket, head, (ws) => {
          wssAudio.emit('connection', ws, request);
        });
      } else if (pathname === '/media-stream' || pathname.startsWith('/media-stream?')) {
        wssMediaStream.handleUpgrade(request, socket, head, (ws) => {
          wssMediaStream.emit('connection', ws, request);
        });
      } else {
        this.logger.warn(`🔌 WebSocket path não reconhecido: ${pathname}`);
        socket.destroy();
      }
    });
    
    server.listen(port, () => {
      this.logger.info(`🎧 Voice Agent listening on port ${port}`);
      this.logger.info(`🔌 WebSocket Telnyx ready at ws://localhost:${port}/audio`);
      this.logger.info(`🔌 WebSocket Twilio ready at ws://localhost:${port}/media-stream`);
    });

    // Configurar handlers de eventos de telefonia
    this.config.telephony.onCallEvent((event) => {
      this.handleTelephonyEvent(event);
    });
  }

  /**
   * Configura WebSocket server para Twilio Media Streams
   */
  private setupTwilioMediaStream(wss: WebSocket.Server): void {
    wss.on('connection', (ws) => {
      this.logger.info(`🔌 Twilio Media Stream conectado`);

      let currentCallSid: string | null = null;
      let audioBuffer: Buffer[] = [];
      let sttReady = false; // Flag para indicar quando o STT está pronto

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          
          switch (message.event) {
            case 'connected':
              this.logger.info('📡 Twilio Media Stream: connected');
              break;

            case 'start':
              currentCallSid = message.start?.callSid;
              const streamSid = message.start?.streamSid;
              this.logger.info(`🎙️ Twilio Media Stream: start (call=${currentCallSid}, stream=${streamSid})`);
              this.logger.info(`📊 Formato: ${JSON.stringify(message.start?.mediaFormat)}`);
              
              // Guardar referência do WebSocket para enviar áudio depois
              if (currentCallSid && streamSid) {
                this.twilioStreams.set(currentCallSid, { ws, streamSid });
                this.logger.info(`✅ Stream registrado para call ${currentCallSid}`);
              }
              
              // Iniciar sessão de chamada (async IIFE para aguardar STT)
              if (currentCallSid && !this.activeCalls.has(currentCallSid)) {
                const callSid = currentCallSid; // Capturar para closure
                
                this.activeCalls.set(callSid, {
                  id: callSid,
                  phoneNumber: message.start?.customParameters?.to || 'unknown',
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
                });
                
                // Inicializar módulos de gerenciamento de estado para esta chamada
                this.turnState.initSession(callSid);
                this.echoFilter.initSession(callSid);
                
                // Async: iniciar STT e saudação
                (async () => {
                  // Iniciar stream de transcrição (STT) - AGUARDAR conexão
                  if (this.config.transcriber.startStream && this.config.transcriber.onTranscript) {
                    this.logger.info(`🎤 Iniciando STT streaming para call ${callSid}`);
                    
                    try {
                      await this.config.transcriber.startStream(callSid);
                      sttReady = true;
                      this.logger.info(`✅ STT streaming pronto para call ${callSid}`);
                    } catch (error) {
                      this.logger.error(`❌ Falha ao iniciar STT streaming:`, error);
                    }
                    
                    // 🆕 Configurar callback para transcrições PARCIAIS (detecção de continuação e barge-in)
                    if (this.config.transcriber.onPartialTranscript) {
                      this.config.transcriber.onPartialTranscript(callSid, (text) => {
                        const trimmedText = text.trim();
                        if (trimmedText.length < 5) return; // Ignorar transcrições muito curtas
                        
                        // Detectar continuação: usuário continua falando durante processamento
                        if (this.isProcessing.get(callSid) && !this.hasStartedPlayback.get(callSid)) {
                          // CASO 1: Processando mas áudio ainda não começou - cancelar e aguardar
                          if (!this.shouldCancelProcessing.get(callSid)) {
                            this.logger.info(`🔄 Usuário continuou falando: "${trimmedText.substring(0, 30)}..." - cancelando processamento`);
                            this.shouldCancelProcessing.set(callSid, true);
                            this.continuationDetected.set(callSid, true);
                            
                            // 🎵 Tocar acknowledgment ("Uhum")
                            this.playAcknowledgment(callSid);
                          }
                        } else if (this.hasStartedPlayback.get(callSid) || this.isPlayingAudio.get(callSid)) {
                          // CASO 2: Áudio tocando - salvar texto parcial para barge-in
                          // 🆕 IMPORTANTE: Salvar mesmo que barge-in ainda não tenha sido detectado
                          // Se o usuário desligar antes do Scribe terminar, usamos este texto
                          const existingPartial = this.pendingBargeInText.get(callSid) || '';
                          // Só atualizar se o novo texto for diferente e mais longo
                          if (trimmedText !== existingPartial && trimmedText.length > existingPartial.length) {
                            this.logger.info(`👂 Texto parcial durante playback: "${trimmedText.substring(0, 40)}..."`);
                            this.pendingBargeInText.set(callSid, trimmedText);
                          }
                        }
                      });
                    }
                    
                    // Configurar callback para transcrições FINAIS (committed)
                    this.config.transcriber.onTranscript(callSid, async (result) => {
                      const text = result.text.trim();
                      if (text) {
                        this.logger.info(`📝 Transcrição recebida: "${text}"`);
                        await this.processTurnFromText(callSid, text);
                      }
                    });
                  }
                  
                  // Iniciar gravação da chamada
                  this.startRecording(callSid);
                  
                  // Gerar saudação inicial
                  this.generateGreeting(callSid);
                })();
              }
              break;

            case 'media':
              if (message.media && currentCallSid) {
                // Decodificar áudio de base64 (mulaw 8kHz)
                const audioChunk = Buffer.from(message.media.payload, 'base64');
                
                // 🆕 Converter μ-law → PCM apenas para cálculo de RMS (barge-in)
                // O Scribe recebe μ-law direto (sem conversão) para evitar corrupção de áudio
                const pcmChunk = this.convertMulawToPcm(audioChunk);
                
                // Gravar áudio do usuário
                this.recordUserAudio(currentCallSid, audioChunk);
                
                // Detectar barge-in: verificar se áudio REALMENTE está tocando no Twilio
                // Usar audioPlaybackEndTime como fonte primária (mais precisa)
                const now = Date.now();
                const playbackEndTime = this.audioPlaybackEndTime.get(currentCallSid) || 0;
                const playbackStartTime = this.audioPlaybackStartTime.get(currentCallSid) || 0;
                
                // 🆕 Só considerar como "tocando" se playbackEndTime está no futuro
                // Isso evita falsos positivos quando isPlayingAudio não foi resetado
                const audioStillPlaying = playbackEndTime > 0 && now < playbackEndTime;
                
                if (audioStillPlaying) {
                  // Verificar grace period (evita falsos positivos por eco)
                  const timeSincePlaybackStart = now - playbackStartTime;
                  const remainingMs = playbackEndTime - now;
                  
                  // 🆕 Durante a saudação, NÃO detectar barge-in por energia
                  // O "Alô?" do usuário é resposta natural, não interrupção
                  const isGreeting = this.isGreetingPlaying.get(currentCallSid) || false;
                  
                  if (isGreeting) {
                    // Durante saudação: ignorar completamente barge-in
                    // O áudio continua tocando e a transcrição será processada normalmente
                    if (Math.random() < 0.01) { // Log muito raro (1%) para diagnóstico
                      this.logger.debug(`👋 Saudação em andamento - barge-in desabilitado (${remainingMs.toFixed(0)}ms restantes)`);
                    }
                  } else {
                    // Turnos normais: usar grace period padrão
                    const gracePeriod = VoiceAgent.BARGE_IN_GRACE_PERIOD_MS;
                    
                    // Calcular RMS para diagnóstico (usa PCM convertido)
                    const rms = this.calculateRMS(pcmChunk);
                    
                    if (timeSincePlaybackStart > gracePeriod) {
                      // Verificar se há energia no áudio (não é silêncio)
                      const hasEnergy = rms > VoiceAgent.BARGE_IN_RMS_THRESHOLD;
                      
                      // Log periódico de diagnóstico (a cada ~1s)
                      if (Math.random() < 0.1) { // ~10% dos chunks para não poluir
                        this.logger.debug(`🎤 BARGE-IN check: rms=${rms.toFixed(0)}, threshold=${VoiceAgent.BARGE_IN_RMS_THRESHOLD}, hasEnergy=${hasEnergy}, remainingAudio=${remainingMs.toFixed(0)}ms`);
                      }
                      
                      if (hasEnergy && !this.bargeInDetected.get(currentCallSid)) {
                        this.logger.info(`🔇 Barge-in por ENERGIA detectado! (rms=${rms.toFixed(0)}, ${remainingMs.toFixed(0)}ms restantes)`);
                        this.detectBargeIn(currentCallSid);
                      }
                    } else {
                      // Log do grace period
                      if (Math.random() < 0.05) {
                        this.logger.debug(`⏳ Grace period: ${timeSincePlaybackStart.toFixed(0)}ms < ${gracePeriod}ms, rms=${rms.toFixed(0)}`);
                      }
                    }
                  }
                }
                
                // 🆕 Enviar ÁUDIO RAW (μ-law) para o Scribe - evita conversão que corrompe áudio!
                // O Scribe foi configurado com audioFormat='mulaw' para aceitar direto
                // 🔧 FIX: Usar buffer de acumulação em vez de descartar chunks
                // Isso evita perder partes do áudio que causavam transcrição incorreta ("Oscar" → "nosso cara")
                if (sttReady && this.config.transcriber.feedAudio && currentCallSid) {
                  // Inicializar buffer se não existe
                  if (!this.audioAccumulationBuffer.has(currentCallSid)) {
                    this.audioAccumulationBuffer.set(currentCallSid, []);
                  }
                  
                  // Acumular chunk no buffer
                  const buffer = this.audioAccumulationBuffer.get(currentCallSid)!;
                  buffer.push(audioChunk);
                  
                  // Calcular tamanho total do buffer
                  const totalBufferSize = buffer.reduce((sum, b) => sum + b.length, 0);
                  
                  const lastSent = this.lastAudioSentTime.get(currentCallSid) || 0;
                  const timeSinceLastSent = now - lastSent;
                  
                  // Enviar buffer acumulado se:
                  // 1. Passou tempo suficiente desde último envio (40ms)
                  // 2. OU buffer ficou muito grande (evitar atraso excessivo)
                  if (timeSinceLastSent >= VoiceAgent.MIN_AUDIO_INTERVAL_MS || 
                      totalBufferSize >= VoiceAgent.MAX_BUFFER_SIZE_BYTES) {
                    
                    // Concatenar todos os chunks acumulados
                    const combinedBuffer = Buffer.concat(buffer);
                    
                    // Limpar buffer
                    this.audioAccumulationBuffer.set(currentCallSid, []);
                    this.lastAudioSentTime.set(currentCallSid, now);
                    
                    // Enviar buffer combinado para o Scribe
                    this.config.transcriber.feedAudio(currentCallSid, combinedBuffer);
                  }
                } else if (!sttReady) {
                  // Buffer enquanto STT não está pronto (descarta para evitar overflow)
                  // Os primeiros ~100ms de áudio serão perdidos, mas é aceitável
                }
              }
              break;

            case 'mark':
              this.logger.debug(`🏷️ Twilio mark: ${message.mark?.name}`);
              break;

            case 'stop':
              this.logger.info(`⏹️ Twilio Media Stream: stop`);
              if (currentCallSid) {
                this.handleCallHangup(currentCallSid);
              }
              break;
          }
        } catch (error) {
          this.logger.error('Erro ao processar Twilio Media Stream:', error);
        }
      });

      ws.on('close', () => {
        this.logger.info(`🔌 Twilio Media Stream desconectado`);
        if (currentCallSid) {
          this.activeCalls.delete(currentCallSid);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`Erro WebSocket Twilio:`, error);
      });
    });
  }

  /**
   * Configura WebSocket server para receber áudio das chamadas
   */
  private setupAudioWebSocket(wss: WebSocket.Server): void {
    wss.on('connection', (ws, req) => {
      // Extrair callId da URL: /audio/call-id
      const callId = req.url?.split('/').pop();
      if (!callId || !this.activeCalls.has(callId)) {
        this.logger.warn(`WebSocket: callId inválido ou sessão não encontrada: ${callId}`);
        ws.close();
        return;
      }

      this.logger.info(`🔌 WebSocket conectado para chamada ${callId}`);

      // Buffer para acumular chunks de áudio
      let audioBuffer: Buffer[] = [];
      let silenceTimeout: NodeJS.Timeout | null = null;
      const SILENCE_THRESHOLD_MS = 500; // 500ms de silêncio = fim do turno

      ws.on('message', (data: Buffer) => {
        // Acumular áudio
        audioBuffer.push(data);

        // Reset do timeout de silêncio
        if (silenceTimeout) clearTimeout(silenceTimeout);
        
        silenceTimeout = setTimeout(async () => {
          // Silêncio detectado - processar turno
          if (audioBuffer.length > 0) {
            const fullAudio = Buffer.concat(audioBuffer);
            audioBuffer = [];
            
            this.logger.debug(`🎤 Áudio recebido: ${fullAudio.length} bytes, processando turno...`);
            
            // Processar o turno de conversa
            await this.processTurn(callId, fullAudio);
          }
        }, SILENCE_THRESHOLD_MS);
      });

      ws.on('close', () => {
        this.logger.info(`🔌 WebSocket desconectado para chamada ${callId}`);
        if (silenceTimeout) clearTimeout(silenceTimeout);
      });

      ws.on('error', (error) => {
        this.logger.error(`Erro WebSocket para chamada ${callId}:`, error);
      });
    });
  }

  /**
   * Inicia uma chamada outbound
   */
  async makeCall(phoneNumber: string, prospectData?: { name?: string; company?: string }): Promise<string> {
    this.logger.info(`📞 Iniciando chamada para ${phoneNumber}`);

    const callId = await this.config.telephony.makeCall(phoneNumber);

    const session: CallSession = {
      id: callId,
      phoneNumber,
      prospectName: prospectData?.name,
      companyName: prospectData?.company,
      startedAt: new Date(),
      status: 'initiating',
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

    this.activeCalls.set(callId, session);
    this.emit('call:started', callId);

    return callId;
  }

  /**
   * Processa um turno de conversa completo
   * Este é o core do sistema: User Audio → STT → LLM → TTS → Agent Audio
   */
  async processTurn(callId: string, userAudio: Buffer): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }

    const turnId = this.config.metrics.startTurn(callId);
    const timestamps: Record<string, number> = {};
    
    this.emit('turn:started', callId, turnId);
    this.logger.debug(`🔄 Turno ${turnId} iniciado`);

    try {
      // ============================================
      // FASE 1: Speech-to-Text
      // ============================================
      timestamps.sttStart = Date.now();
      this.config.metrics.recordEvent({
        stage: 'stt_start',
        timestamp: timestamps.sttStart,
        callId,
        turnId,
      });

      const transcription = await this.config.transcriber.transcribe(userAudio);
      
      timestamps.sttEnd = Date.now();
      const sttDuration = timestamps.sttEnd - timestamps.sttStart;
      
      this.config.metrics.recordEvent({
        stage: 'stt_end',
        timestamp: timestamps.sttEnd,
        callId,
        turnId,
        metadata: { text: transcription.text, duration: sttDuration },
      });

      this.logger.info(`📝 STT (${sttDuration}ms): "${transcription.text}"`);
      this.emit('metrics:update', { stage: 'STT', duration: sttDuration });

      // Validar transcrição
      if (!transcription.text || transcription.text.trim().length === 0) {
        this.logger.warn('Transcrição vazia, ignorando turno');
        session.metrics.transcriptionErrors++;
        return;
      }

      // Adicionar ao histórico
      session.conversationHistory.push({
        role: 'user',
        content: transcription.text,
        timestamp: new Date(),
      });

      // ============================================
      // FASE 2: Disparar Filler (paralelo ao LLM)
      // ============================================
      const fillerContext: FillerContext = {
        prospectName: session.prospectName,
        lastUserMessage: transcription.text,
        conversationStage: this.intelligence.detectConversationStage(session),
      };

      const filler = this.config.fillerManager.getFiller(fillerContext);
      let fillerSent = false;

      if (filler) {
        // Enviar filler imediatamente enquanto LLM processa
        timestamps.fillerStart = Date.now();
        await this.sendAudioToCall(callId, filler.audioBuffer);
        fillerSent = true;
        session.metrics.fillersUsed++;
        
        this.logger.debug(`🗣️ Filler enviado: "${filler.text}"`);
        this.emit('filler:played', callId, filler.text);
      }

      // ============================================
      // FASE 3: LLM Processing
      // ============================================
      timestamps.llmStart = Date.now();
      this.config.metrics.recordEvent({
        stage: 'llm_start',
        timestamp: timestamps.llmStart,
        callId,
        turnId,
      });

      // Construir mensagens para o LLM (usa inteligência centralizada com pensamentos)
      const messages = this.intelligence.buildLLMMessages(session);
      const llmResponse = await this.config.llm.generate(messages, {
        maxTokens: 150, // Respostas concisas
        temperature: 0.7,
      });

      timestamps.llmEnd = Date.now();
      const llmDuration = timestamps.llmEnd - timestamps.llmStart;

      this.config.metrics.recordEvent({
        stage: 'llm_end',
        timestamp: timestamps.llmEnd,
        callId,
        turnId,
        metadata: { text: llmResponse.text, duration: llmDuration },
      });

      this.logger.info(`🤖 LLM (${llmDuration}ms): "${llmResponse.text}"`);
      this.emit('metrics:update', { stage: 'LLM', duration: llmDuration });

      // Adicionar resposta ao histórico
      session.conversationHistory.push({
        role: 'agent',
        content: llmResponse.text,
        timestamp: new Date(),
      });

      // ============================================
      // FASE 4: Text-to-Speech
      // ============================================
      timestamps.ttsStart = Date.now();
      this.config.metrics.recordEvent({
        stage: 'tts_start',
        timestamp: timestamps.ttsStart,
        callId,
        turnId,
      });

      const ttsResult = await this.config.tts.synthesize(llmResponse.text);

      timestamps.ttsFirstByte = Date.now();
      this.config.metrics.recordEvent({
        stage: 'tts_first_byte',
        timestamp: timestamps.ttsFirstByte,
        callId,
        turnId,
      });

      // Enviar áudio para o telefone
      await this.sendAudioToCall(callId, ttsResult.audioBuffer);

      timestamps.ttsEnd = Date.now();
      const ttsDuration = timestamps.ttsEnd - timestamps.ttsStart;

      this.config.metrics.recordEvent({
        stage: 'tts_end',
        timestamp: timestamps.ttsEnd,
        callId,
        turnId,
        metadata: { duration: ttsDuration, characters: ttsResult.characterCount },
      });

      this.logger.info(`🔊 TTS (${ttsDuration}ms): ${ttsResult.characterCount} chars`);
      this.emit('metrics:update', { stage: 'TTS', duration: ttsDuration });

      // ============================================
      // FASE 5: Calcular métricas do turno
      // ============================================
      const latency: LatencyBreakdown = {
        stt: sttDuration,
        llm: llmDuration,
        tts: ttsDuration,
        total: timestamps.ttsEnd - timestamps.sttStart,
        timeToFirstAudio: fillerSent 
          ? (timestamps.fillerStart! - timestamps.sttStart)
          : (timestamps.ttsFirstByte - timestamps.sttStart),
      };

      const turnMetrics: TurnMetrics = {
        turnId,
        timestamp: new Date(),
        latency,
        audioInputDuration: userAudio.length / 32, // Aproximação baseada em 16kHz mono
        audioOutputDuration: ttsResult.duration,
        fillerUsed: fillerSent,
        fillerText: filler?.text,
      };

      session.metrics.turns.push(turnMetrics);
      this.updateAggregateMetrics(session);

      this.emit('turn:ended', callId, turnId, turnMetrics);
      
      this.logger.info(`✅ Turno completo - Total: ${latency.total}ms, First Audio: ${latency.timeToFirstAudio}ms`);

    } catch (error) {
      this.logger.error(`Erro no turno ${turnId}:`, error);
      this.emit('error', error as Error, `turn:${turnId}`);
    }
  }

  /**
   * Processa um turno quando já temos o texto transcrito (STT streaming)
   * USA DEBOUNCE: Transcrições consecutivas são agregadas antes de processar
   * Isso evita respostas duplicadas quando STT envia múltiplos segmentos
   */
  async processTurnFromText(callId: string, userText: string): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }
    
    // Filtrar eco do agente e transcrições corrompidas
    const filteredText = this.echoFilter.filter(userText, callId);
    if (!filteredText) {
      this.logger.debug(`🔇 Transcrição filtrada (eco/corrompida): "${userText.substring(0, 30)}..."`);
      return;
    }
    userText = filteredText;

    // Verificar se ainda tem áudio tocando do turno anterior (barge-in por transcrição)
    const now = Date.now();
    const playbackEndTime = this.audioPlaybackEndTime.get(callId) || 0;
    const audioStillPlaying = now < playbackEndTime;
    const isGreeting = this.isGreetingPlaying.get(callId) || false;
    
    this.logger.debug(`📊 Estado de reprodução: playbackEndTime=${playbackEndTime}, now=${now}, diff=${playbackEndTime - now}ms, isGreeting=${isGreeting}`);
    
    // 🆕 Durante a saudação, NÃO detectar barge-in e NÃO processar transcrição
    // O "Alô?" do usuário é resposta natural ao atender - guardar para combinar com próxima fala
    if (isGreeting) {
      const remainingTime = playbackEndTime - now;
      // Guardar transcrição para combinar depois (não processar sozinha)
      const existingGreetingText = this.greetingTranscription.get(callId) || '';
      const combinedGreetingText = existingGreetingText ? `${existingGreetingText} ${userText}` : userText;
      this.greetingTranscription.set(callId, combinedGreetingText);
      this.logger.info(`👋 Transcrição durante saudação guardada: "${userText}" (${Math.round(remainingTime)}ms restantes) - será combinada com próxima fala`);
      // NÃO processar - retornar e esperar próxima transcrição
      return;
    }
    
    // Turnos normais: detectar barge-in se áudio ainda está tocando
    if (audioStillPlaying && !this.bargeInDetected.get(callId)) {
      const remainingTime = playbackEndTime - now;
      this.logger.info(`🔇 BARGE-IN DETECTADO por transcrição! (${Math.round(remainingTime)}ms restantes de áudio)`);
      this.bargeInDetected.set(callId, true);
      this.isPlayingAudio.set(callId, false);
      this.audioPlaybackEndTime.set(callId, 0);
      this.totalAudioBytesSent.set(callId, 0);
      
      // Limpar buffer de áudio no Twilio
      this.clearTwilioAudioBuffer(callId);
      
      // Cancelar fila de TTS pendente
      this.cancelTTSQueue(callId);
    }
    
    // 🆕 Combinar com transcrição guardada durante saudação (se houver)
    const greetingText = this.greetingTranscription.get(callId);
    if (greetingText) {
      userText = `${greetingText} ${userText}`;
      this.greetingTranscription.delete(callId);
      this.logger.info(`🔗 Transcrição combinada com saudação: "${userText.substring(0, 50)}..."`);
    }

    // Resetar flag de barge-in se existir (nova transcrição = usuário terminou de falar)
    if (this.bargeInDetected.get(callId)) {
      this.logger.info(`🔇 Barge-in pendente resetado - processando nova transcrição`);
      this.bargeInDetected.set(callId, false);
    }
    
    // 🆕 Limpar texto parcial de barge-in (transcrição final chegou)
    this.pendingBargeInText.delete(callId);

    // 🆕 Se detectamos continuação via parciais, esta é a transcrição completa - combinar
    if (this.continuationDetected.get(callId)) {
      const pendingText = this.pendingTranscription.get(callId) || '';
      const combinedText = pendingText ? `${pendingText} ${userText}` : userText;
      this.logger.info(`🔗 Transcrições combinadas (continuação): "${combinedText.substring(0, 50)}..."`);
      this.pendingTranscription.set(callId, combinedText);
      this.continuationDetected.set(callId, false);
      this.shouldCancelProcessing.set(callId, false);
      // Continua para processar com debounce
    } else {
      // Agregar texto com transcrição pendente (comportamento normal)
      const pendingText = this.pendingTranscription.get(callId) || '';
      const aggregatedText = pendingText ? `${pendingText} ${userText}` : userText;
      this.pendingTranscription.set(callId, aggregatedText);
    }

    // Se já está processando, verificar se deve cancelar ou apenas agregar
    if (this.isProcessing.get(callId)) {
      if (!this.hasStartedPlayback.get(callId)) {
        // Áudio ainda não começou - marcar para cancelar e tocar acknowledgment
        if (!this.shouldCancelProcessing.get(callId)) {
          this.logger.info(`🔄 Nova transcrição durante processamento - cancelando`);
          this.shouldCancelProcessing.set(callId, true);
          this.continuationDetected.set(callId, true);
          this.playAcknowledgment(callId);
        }
      }
      this.logger.debug(`📝 Texto agregado (processando): "${userText}" → "${this.pendingTranscription.get(callId)?.substring(0, 50)}..."`);
      return;
    }

    // Cancelar timer anterior se existir
    const existingTimer = this.transcriptionDebounceTimer.get(callId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // 🆕 Debounce adaptativo: menor para streaming STT (Scribe já faz VAD), maior para batch
    const isStreamingSTT = !!(this.config.transcriber.startStream && this.config.transcriber.onPartialTranscript);
    const debounceMs = isStreamingSTT 
      ? VoiceAgent.TRANSCRIPTION_DEBOUNCE_STREAMING_MS 
      : VoiceAgent.TRANSCRIPTION_DEBOUNCE_BATCH_MS;

    // Agendar processamento após debounce
    const timer = setTimeout(async () => {
      const textToProcess = this.pendingTranscription.get(callId);
      if (!textToProcess) return;
      
      // Limpar buffer pendente
      this.pendingTranscription.delete(callId);
      this.transcriptionDebounceTimer.delete(callId);
      
      // Processar o texto agregado
      await this.processAggregatedText(callId, textToProcess);
    }, debounceMs);
    
    this.transcriptionDebounceTimer.set(callId, timer);
    this.logger.debug(`⏳ Debounce iniciado (${debounceMs}ms${isStreamingSTT ? ' - streaming' : ' - batch'}) para: "${userText}"`);
  }

  /**
   * Processa o texto agregado após debounce
   * USA STREAMING: LLM gera texto → chunks vão para TTS → áudio vai para Twilio
   * Suporta barge-in (interrupção quando usuário fala)
   */
  private async processAggregatedText(callId: string, userText: string): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      this.logger.error(`Sessão não encontrada: ${callId}`);
      return;
    }

    // Marcar que está processando (evita múltiplos turnos)
    this.isProcessing.set(callId, true);
    
    // Resetar contador de bytes enviados (para métricas deste turno)
    // NÃO resetar audioPlaybackEndTime aqui - será atualizado quando enviar novo áudio
    this.totalAudioBytesSent.set(callId, 0);

    const turnId = this.config.metrics.startTurn(callId);
    const timestamps: Record<string, number> = {};
    let interrupted = false;
    
    this.emit('turn:started', callId, turnId);
    this.logger.info(`🔄 Turno ${turnId} iniciado (texto agregado: "${userText.substring(0, 60)}${userText.length > 60 ? '...' : ''}")`);

    // Gravar transcrição do usuário
    this.recordTranscript(callId, 'user', userText);

    // Tentar extrair nome do cliente da transcrição
    this.intelligence.tryUpdateProspectName(session, userText);

    try {
      // Adicionar ao histórico
      session.conversationHistory.push({
        role: 'user',
        content: userText,
        timestamp: new Date(),
      });

      // ============================================
      // FASE 1: Disparar Filler (paralelo ao LLM)
      // ============================================
      const fillerContext: FillerContext = {
        prospectName: session.prospectName,
        lastUserMessage: userText,
        conversationStage: this.intelligence.detectConversationStage(session),
      };

      const filler = this.config.fillerManager.getFiller(fillerContext);
      let fillerSent = false;

      // 🆕 Resetar flags de controle no início do processamento
      this.hasStartedPlayback.set(callId, false);
      this.shouldCancelProcessing.set(callId, false);

      if (filler) {
        timestamps.fillerStart = Date.now();
        this.isPlayingAudio.set(callId, true);
        this.audioPlaybackStartTime.set(callId, Date.now());
        await this.sendAudioToCall(callId, filler.audioBuffer);
        fillerSent = true;
        session.metrics.fillersUsed++;
        
        this.logger.debug(`🗣️ Filler enviado: "${filler.text}"`);
        this.emit('filler:played', callId, filler.text);
        
        // Gravar filler como áudio do agente
        this.recordAgentAudio(callId, filler.audioBuffer);
      }

      // 🆕 Verificar se deve cancelar ANTES do LLM
      if (this.shouldCancelProcessing.get(callId)) {
        this.logger.info(`🛑 Processamento cancelado antes do LLM (usuário continuou falando)`);
        this.isProcessing.set(callId, false);
        return;
      }

      // ============================================
      // FASE 2: LLM Streaming + TTS Streaming
      // ============================================
      timestamps.llmStart = Date.now();
      this.config.metrics.recordEvent({
        stage: 'llm_start',
        timestamp: timestamps.llmStart,
        callId,
        turnId,
      });

      // Construir mensagens para o LLM (usa inteligência centralizada com pensamentos)
      const messages = this.intelligence.buildLLMMessages(session);
      
      // Buffer para acumular texto até formar uma frase
      let textBuffer = '';
      let fullResponse = '';
      let firstAudioSent = false;
      let totalTTSBytes = 0;
      let llmFirstToken = 0;
      
      // Marcar que está reproduzindo áudio (para barge-in)
      this.isPlayingAudio.set(callId, true);
      this.audioPlaybackStartTime.set(callId, Date.now());

      // Verificar se streaming está disponível
      const hasLLMStream = !!this.config.llm.generateStream;
      const hasTTSStream = !!this.config.tts.synthesizeStream;
      
      if (!hasLLMStream || !hasTTSStream) {
        // Fallback para modo não-streaming
        this.logger.warn('⚠️ Streaming não disponível, usando modo batch');
        const llmResult = await this.config.llm.generate(messages, { maxTokens: 150, temperature: 0.7 });
        fullResponse = llmResult.text;
        timestamps.llmEnd = Date.now();
        
        // 🆕 Verificar cancelamento antes do TTS (modo batch)
        if (this.shouldCancelProcessing.get(callId)) {
          this.logger.info(`🛑 Processamento cancelado antes do TTS (usuário continuou falando)`);
          this.isProcessing.set(callId, false);
          return;
        }
        
        const ttsResult = await this.config.tts.synthesize(fullResponse);
        timestamps.ttsStart = Date.now();
        timestamps.ttsFirstByte = Date.now();
        // 🆕 Marcar que o playback começou
        this.hasStartedPlayback.set(callId, true);
        await this.sendAudioToCall(callId, ttsResult.audioBuffer);
        timestamps.ttsEnd = Date.now();
        totalTTSBytes = ttsResult.audioBuffer.length;
        firstAudioSent = true;
        
        this.recordAgentAudio(callId, ttsResult.audioBuffer);
      } else {
        // Processar LLM com streaming
        await this.config.llm.generateStream!(messages, async (chunk: string) => {
        // 🆕 Verificar barge-in OU cancelamento por continuação
        if (this.bargeInDetected.get(callId) || this.shouldCancelProcessing.get(callId)) {
          interrupted = true;
          return;
        }
        
        if (!llmFirstToken) {
          llmFirstToken = Date.now();
          this.logger.debug(`⚡ LLM primeiro token: ${llmFirstToken - timestamps.llmStart}ms`);
        }
        
        textBuffer += chunk;
        fullResponse += chunk;
        
        // Verificar se temos uma frase completa para enviar ao TTS
        const shouldFlush = this.shouldFlushTextBuffer(textBuffer);
        
        if (shouldFlush && !interrupted) {
          const textToSpeak = textBuffer.trim();
          textBuffer = '';
          
          if (textToSpeak.length > 0) {
            // Enfileirar TTS para garantir serialização (evitar sobreposição de áudio)
            if (!timestamps.ttsStart) {
              timestamps.ttsStart = Date.now();
              this.config.metrics.recordEvent({
                stage: 'tts_start',
                timestamp: timestamps.ttsStart,
                callId,
                turnId,
              });
            }
            
            // Usar fila de TTS para serializar
            this.enqueueTTS(callId, textToSpeak, (audioChunk: Buffer) => {
              // Verificar barge-in ou cancelamento antes de enviar áudio
              if (this.bargeInDetected.get(callId) || this.shouldCancelProcessing.get(callId)) {
                interrupted = true;
                return;
              }
              
              if (!firstAudioSent) {
                timestamps.ttsFirstByte = Date.now();
                firstAudioSent = true;
                // 🆕 Marcar que o playback começou
                this.hasStartedPlayback.set(callId, true);
                this.config.metrics.recordEvent({
                  stage: 'tts_first_byte',
                  timestamp: timestamps.ttsFirstByte,
                  callId,
                  turnId,
                });
                this.logger.info(`⚡ Time to First Audio: ${timestamps.ttsFirstByte - timestamps.llmStart}ms`);
              }
              
              totalTTSBytes += audioChunk.length;
              
              // Enviar chunk para Twilio/Telnyx
              this.sendAudioToCall(callId, audioChunk);
              
              // Gravar áudio do agente
              this.recordAgentAudio(callId, audioChunk);
            });
          }
        }
        });

        // Flush do buffer restante (também enfileirado)
        if (textBuffer.trim().length > 0 && !interrupted) {
          this.enqueueTTS(callId, textBuffer.trim(), (audioChunk: Buffer) => {
            if (this.bargeInDetected.get(callId) || this.shouldCancelProcessing.get(callId)) {
              interrupted = true;
              return;
            }
            
            if (!firstAudioSent) {
              timestamps.ttsFirstByte = Date.now();
              firstAudioSent = true;
              // 🆕 Marcar que o playback começou
              this.hasStartedPlayback.set(callId, true);
            }
            
            totalTTSBytes += audioChunk.length;
            this.sendAudioToCall(callId, audioChunk);
            this.recordAgentAudio(callId, audioChunk);
          });
        }
        
        timestamps.llmEnd = Date.now();
        
        // Aguardar a fila de TTS terminar antes de calcular métricas
        await this.waitForTTSQueue(callId);
      } // Fim do else (streaming disponível)

      timestamps.ttsEnd = Date.now();
      
      const llmDuration = timestamps.llmEnd - timestamps.llmStart;
      const ttsDuration = timestamps.ttsEnd - (timestamps.ttsStart || timestamps.llmEnd);
      
      // Parar flag de reprodução
      this.isPlayingAudio.set(callId, false);

      this.config.metrics.recordEvent({
        stage: 'llm_end',
        timestamp: timestamps.llmEnd,
        callId,
        turnId,
        metadata: { text: fullResponse, duration: llmDuration },
      });

      this.config.metrics.recordEvent({
        stage: 'tts_end',
        timestamp: timestamps.ttsEnd,
        callId,
        turnId,
        metadata: { duration: ttsDuration, bytes: totalTTSBytes },
      });

      this.logger.info(`🤖 LLM (${llmDuration}ms): "${fullResponse}"`);
      this.emit('metrics:update', { stage: 'LLM', duration: llmDuration });

      // Gravar resposta do agente
      this.recordTranscript(callId, 'agent', fullResponse);
      
      // Registrar no EchoFilter para detectar eco em transcrições futuras
      this.echoFilter.registerAgentResponse(fullResponse, callId);

      // Adicionar resposta ao histórico
      session.conversationHistory.push({
        role: 'agent',
        content: fullResponse,
        timestamp: new Date(),
      });

      // Processar pensamentos em paralelo (não bloqueia)
      // Aproveita o tempo de reprodução do áudio enquanto o usuário ouve
      if (this.intelligence.isThinkingEnabled() && session.conversationHistory.filter(t => t.role === 'user').length > 0) {
        this.intelligence.processThoughtsInParallel(session, fullResponse).catch(err => {
          this.logger.warn('Erro ao processar pensamentos (não crítico):', err);
        });
      }

      // ============================================
      // FASE 3: Calcular métricas do turno
      // ============================================
      const timeToFirstAudio = fillerSent 
        ? (timestamps.fillerStart! - timestamps.llmStart)
        : (timestamps.ttsFirstByte ? timestamps.ttsFirstByte - timestamps.llmStart : llmDuration + ttsDuration);
      
      const latency: LatencyBreakdown = {
        stt: 0, // STT já foi feito em streaming
        llm: llmDuration,
        tts: ttsDuration,
        total: timestamps.ttsEnd - timestamps.llmStart,
        timeToFirstAudio,
      };

      // Calcular duração do áudio (estimativa baseada em bytes)
      const audioFormat = globalConfig.elevenlabs?.outputFormat || 'ulaw_8000';
      const bytesPerSecond = audioFormat === 'ulaw_8000' ? 8000 : 32000;
      const audioDuration = totalTTSBytes / bytesPerSecond;

      const turnMetrics: TurnMetrics = {
        turnId,
        timestamp: new Date(),
        latency,
        audioInputDuration: 0,
        audioOutputDuration: audioDuration,
        fillerUsed: fillerSent,
        fillerText: filler?.text,
      };

      session.metrics.turns.push(turnMetrics);
      this.updateAggregateMetrics(session);
      this.config.metrics.endTurn(callId, turnId);

      this.emit('turn:ended', callId, turnId, turnMetrics);
      
      if (interrupted) {
        this.logger.info(`🔇 Turno interrompido por barge-in - TTFA: ${timeToFirstAudio}ms`);
      } else {
        this.logger.info(`✅ Turno completo - TTFA: ${timeToFirstAudio}ms, Total: ${latency.total}ms`);
      }
      
      // Garantir que flag de barge-in seja resetada no final do turno
      this.bargeInDetected.set(callId, false);

    } catch (error) {
      this.isPlayingAudio.set(callId, false);
      this.bargeInDetected.set(callId, false); // Reset em caso de erro também
      this.logger.error(`Erro no turno ${turnId}:`, error);
      this.emit('error', error as Error, `turn:${turnId}`);
    } finally {
      // Sempre liberar flags de processamento e continuação
      this.isProcessing.set(callId, false);
      this.hasStartedPlayback.set(callId, false);
      // 🆕 NÃO resetar shouldCancelProcessing e continuationDetected aqui
      // pois elas serão usadas na próxima transcrição
      
      // Verificar se há transcrições pendentes para processar
      const pendingText = this.pendingTranscription.get(callId);
      if (pendingText) {
        // Verificar se ainda tem áudio tocando no Twilio
        const now = Date.now();
        const playbackEndTime = this.audioPlaybackEndTime.get(callId) || 0;
        const audioStillPlaying = now < playbackEndTime;
        
        if (audioStillPlaying) {
          // Ainda tem áudio tocando - esperar até terminar + debounce adaptativo
          const isStreamingSTT = !!(this.config.transcriber.startStream && this.config.transcriber.onPartialTranscript);
          const debounceMs = isStreamingSTT 
            ? VoiceAgent.TRANSCRIPTION_DEBOUNCE_STREAMING_MS 
            : VoiceAgent.TRANSCRIPTION_DEBOUNCE_BATCH_MS;
          const waitTime = (playbackEndTime - now) + debounceMs;
          this.logger.info(`📝 Transcrição pendente aguardando áudio terminar (${Math.round(waitTime)}ms): "${pendingText.substring(0, 40)}..."`);
          
          // Agendar para quando o áudio terminar (mantém na pendingTranscription para barge-in detectar)
          setTimeout(() => {
            const stillPendingText = this.pendingTranscription.get(callId);
            if (stillPendingText && !this.isProcessing.get(callId)) {
              this.pendingTranscription.delete(callId);
              this.processAggregatedText(callId, stillPendingText);
            }
          }, waitTime);
        } else {
          // Áudio já terminou - processar após debounce normal
          this.logger.info(`📝 Processando transcrição pendente: "${pendingText.substring(0, 50)}..."`);
          this.pendingTranscription.delete(callId);
          setTimeout(() => {
            this.processAggregatedText(callId, pendingText);
          }, 100);
        }
      }
    }
  }

  /**
   * Verifica se deve enviar o buffer de texto para TTS
   */
  private shouldFlushTextBuffer(text: string): boolean {
    // Se buffer muito grande, forçar flush
    if (text.length >= STREAMING_CONFIG.MAX_BUFFER_CHARS) {
      return true;
    }
    
    // Se tem tamanho mínimo E termina com delimitador de frase
    if (text.length >= STREAMING_CONFIG.MIN_CHARS_FOR_TTS) {
      const lastChar = text.trim().slice(-1);
      if (STREAMING_CONFIG.SENTENCE_DELIMITERS.includes(lastChar)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Enfileira um TTS stream para garantir serialização
   * Evita sobreposição de áudio quando múltiplos TTS são disparados em paralelo
   */
  private enqueueTTS(
    callId: string, 
    text: string, 
    onChunk: (chunk: Buffer) => void
  ): void {
    // Verificar barge-in ANTES de enfileirar (não adiciona novos TTS após interrupção)
    if (this.bargeInDetected.get(callId)) {
      this.logger.debug(`🔇 TTS ignorado (barge-in ativo): "${text.substring(0, 30)}..."`);
      return;
    }
    
    // Obter a Promise atual da fila (ou uma resolvida se não houver)
    const currentQueue = this.ttsQueue.get(callId) || Promise.resolve();
    
    // Encadear o novo TTS na fila
    const newQueue = currentQueue.then(async () => {
      // Verificar barge-in novamente antes de iniciar (pode ter mudado)
      if (this.bargeInDetected.get(callId)) {
        return;
      }
      
      try {
        if (this.config.tts.synthesizeStream) {
          await this.config.tts.synthesizeStream(text, onChunk);
        }
      } catch (error) {
        this.logger.error(`Erro TTS enfileirado:`, error);
      }
    });
    
    // Atualizar a fila
    this.ttsQueue.set(callId, newQueue);
  }

  /**
   * Aguarda a fila de TTS terminar para uma chamada específica
   */
  private async waitForTTSQueue(callId: string): Promise<void> {
    const queue = this.ttsQueue.get(callId);
    if (queue) {
      await queue;
      // Limpar a fila após terminar
      this.ttsQueue.delete(callId);
    }
  }

  /**
   * Detecta barge-in (usuário falando durante reprodução do agente)
   * Verifica tanto a flag isPlayingAudio quanto o tempo estimado de término da reprodução
   */
  detectBargeIn(callId: string): void {
    const now = Date.now();
    const playbackEndTime = this.audioPlaybackEndTime.get(callId) || 0;
    const isStillPlaying = this.isPlayingAudio.get(callId) || now < playbackEndTime;
    
    if (isStillPlaying) {
      const remainingTime = playbackEndTime > 0 ? Math.max(0, playbackEndTime - now) : 0;
      this.logger.info(`🔇 Barge-in detectado para call ${callId} (${remainingTime}ms restantes de áudio)`);
      this.bargeInDetected.set(callId, true);
      this.isPlayingAudio.set(callId, false);
      this.isGreetingPlaying.set(callId, false); // 🆕 Resetar flag de saudação
      this.audioPlaybackEndTime.set(callId, 0); // Resetar tempo de término
      this.totalAudioBytesSent.set(callId, 0); // Resetar contador de bytes
      
      // Enviar comando para parar áudio no Twilio (clear buffer)
      this.clearTwilioAudioBuffer(callId);
      
      // Cancelar fila de TTS pendente (importante para resposta rápida)
      this.cancelTTSQueue(callId);
      
      // 🆕 Tocar feedback imediato para o usuário saber que foi ouvido
      // Não usar playAcknowledgment pois ele verifica cooldown
      this.playBargeInFeedback(callId).catch(err => {
        this.logger.debug('Erro ao tocar feedback de barge-in (não crítico):', err);
      });
    }
  }
  
  /**
   * 🆕 Toca um som curto imediato após barge-in para feedback ao usuário
   * DESABILITADO: Estava causando cascata de barge-ins
   * O feedback será dado pela resposta rápida do agente
   */
  private async playBargeInFeedback(callId: string): Promise<void> {
    // DESABILITADO - o "Hm" estava sendo detectado como playback
    // e causando novos barge-ins em loop
    this.logger.debug(`🔇 Feedback de barge-in desabilitado (evita cascata)`);
    return;
  }

  /**
   * Cancela a fila de TTS para uma chamada (usado em barge-in)
   */
  private cancelTTSQueue(callId: string): void {
    // Remover a fila para que os TTS pendentes não sejam executados
    // Os TTS que já estão rodando vão verificar bargeInDetected e parar
    this.ttsQueue.delete(callId);
    this.logger.debug(`🔇 Fila de TTS cancelada para call ${callId}`);
  }

  /**
   * Limpa o buffer de áudio do Twilio (para barge-in)
   */
  private clearTwilioAudioBuffer(callId: string): void {
    const stream = this.twilioStreams.get(callId);
    if (!stream) return;
    
    const { ws, streamSid } = stream;
    if (ws.readyState !== WebSocket.OPEN) return;
    
    // Enviar comando 'clear' para limpar o buffer de áudio
    const clearMessage = JSON.stringify({
      event: 'clear',
      streamSid: streamSid,
    });
    
    ws.send(clearMessage);
    this.logger.debug(`🔇 Buffer de áudio limpo para call ${callId}`);
  }

  /**
   * Detecta se há energia no áudio (não é silêncio)
   * Usa RMS (Root Mean Square) para calcular energia
   */
  /**
   * Calcula o RMS (Root Mean Square) do buffer de áudio PCM 16-bit
   */
  private calculateRMS(pcmBuffer: Buffer): number {
    if (pcmBuffer.length < 4) return 0;
    
    let sumSquares = 0;
    const samples = pcmBuffer.length / 2;
    
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      sumSquares += sample * sample;
    }
    
    return Math.sqrt(sumSquares / samples);
  }

  private detectAudioEnergy(pcmBuffer: Buffer, threshold: number = 500): boolean {
    return this.calculateRMS(pcmBuffer) > threshold;
  }

  /**
   * Inicia gravação de uma chamada
   */
  private startRecording(callId: string): void {
    this.callRecordings.set(callId, {
      userAudio: [],
      agentAudio: [],
      transcript: [],
    });
    this.logger.debug(`🎙️ Gravação iniciada para call ${callId}`);
  }

  /**
   * Grava áudio do usuário
   */
  private recordUserAudio(callId: string, audio: Buffer): void {
    const recording = this.callRecordings.get(callId);
    if (recording) {
      recording.userAudio.push(audio);
    }
  }

  /**
   * Grava áudio do agente
   */
  private recordAgentAudio(callId: string, audio: Buffer): void {
    const recording = this.callRecordings.get(callId);
    if (recording) {
      recording.agentAudio.push(audio);
    }
  }

  /**
   * Grava transcrição
   */
  private recordTranscript(callId: string, role: 'user' | 'agent', text: string): void {
    const recording = this.callRecordings.get(callId);
    if (recording) {
      recording.transcript.push({
        role,
        text,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Salva gravação em disco
   */
  private async saveRecording(callId: string): Promise<void> {
    const recording = this.callRecordings.get(callId);
    if (!recording) return;
    
    const session = this.activeCalls.get(callId);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(process.cwd(), 'recordings', `${timestamp}_twilio-${callId.substring(0, 8)}`);
    
    try {
      // Criar diretório
      fs.mkdirSync(dir, { recursive: true });
      
      // Salvar transcrição
      fs.writeFileSync(
        path.join(dir, 'transcript.json'),
        JSON.stringify(recording.transcript, null, 2)
      );
      
      // 🆕 Salvar pensamentos internos do agente (se habilitado)
      if (session?.internalThoughts && session.internalThoughts.length > 0) {
        fs.writeFileSync(
          path.join(dir, 'thoughts.json'),
          JSON.stringify(session.internalThoughts, null, 2)
        );
        this.logger.info(`🧠 ${session.internalThoughts.length} pensamentos salvos`);
      }
      
      // Salvar áudio do agente (concatenado)
      if (recording.agentAudio.length > 0) {
        const agentBuffer = Buffer.concat(recording.agentAudio);
        fs.writeFileSync(path.join(dir, 'agent_audio.raw'), agentBuffer);
      }
      
      // Salvar áudio do usuário (concatenado)
      if (recording.userAudio.length > 0) {
        const userBuffer = Buffer.concat(recording.userAudio);
        fs.writeFileSync(path.join(dir, 'user_audio.raw'), userBuffer);
      }
      
      this.logger.info(`📁 Gravação salva em ${dir}`);
    } catch (error) {
      this.logger.error(`Erro ao salvar gravação:`, error);
    }
    
    // Limpar memória
    this.callRecordings.delete(callId);
  }

  // NOTA: buildLLMMessages, generateContext e detectConversationStage foram movidos
  // para VoiceIntelligence para centralizar a lógica de inteligência do agente

  /**
   * Atualiza métricas agregadas da sessão
   */
  private updateAggregateMetrics(session: CallSession): void {
    const turns = session.metrics.turns;
    if (turns.length === 0) return;

    // Calcular médias
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

    // Calcular picos
    session.metrics.peakLatency = turns.reduce(
      (peak, t) => ({
        stt: Math.max(peak.stt, t.latency.stt),
        llm: Math.max(peak.llm, t.latency.llm),
        tts: Math.max(peak.tts, t.latency.tts),
        total: Math.max(peak.total, t.latency.total),
        timeToFirstAudio: Math.max(peak.timeToFirstAudio, t.latency.timeToFirstAudio),
      }),
      { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 }
    );
  }

  /**
   * Encerra uma chamada
   */
  async endCall(callId: string, outcome: CallSummary['outcome'] = 'not_interested'): Promise<CallSummary> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      throw new Error(`Sessão não encontrada: ${callId}`);
    }

    session.status = 'ended';
    session.endedAt = new Date();
    session.metrics.totalDuration = session.endedAt.getTime() - session.startedAt.getTime();

    await this.config.telephony.endCall(callId);

    const summary: CallSummary = {
      callId,
      duration: session.metrics.totalDuration,
      turns: session.conversationHistory.length,
      outcome,
      metrics: session.metrics,
      transcript: session.conversationHistory,
    };

    // Exportar métricas
    await this.config.metrics.exportMetrics(callId);

    this.activeCalls.delete(callId);
    this.emit('call:ended', callId, summary);

    this.logger.info(`📊 Chamada encerrada - Duração: ${Math.round(summary.duration / 1000)}s, Turnos: ${summary.turns}`);
    this.logger.info(`📈 Latência média: STT=${session.metrics.averageLatency.stt}ms, LLM=${session.metrics.averageLatency.llm}ms, TTS=${session.metrics.averageLatency.tts}ms`);
    this.logger.info(`📈 Time to First Audio médio: ${session.metrics.averageLatency.timeToFirstAudio}ms`);

    return summary;
  }

  /**
   * Handler para webhooks (suporta Telnyx JSON e Twilio form-urlencoded)
   */
  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || '/';
    
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const contentType = req.headers['content-type'] || '';
        
        // Twilio envia form-urlencoded, Telnyx envia JSON
        if (contentType.includes('application/x-www-form-urlencoded')) {
          // Parse Twilio webhook (form-urlencoded)
          const params = new URLSearchParams(body);
          const twilioData: Record<string, string> = {};
          params.forEach((value, key) => {
            twilioData[key] = value;
          });
          
          this.logger.debug(`📡 Twilio webhook recebido: ${url}`);
          this.logger.debug(`   Dados: ${JSON.stringify(twilioData)}`);
          
          // Rotear para o handler correto baseado na URL
          if (url.includes('/call-status')) {
            this.handleTwilioStatusWebhook(twilioData);
          } else if (url.includes('/amd-status')) {
            this.handleTwilioAmdWebhook(twilioData);
          } else {
            // Webhook genérico - tentar processar como evento
            this.handleTwilioStatusWebhook(twilioData);
          }
        } else {
          // Parse Telnyx webhook (JSON)
          const event = JSON.parse(body);
          this.handleTelephonyEvent(event);
        }
        
        res.writeHead(200);
        res.end();
      } catch (error) {
        this.logger.error('Erro ao processar webhook:', error);
        res.writeHead(500);
        res.end();
      }
    });
  }

  /**
   * Handler para webhooks de status da Twilio
   */
  private handleTwilioStatusWebhook(data: Record<string, string>): void {
    const callStatus = data.CallStatus;
    const callSid = data.CallSid;
    
    this.logger.info(`📡 Twilio Status: ${callStatus} (${callSid})`);
    
    // Mapear status para evento
    const statusMap: Record<string, string> = {
      'queued': 'initiated',
      'initiated': 'initiated',
      'ringing': 'ringing',
      'in-progress': 'answered',
      'completed': 'completed',
      'busy': 'busy',
      'no-answer': 'no-answer',
      'canceled': 'canceled',
      'failed': 'failed',
    };

    const eventType = statusMap[callStatus] || callStatus;
    
    // Criar evento no formato esperado
    const event: TwilioCallEvent = {
      type: eventType as TwilioCallEvent['type'],
      payload: {
        callSid: callSid,
        accountSid: data.AccountSid,
        from: data.From,
        to: data.To,
        callStatus: callStatus,
        direction: (data.Direction || 'outbound-api') as 'outbound-api' | 'inbound',
      },
    };

    this.handleTelephonyEvent(event);
  }

  /**
   * Handler para webhooks de AMD (Answering Machine Detection) da Twilio
   */
  private handleTwilioAmdWebhook(data: Record<string, string>): void {
    const callSid = data.CallSid;
    const answeredBy = data.AnsweredBy;
    
    this.logger.info(`🤖 Twilio AMD: ${answeredBy} (${callSid})`);
    
    if (answeredBy?.includes('machine')) {
      this.logger.info(`📠 Caixa postal detectada`);
    } else if (answeredBy === 'human') {
      this.logger.info(`👤 Humano detectado`);
    }
  }

  /**
   * Handler para eventos de telefonia (suporta Telnyx e Twilio)
   */
  private handleTelephonyEvent(event: TelephonyCallEvent): void {
    const eventType = event.type;
    
    // Determinar callId baseado no tipo de evento
    const callId = this.isTelnyxEvent(event) 
      ? event.payload.call_control_id 
      : event.payload.callSid;
    
    this.logger.debug(`📡 Evento Telefonia: ${eventType} para chamada ${callId}`);
    
    // Mapear eventos para ações comuns
    if (this.isCallInitiated(eventType)) {
      this.logger.info(`📞 Chamada iniciada: ${callId}`);
    } else if (this.isCallAnswered(eventType)) {
      this.handleCallAnswered(callId);
    } else if (this.isCallEnded(eventType)) {
      this.handleCallHangup(callId);
    } else if (eventType === 'call.machine.detection.ended') {
      this.logger.info(`🤖 AMD: chamada ${callId}`);
    } else {
      this.logger.debug(`Evento não tratado: ${eventType}`);
    }
  }

  /**
   * Type guard para verificar se é evento Telnyx
   */
  private isTelnyxEvent(event: TelephonyCallEvent): event is TelnyxCallEvent {
    return 'call_control_id' in event.payload;
  }

  /**
   * Verifica se o evento indica chamada iniciada
   */
  private isCallInitiated(eventType: string): boolean {
    return eventType === 'call.initiated' || eventType === 'initiated';
  }

  /**
   * Verifica se o evento indica chamada atendida
   */
  private isCallAnswered(eventType: string): boolean {
    return eventType === 'call.answered' || eventType === 'answered';
  }

  /**
   * Verifica se o evento indica chamada encerrada
   */
  private isCallEnded(eventType: string): boolean {
    return eventType === 'call.hangup' || eventType === 'completed' || 
           eventType === 'busy' || eventType === 'no-answer' || 
           eventType === 'canceled' || eventType === 'failed';
  }

  /**
   * Trata quando a chamada é atendida
   */
  private async handleCallAnswered(callId: string): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      this.logger.warn(`Sessão não encontrada para chamada atendida: ${callId}`);
      return;
    }

    session.status = 'connected';
    this.logger.info(`✅ Chamada ${callId} atendida`);

    // Configurar callback para receber áudio desta chamada
    this.config.telephony.onAudioReceived(callId, async (audio: Buffer) => {
      await this.processTurn(callId, audio);
    });

    // Pré-carregar fillers personalizados se temos o nome
    if (session.prospectName) {
      await this.config.fillerManager.preloadFillersForName?.(session.prospectName);
    }

    // Gerar saudação inicial
    await this.generateGreeting(callId);
  }

  /**
   * Gera a saudação inicial da chamada
   */
  private async generateGreeting(callId: string): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) return;

    this.logger.info(`🎤 Gerando saudação inicial para ${callId}`);

    try {
      // Gerar mensagem de abertura com o LLM (usa inteligência centralizada)
      const messages = this.intelligence.buildLLMMessages(session);
      const response = await this.config.llm.generate(messages, {
        maxTokens: 100,
        temperature: 0.7,
      });

      // Adicionar ao histórico
      session.conversationHistory.push({
        role: 'agent',
        content: response.text,
        timestamp: new Date(),
      });

      // Sintetizar e enviar áudio
      const ttsResult = await this.config.tts.synthesize(response.text);
      
      // 🆕 Calcular duração do áudio (μ-law 8kHz = 8000 bytes/segundo)
      const audioDurationMs = (ttsResult.audioBuffer.length / 8000) * 1000;
      const now = Date.now();
      
      // 🆕 Resetar tracking antes de enviar (sendTwilioAudio vai calcular corretamente)
      this.totalAudioBytesSent.set(callId, 0);
      this.audioPlaybackStartTime.set(callId, now);
      this.audioPlaybackEndTime.set(callId, 0); // sendTwilioAudio vai calcular
      this.isPlayingAudio.set(callId, true);
      
      // 🆕 Marcar que é saudação (grace period maior para o "Alô" do usuário)
      this.isGreetingPlaying.set(callId, true);
      
      await this.sendAudioToCall(callId, ttsResult.audioBuffer);
      
      // 🆕 Agendar reset de isPlayingAudio e isGreetingPlaying após o áudio terminar
      setTimeout(() => {
        // Só resetar se ainda for a mesma reprodução
        const currentEndTime = this.audioPlaybackEndTime.get(callId);
        if (currentEndTime && currentEndTime <= Date.now()) {
          this.isPlayingAudio.set(callId, false);
          this.isGreetingPlaying.set(callId, false);
        }
      }, audioDurationMs + 1000); // +1s margem extra

      this.logger.info(`✅ Saudação enviada: "${response.text.substring(0, 50)}..." (~${(audioDurationMs/1000).toFixed(1)}s)`);
    } catch (error) {
      this.logger.error(`Erro ao gerar saudação para ${callId}:`, error);
    }
  }

  /**
   * 🆕 Toca um acknowledgment curto ("Uhum", "Hm") para indicar que está ouvindo
   * Paridade com StreamingVoiceAgent
   */
  private async playAcknowledgment(callId: string): Promise<void> {
    try {
      const ack = await this.acknowledgmentManager.getAcknowledgment(callId);
      if (!ack) {
        // Cooldown ou desabilitado
        return;
      }
      
      // Enviar áudio sem marcar como reprodução principal
      await this.sendAudioToCall(callId, ack.audio);
      this.logger.debug(`✅ Acknowledgment enviado: "${ack.text}"`);
    } catch (error) {
      this.logger.debug(`Erro ao tocar acknowledgment (não crítico):`, error);
    }
  }

  /**
   * Trata quando a chamada é encerrada
   */
  private async handleCallHangup(callId: string): Promise<void> {
    const session = this.activeCalls.get(callId);
    if (!session) {
      this.logger.warn(`Sessão não encontrada para hangup: ${callId}`);
      return;
    }

    this.logger.info(`📴 Chamada ${callId} encerrada pelo outro lado`);
    
    // Salvar gravação da chamada
    await this.saveRecording(callId);
    
    // Limpar todas as flags e timers
    this.isPlayingAudio.delete(callId);
    this.bargeInDetected.delete(callId);
    this.isProcessing.delete(callId);
    this.pendingTranscription.delete(callId);
    this.ttsQueue.delete(callId);
    this.audioPlaybackEndTime.delete(callId);
    this.isGreetingPlaying.delete(callId);
    this.totalAudioBytesSent.delete(callId);
    this.audioPlaybackStartTime.delete(callId);
    this.pendingBargeInText.delete(callId);
    this.continuationDetected.delete(callId);
    this.shouldCancelProcessing.delete(callId);
    this.hasStartedPlayback.delete(callId);
    this.lastAcknowledgmentTime.delete(callId);
    this.audioAccumulationBuffer.delete(callId);
    this.lastAudioSentTime.delete(callId);
    this.greetingTranscription.delete(callId);
    
    // Limpar módulos de gerenciamento de estado
    this.turnState.clearSession(callId);
    this.echoFilter.clearSession(callId);
    this.acknowledgmentManager.clearSession(callId);
    
    // Cancelar timer de debounce se existir
    const debounceTimer = this.transcriptionDebounceTimer.get(callId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.transcriptionDebounceTimer.delete(callId);
    }
    
    // Finalizar a sessão
    try {
      await this.endCall(callId, 'not_interested');
    } catch (error) {
      this.logger.error(`Erro ao finalizar chamada ${callId}:`, error);
      // Limpar mesmo assim
      this.activeCalls.delete(callId);
    }
  }

  /**
   * Retorna estatísticas das chamadas ativas
   */
  getActiveCallsStats(): { count: number; calls: Array<{ id: string; duration: number; turns: number }> } {
    const calls = Array.from(this.activeCalls.values()).map((session) => ({
      id: session.id,
      duration: Date.now() - session.startedAt.getTime(),
      turns: session.conversationHistory.length,
    }));

    return {
      count: calls.length,
      calls,
    };
  }
}

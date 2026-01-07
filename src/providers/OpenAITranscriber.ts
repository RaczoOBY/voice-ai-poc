/**
 * OpenAITranscriber - Speech-to-Text usando OpenAI Whisper
 * 
 * Suporta:
 * - Whisper API (batch)
 * - GPT-4o Transcribe (maior precisão)
 */

import OpenAI from 'openai';
import { Readable } from 'stream';
import WebSocket from 'ws';
import {
  ITranscriber,
  OpenAIConfig,
  TranscriptionResult,
} from '../types';
import { Logger } from '../utils/Logger';

export class OpenAITranscriber implements ITranscriber {
  private client: OpenAI;
  private config: OpenAIConfig;
  private logger: Logger;

  constructor(config: OpenAIConfig) {
    this.config = config;
    this.logger = new Logger('OpenAI-STT');
    this.client = new OpenAI({ apiKey: config.apiKey });
  }

  /**
   * Transcreve áudio para texto
   */
  async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    const startTime = Date.now();
    this.logger.debug(`🎤 Transcrevendo ${audioBuffer.length} bytes...`);

    try {
      // Converter Buffer para File-like object
      const audioFile = await this.bufferToFile(audioBuffer, 'audio.wav');

      const response = await this.client.audio.transcriptions.create({
        file: audioFile,
        model: this.config.transcriptionModel, // 'whisper-1' ou 'gpt-4o-transcribe'
        language: 'pt', // Português
        response_format: 'verbose_json', // Inclui timestamps e confidence
        timestamp_granularities: ['segment'],
      });

      const duration = Date.now() - startTime;

      const result: TranscriptionResult = {
        text: response.text,
        language: response.language,
        duration,
        segments: response.segments?.map((seg) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text,
        })),
      };

      this.logger.info(`✅ Transcrição (${duration}ms): "${result.text.substring(0, 50)}..."`);
      return result;
    } catch (error) {
      this.logger.error('Erro na transcrição:', error);
      throw error;
    }
  }

  /**
   * Converte Buffer para objeto File compatível com OpenAI
   */
  private async bufferToFile(buffer: Buffer, filename: string): Promise<File> {
    // Para Node.js, criamos um objeto File-like
    const blob = new Blob([buffer], { type: 'audio/wav' });
    return new File([blob], filename, { type: 'audio/wav' });
  }

  /**
   * Converte áudio raw PCM para WAV
   * Necessário se o áudio do Telnyx vier em formato raw
   */
  convertPcmToWav(
    pcmBuffer: Buffer,
    sampleRate: number = 16000,
    channels: number = 1,
    bitsPerSample: number = 16
  ): Buffer {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const dataSize = pcmBuffer.length;
    const headerSize = 44;
    const fileSize = headerSize + dataSize;

    const wavBuffer = Buffer.alloc(fileSize);

    // RIFF header
    wavBuffer.write('RIFF', 0);
    wavBuffer.writeUInt32LE(fileSize - 8, 4);
    wavBuffer.write('WAVE', 8);

    // fmt subchunk
    wavBuffer.write('fmt ', 12);
    wavBuffer.writeUInt32LE(16, 16); // Subchunk1Size
    wavBuffer.writeUInt16LE(1, 20); // AudioFormat (PCM)
    wavBuffer.writeUInt16LE(channels, 22);
    wavBuffer.writeUInt32LE(sampleRate, 24);
    wavBuffer.writeUInt32LE(byteRate, 28);
    wavBuffer.writeUInt16LE(blockAlign, 32);
    wavBuffer.writeUInt16LE(bitsPerSample, 34);

    // data subchunk
    wavBuffer.write('data', 36);
    wavBuffer.writeUInt32LE(dataSize, 40);

    // PCM data
    pcmBuffer.copy(wavBuffer, headerSize);

    return wavBuffer;
  }
}

/**
 * OpenAI Realtime Transcriber - Para streaming em tempo real
 * Usa a nova API Realtime da OpenAI
 * 
 * NOTA: Esta classe é experimental e requer a API Realtime da OpenAI.
 * Para uso em produção, considere usar o OpenAITranscriber padrão.
 */
export class OpenAIRealtimeTranscriber implements ITranscriber {
  private config: OpenAIConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private transcriptCallbacks: Map<string, (result: TranscriptionResult) => void> = new Map();

  constructor(config: OpenAIConfig) {
    this.config = config;
    this.logger = new Logger('OpenAI-Realtime-STT');
  }

  /**
   * Transcrição batch (fallback)
   */
  async transcribe(audioBuffer: Buffer): Promise<TranscriptionResult> {
    // Para batch, usar o transcriber padrão
    const batchTranscriber = new OpenAITranscriber(this.config);
    return batchTranscriber.transcribe(audioBuffer);
  }

  /**
   * Inicia stream de transcrição em tempo real
   */
  async startStream(callId: string): Promise<void> {
    this.logger.info(`🎙️ Iniciando stream realtime para ${callId}`);

    // Conectar à API Realtime da OpenAI
    this.ws = new WebSocket('wss://api.openai.com/v1/realtime', {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    this.ws.on('open', () => {
      this.logger.info('✅ Conectado à OpenAI Realtime API');
      
      // Configurar sessão
      this.ws?.send(JSON.stringify({
        type: 'session.update',
        session: {
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      }));
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleRealtimeEvent(callId, event);
      } catch (error) {
        this.logger.error('Erro ao parsear evento:', error);
      }
    });

    this.ws.on('error', (error: Error) => {
      this.logger.error('Erro WebSocket:', error);
    });

    this.ws.on('close', () => {
      this.logger.info('WebSocket fechado');
      this.ws = null;
    });
  }

  /**
   * Envia chunk de áudio para transcrição
   */
  feedAudio(callId: string, chunk: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('WebSocket não está conectado');
      return;
    }

    // Enviar áudio em base64
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: chunk.toString('base64'),
    }));
  }

  /**
   * Processa eventos da API Realtime
   */
  private handleRealtimeEvent(callId: string, event: Record<string, unknown>): void {
    switch (event.type) {
      case 'conversation.item.input_audio_transcription.completed':
        const callback = this.transcriptCallbacks.get(callId);
        if (callback) {
          callback({
            text: event.transcript as string,
            duration: 0,
          });
        }
        break;

      case 'input_audio_buffer.speech_started':
        this.logger.debug('🗣️ Fala detectada');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.logger.debug('🤫 Fim da fala');
        // Commit do buffer para transcrição
        this.ws?.send(JSON.stringify({
          type: 'input_audio_buffer.commit',
        }));
        break;

      case 'error':
        this.logger.error('Erro Realtime API:', event.error);
        break;
    }
  }

  /**
   * Registra callback para transcrições
   */
  onTranscript(callId: string, callback: (result: TranscriptionResult) => void): void {
    this.transcriptCallbacks.set(callId, callback);
  }

  /**
   * Para o stream
   */
  async stopStream(callId: string): Promise<void> {
    this.transcriptCallbacks.delete(callId);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

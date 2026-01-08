/**
 * ElevenLabsTTS - Text-to-Speech usando ElevenLabs
 * 
 * Suporta:
 * - Síntese batch
 * - Streaming para menor latência
 * - Múltiplas vozes e modelos
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import {
  ITTS,
  ElevenLabsConfig,
  TTSResult,
} from '../types';
import { Logger } from '../utils/Logger';

export class ElevenLabsTTS implements ITTS {
  private client: ElevenLabsClient;
  private config: ElevenLabsConfig;
  private logger: Logger;

  constructor(config: ElevenLabsConfig) {
    this.config = config;
    this.logger = new Logger('ElevenLabs-TTS');
    this.client = new ElevenLabsClient({
      apiKey: config.apiKey,
    });
  }

  /**
   * Sintetiza texto em áudio usando o cliente oficial do ElevenLabs
   * Retorna PCM 16-bit 22050Hz mono para compatibilidade com speaker
   */
  async synthesize(text: string): Promise<TTSResult> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando: "${text.substring(0, 50)}..."`);

    try {
      const stream = await this.client.textToSpeech.convert(
        this.config.voiceId,
        {
          text,
          modelId: this.config.model,
          outputFormat: 'pcm_22050',
          voiceSettings: {
            stability: this.config.stability,
            similarityBoost: this.config.similarityBoost,
            style: this.config.style,
            useSpeakerBoost: true,
          },
        }
      );

      // Converter ReadableStream para Buffer
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      // Concatenar todos os chunks em um único Buffer
      const audioBuffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
      const duration = Date.now() - startTime;

      // PCM 22050Hz mono 16-bit = 44100 bytes/segundo
      const audioDuration = audioBuffer.length / 44100;

      const result: TTSResult = {
        audioBuffer,
        duration: audioDuration,
        characterCount: text.length,
      };

      this.logger.info(`✅ TTS (${duration}ms): ${text.length} chars → ${audioBuffer.length} bytes (~${audioDuration.toFixed(1)}s)`);
      return result;
    } catch (error) {
      this.logger.error('Erro no TTS:', error);
      throw error;
    }
  }

  /**
   * Sintetiza FILLER com configurações otimizadas para sons curtos e naturais
   * - Menor stability: Mais variação natural (menos robótico)
   * - Menor similarity_boost: Som menos "perfeito"
   * - Ideal para onomatopeias como "Uhum...", "Hmm...", "Tá..."
   */
  async synthesizeFiller(text: string): Promise<TTSResult> {
    const startTime = Date.now();
    this.logger.debug(`🎵 Sintetizando filler: "${text}"`);

    try {
      const stream = await this.client.textToSpeech.convert(
        this.config.voiceId,
        {
          text,
          modelId: this.config.model,
          outputFormat: 'pcm_22050',
          voiceSettings: {
            // Configurações otimizadas para fillers naturais e curtos
            stability: 0.2,           // Muito baixo = mais natural e variado
            similarityBoost: 0.3,    // Muito baixo = menos artificial
            style: 0.0,               // Neutro
            useSpeakerBoost: false,   // Desligado para sons mais suaves
          },
        }
      );

      // Converter ReadableStream para Buffer
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      // Concatenar todos os chunks em um único Buffer
      const audioBuffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
      const duration = Date.now() - startTime;

      // PCM 22050Hz mono 16-bit = 44100 bytes/segundo
      const audioDuration = audioBuffer.length / 44100;

      const result: TTSResult = {
        audioBuffer,
        duration: audioDuration,
        characterCount: text.length,
      };

      this.logger.info(`🎵 Filler (${duration}ms): "${text}" → ${audioBuffer.length} bytes (~${audioDuration.toFixed(1)}s)`);
      return result;
    } catch (error) {
      this.logger.error('Erro no filler TTS:', error);
      throw error;
    }
  }

  /**
   * Sintetiza com streaming usando o cliente oficial do ElevenLabs
   * Retorna PCM 16-bit 22050Hz mono para compatibilidade com speaker
   */
  async synthesizeStream(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando com stream: "${text.substring(0, 50)}..."`);

    try {
      const stream = await this.client.textToSpeech.stream(
        this.config.voiceId,
        {
          text,
          modelId: this.config.model,
          outputFormat: 'pcm_22050',
          voiceSettings: {
            stability: this.config.stability,
            similarityBoost: this.config.similarityBoost,
            style: this.config.style,
            useSpeakerBoost: true,
          },
        }
      );

      const reader = stream.getReader();
      let firstChunkReceived = false;
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const buffer = Buffer.from(value);
        totalBytes += buffer.length;

        if (!firstChunkReceived) {
          const ttfb = Date.now() - startTime;
          this.logger.info(`⚡ TTS Time-to-First-Byte: ${ttfb}ms`);
          firstChunkReceived = true;
        }

        onChunk(buffer);
      }

      const duration = Date.now() - startTime;
      this.logger.info(`✅ TTS Stream completo (${duration}ms): ${totalBytes} bytes`);
    } catch (error) {
      this.logger.error('Erro no TTS stream:', error);
      throw error;
    }
  }

  /**
   * Lista vozes disponíveis
   */
  async listVoices(): Promise<Array<{ id: string; name: string; labels: Record<string, string> }>> {
    const response = await this.client.voices.getAll();
    
    return response.voices.map((voice) => ({
      id: voice.voiceId,
      name: voice.name || 'Unknown',
      labels: voice.labels || {},
    }));
  }

  /**
   * Obtém informações de uma voz específica
   */
  async getVoice(voiceId: string): Promise<{ id: string; name: string; samples: number }> {
    const voice = await this.client.voices.get(voiceId);
    
    return {
      id: voice.voiceId,
      name: voice.name || 'Unknown',
      samples: voice.samples?.length || 0,
    };
  }

  /**
   * Pré-aquece a conexão para menor latência na primeira requisição
   */
  async warmup(): Promise<void> {
    this.logger.info('🔥 Pré-aquecendo conexão ElevenLabs...');
    
    try {
      // Fazer uma requisição pequena para estabelecer conexão
      await this.synthesize('.');
      this.logger.info('✅ Conexão pré-aquecida');
    } catch (error) {
      this.logger.warn('Erro no warmup (não crítico):', error);
    }
  }
}

/**
 * Vozes brasileiras recomendadas no ElevenLabs
 */
export const BRAZILIAN_VOICES = {
  // Vozes oficiais do ElevenLabs com bom português
  RACHEL: 'pFZP5JQG7iQjIQuC4Bku', // Feminina, versátil
  JOSH: 'TxGEqnHWrfWFTfGW9XjX',   // Masculina, profissional
  BELLA: 'EXAVITQu4vr4xnSDxMaL',  // Feminina, calorosa
  
  // Para clonar uma voz brasileira específica, usar Voice Design ou Instant Clone
};

/**
 * Modelos disponíveis e suas características
 */
export const ELEVENLABS_MODELS = {
  // Menor latência (~75ms TTFB)
  FLASH_V2_5: 'eleven_flash_v2_5',
  
  // Qualidade intermediária
  TURBO_V2_5: 'eleven_turbo_v2_5',
  
  // Maior qualidade (maior latência)
  MULTILINGUAL_V2: 'eleven_multilingual_v2',
};

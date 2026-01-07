/**
 * ElevenLabsTTS - Text-to-Speech usando ElevenLabs
 * 
 * Suporta:
 * - Síntese batch
 * - Streaming para menor latência
 * - Múltiplas vozes e modelos
 */

import { ElevenLabsClient } from 'elevenlabs';
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
   * Sintetiza texto em áudio
   */
  async synthesize(text: string): Promise<TTSResult> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando: "${text.substring(0, 50)}..."`);

    try {
      // Usar o método de streaming para baixa latência
      const audioStream = await this.client.textToSpeech.convert(
        this.config.voiceId,
        {
          text,
          model_id: this.config.model, // 'eleven_flash_v2_5' para baixa latência
          voice_settings: {
            stability: this.config.stability,
            similarity_boost: this.config.similarityBoost,
            style: this.config.style,
            use_speaker_boost: true,
          },
          output_format: this.config.outputFormat as any, // 'pcm_16000' para telefonia
        }
      );

      // Coletar chunks do stream
      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.from(chunk));
      }

      const audioBuffer = Buffer.concat(chunks);
      const duration = Date.now() - startTime;

      // Estimar duração do áudio (PCM 16kHz mono = 32000 bytes/segundo)
      const audioDuration = audioBuffer.length / 32000;

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
   * Sintetiza com streaming (envia chunks conforme ficam prontos)
   */
  async synthesizeStream(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando com stream: "${text.substring(0, 50)}..."`);

    try {
      const audioStream = await this.client.textToSpeech.convertAsStream(
        this.config.voiceId,
        {
          text,
          model_id: this.config.model,
          voice_settings: {
            stability: this.config.stability,
            similarity_boost: this.config.similarityBoost,
            style: this.config.style,
            use_speaker_boost: true,
          },
          output_format: this.config.outputFormat as any,
        }
      );

      let firstChunkReceived = false;
      let totalBytes = 0;

      for await (const chunk of audioStream) {
        const buffer = Buffer.from(chunk);
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
      id: voice.voice_id,
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
      id: voice.voice_id,
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

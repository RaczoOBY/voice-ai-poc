/**
 * ElevenLabsTTS - Text-to-Speech usando ElevenLabs
 * 
 * Suporta:
 * - Síntese batch
 * - Streaming para menor latência
 * - Múltiplas vozes e modelos
 * 
 * Nota: Usa fetch direto ao invés da biblioteca elevenlabs
 * devido a bugs de autenticação na biblioteca npm.
 */

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import {
  ITTS,
  ElevenLabsConfig,
  TTSResult,
} from '../types';
import { Logger } from '../utils/Logger';

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io/v1';

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
   * Sintetiza texto em áudio usando fetch direto
   * Retorna PCM 16-bit 16kHz mono para compatibilidade com speaker
   */
  async synthesize(text: string): Promise<TTSResult> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando: "${text.substring(0, 50)}..."`);

    try {
      // Usar output_format=pcm_22050 para obter PCM raw compatível com speaker
      const response = await fetch(
        `${ELEVENLABS_API_BASE}/text-to-speech/${this.config.voiceId}?output_format=pcm_22050`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/pcm',
            'Content-Type': 'application/json',
            'xi-api-key': this.config.apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: this.config.model,
            voice_settings: {
              stability: this.config.stability,
              similarity_boost: this.config.similarityBoost,
              style: this.config.style,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`ElevenLabs API error ${response.status}: ${errorBody}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = Buffer.from(arrayBuffer);
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
   * Sintetiza com streaming usando fetch direto
   * Retorna PCM 16-bit 16kHz mono para compatibilidade com speaker
   */
  async synthesizeStream(text: string, onChunk: (chunk: Buffer) => void): Promise<void> {
    const startTime = Date.now();
    this.logger.debug(`🔊 Sintetizando com stream: "${text.substring(0, 50)}..."`);

    try {
      // Usar output_format=pcm_22050 para obter PCM raw compatível com speaker
      const response = await fetch(
        `${ELEVENLABS_API_BASE}/text-to-speech/${this.config.voiceId}/stream?output_format=pcm_22050`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/pcm',
            'Content-Type': 'application/json',
            'xi-api-key': this.config.apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: this.config.model,
            voice_settings: {
              stability: this.config.stability,
              similarity_boost: this.config.similarityBoost,
              style: this.config.style,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`ElevenLabs API error ${response.status}: ${errorBody}`);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      const reader = response.body.getReader();
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

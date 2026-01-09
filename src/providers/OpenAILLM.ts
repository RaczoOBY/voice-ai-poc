/**
 * OpenAILLM - Provider de LLM usando OpenAI
 * 
 * Suporta:
 * - Chat Completions API (GPT-4o, GPT-4o-mini)
 * - Realtime API (para voice-to-voice nativo)
 */

import OpenAI from 'openai';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  ILLM,
  OpenAIConfig,
  LLMResponse,
} from '../types';
import { Logger } from '../utils/Logger';

export class OpenAILLM implements ILLM {
  private client: OpenAI;
  private config: OpenAIConfig;
  private logger: Logger;

  constructor(config: OpenAIConfig) {
    this.config = config;
    this.logger = new Logger('OpenAI-LLM');
    this.client = new OpenAI({ apiKey: config.apiKey });
  }

  /**
   * Gera resposta do LLM
   */
  async generate(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    this.logger.debug(`🤖 Gerando resposta (${messages.length} mensagens)...`);

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.llmModel, // 'gpt-4o' ou 'gpt-4o-mini'
        messages: messages as any,
        max_tokens: options?.maxTokens || 120, // Balanceado: respostas completas mas concisas
        temperature: options?.temperature || 0.7,
        // Otimizações para baixa latência
        stream: false, // Para métricas precisas, não usar stream
      });

      const duration = Date.now() - startTime;
      const choice = response.choices[0];

      const result: LLMResponse = {
        text: choice.message.content || '',
        finishReason: choice.finish_reason as LLMResponse['finishReason'],
        usage: response.usage ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } : undefined,
      };

      this.logger.info(`✅ LLM (${duration}ms, ${result.usage?.totalTokens || 0} tokens): "${result.text.substring(0, 50)}..."`);
      return result;
    } catch (error) {
      this.logger.error('Erro no LLM:', error);
      throw error;
    }
  }

  /**
   * Gera resposta com streaming
   * Útil para começar TTS antes do LLM terminar
   */
  async generateStream(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    const startTime = Date.now();
    this.logger.debug(`🤖 Gerando resposta com stream...`);

    try {
      const stream = await this.client.chat.completions.create({
        model: this.config.llmModel,
        messages: messages as any,
        max_tokens: 120, // Balanceado: respostas completas mas concisas
        temperature: 0.7,
        stream: true,
      });

      let fullText = '';
      let finishReason: LLMResponse['finishReason'] = 'stop';

      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          fullText += content;
          onChunk(content);
        }
        
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason as LLMResponse['finishReason'];
        }
      }

      const duration = Date.now() - startTime;
      this.logger.info(`✅ LLM Stream (${duration}ms, ${fullText.length} chars):`);
      this.logger.info(`   📝 Resposta: "${fullText}"`);

      return {
        text: fullText,
        finishReason,
      };
    } catch (error) {
      this.logger.error('Erro no LLM stream:', error);
      throw error;
    }
  }
}

/**
 * OpenAI Realtime LLM - Para voice-to-voice nativo
 * Usa a API Realtime para menor latência possível
 * 
 * NOTA: Esta classe é experimental e requer a API Realtime da OpenAI.
 * Para uso em produção, considere usar o OpenAILLM padrão.
 */
export class OpenAIRealtimeLLM extends EventEmitter implements ILLM {
  private config: OpenAIConfig;
  private logger: Logger;
  private ws: WebSocket | null = null;

  constructor(config: OpenAIConfig) {
    super();
    this.config = config;
    this.logger = new Logger('OpenAI-Realtime-LLM');
  }

  /**
   * Fallback para Chat Completions
   */
  async generate(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<LLMResponse> {
    const standardLLM = new OpenAILLM(this.config);
    return standardLLM.generate(messages, options);
  }

  /**
   * Conecta à API Realtime
   */
  async connect(systemPrompt: string): Promise<void> {
    this.logger.info('🔌 Conectando à OpenAI Realtime API...');

    this.ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });

    return new Promise((resolve, reject) => {
      this.ws!.on('open', () => {
        this.logger.info('✅ Conectado à OpenAI Realtime API');
        
        // Configurar sessão
        this.ws?.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: systemPrompt,
            voice: 'alloy', // Voz nativa da OpenAI
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
            temperature: 0.7,
            max_response_output_tokens: 150,
          },
        }));
        
        resolve();
      });

      this.ws!.on('error', (error: Error) => {
        this.logger.error('Erro WebSocket:', error);
        reject(error);
      });

      this.ws!.on('message', (data: WebSocket.RawData) => {
        this.handleRealtimeEvent(JSON.parse(data.toString()));
      });
    });
  }

  /**
   * Envia áudio diretamente para processamento voice-to-voice
   */
  sendAudio(audioBuffer: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.logger.warn('WebSocket não conectado');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: audioBuffer.toString('base64'),
    }));
  }

  /**
   * Processa eventos da API Realtime
   */
  private handleRealtimeEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'session.created':
        this.logger.info('Sessão criada');
        break;

      case 'session.updated':
        this.logger.info('Sessão atualizada');
        break;

      case 'response.audio.delta':
        // Áudio de resposta (streaming)
        super.emit('audio', Buffer.from(event.delta as string, 'base64'));
        break;

      case 'response.audio_transcript.delta':
        // Transcrição da resposta (para logs)
        this.logger.debug(`Resposta: ${event.delta}`);
        break;

      case 'response.done':
        this.logger.info('Resposta completa');
        break;

      case 'input_audio_buffer.speech_started':
        this.logger.debug('Fala do usuário detectada');
        break;

      case 'input_audio_buffer.speech_stopped':
        this.logger.debug('Fim da fala do usuário');
        break;

      case 'error':
        this.logger.error('Erro Realtime:', event.error);
        break;
    }
  }

  /**
   * Registra callback para áudio de resposta
   */
  onAudio(callback: (audio: Buffer) => void): void {
    this.on('audio', callback);
  }

  /**
   * Desconecta
   */
  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

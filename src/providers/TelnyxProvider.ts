/**
 * TelnyxProvider - Provider de telefonia
 * 
 * Responsável por:
 * - Fazer e receber chamadas
 * - Streaming de áudio bidirecional via WebSocket
 * - Gerenciar eventos de chamada
 * 
 * NOTA: Esta implementação usa a API REST do Telnyx diretamente
 * para melhor controle e compatibilidade de tipos.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  ITelephonyProvider,
  TelnyxConfig,
  TelnyxCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';

// Interface para resposta da API Telnyx
interface TelnyxCallResponse {
  data: {
    call_control_id: string;
    call_leg_id: string;
    call_session_id: string;
  };
}

export class TelnyxProvider extends EventEmitter implements ITelephonyProvider {
  private config: TelnyxConfig;
  private logger: Logger;
  private baseUrl = 'https://api.telnyx.com/v2';
  
  // WebSocket connections por call
  private audioStreams: Map<string, WebSocket> = new Map();
  
  // Callbacks de áudio recebido
  private audioCallbacks: Map<string, (audio: Buffer) => void> = new Map();
  
  // Event callback
  private callEventCallback?: (event: TelnyxCallEvent) => void;

  constructor(config: TelnyxConfig) {
    super();
    this.config = config;
    this.logger = new Logger('Telnyx');
  }

  /**
   * Faz requisição para API Telnyx
   */
  private async apiRequest<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Inicia uma chamada outbound
   */
  async makeCall(phoneNumber: string): Promise<string> {
    this.logger.info(`📞 Iniciando chamada para ${phoneNumber}`);

    try {
      const response = await this.apiRequest<TelnyxCallResponse>('POST', '/calls', {
        connection_id: this.config.connectionId,
        to: phoneNumber,
        from: this.config.phoneNumber,
        webhook_url: this.config.webhookUrl,
        webhook_url_method: 'POST',
        // Configurações para voice AI
        answering_machine_detection: 'detect_words',
        client_state: Buffer.from(JSON.stringify({ type: 'outbound_prospecting' })).toString('base64'),
      });

      const callControlId = response.data.call_control_id;
      this.logger.info(`✅ Chamada iniciada: ${callControlId}`);

      return callControlId;
    } catch (error) {
      this.logger.error('Erro ao iniciar chamada:', error);
      throw error;
    }
  }

  /**
   * Encerra uma chamada
   */
  async endCall(callId: string): Promise<void> {
    this.logger.info(`📴 Encerrando chamada ${callId}`);

    try {
      await this.apiRequest('POST', `/calls/${callId}/actions/hangup`, {});
      
      // Fechar WebSocket se existir
      const ws = this.audioStreams.get(callId);
      if (ws) {
        ws.close();
        this.audioStreams.delete(callId);
      }
      
      this.audioCallbacks.delete(callId);
      this.logger.info(`✅ Chamada ${callId} encerrada`);
    } catch (error) {
      this.logger.error(`Erro ao encerrar chamada ${callId}:`, error);
      throw error;
    }
  }

  /**
   * Envia áudio para a chamada
   */
  async sendAudio(callId: string, audioBuffer: Buffer): Promise<void> {
    const ws = this.audioStreams.get(callId);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Enviar via WebSocket (streaming)
      ws.send(audioBuffer);
      this.logger.debug(`🔊 Áudio enviado via WebSocket: ${audioBuffer.length} bytes`);
    } else {
      // Fallback: usar API de play audio
      await this.playAudioViaApi(callId, audioBuffer);
    }
  }

  /**
   * Fallback: reproduz áudio via API (maior latência)
   */
  private async playAudioViaApi(callId: string, audioBuffer: Buffer): Promise<void> {
    try {
      // Converter para base64 e enviar como audio URL
      const base64Audio = audioBuffer.toString('base64');
      
      await this.apiRequest('POST', `/calls/${callId}/actions/playback_start`, {
        audio_url: `data:audio/raw;base64,${base64Audio}`,
      });
      
      this.logger.debug(`🔊 Áudio enviado via API: ${audioBuffer.length} bytes`);
    } catch (error) {
      this.logger.error('Erro ao enviar áudio:', error);
      throw error;
    }
  }

  /**
   * Inicia streaming de áudio bidirecional
   */
  async startAudioStream(callId: string): Promise<void> {
    this.logger.info(`🎙️ Iniciando stream de áudio para ${callId}`);

    try {
      // Solicitar streaming via Telnyx Call Control
      await this.apiRequest('POST', `/calls/${callId}/actions/streaming_start`, {
        stream_url: `wss://seu-servidor.com/audio/${callId}`, // Seu WebSocket server
        stream_track: 'both_tracks',
        enable_dialogflow: false,
      });

      this.logger.info(`✅ Stream iniciado para ${callId}`);
    } catch (error) {
      this.logger.error('Erro ao iniciar stream:', error);
      throw error;
    }
  }

  /**
   * Configura WebSocket server para receber áudio do Telnyx
   */
  setupWebSocketServer(wss: WebSocket.Server): void {
    wss.on('connection', (ws, req) => {
      // Extrair callId da URL
      const callId = req.url?.split('/').pop();
      if (!callId) {
        ws.close();
        return;
      }

      this.logger.info(`🔌 WebSocket conectado para call ${callId}`);
      this.audioStreams.set(callId, ws);

      // Buffer para acumular chunks de áudio
      let audioBuffer: Buffer[] = [];
      let silenceTimeout: NodeJS.Timeout | null = null;

      ws.on('message', (data: Buffer) => {
        // Processar mensagem do Telnyx
        try {
          // Telnyx envia JSON com metadados ou raw audio
          const message = this.parseStreamMessage(data);
          
          if (message.type === 'audio') {
            audioBuffer.push(message.payload);
            
            // Reset silence detection
            if (silenceTimeout) clearTimeout(silenceTimeout);
            silenceTimeout = setTimeout(() => {
              // Silêncio detectado - processar áudio acumulado
              if (audioBuffer.length > 0) {
                const fullAudio = Buffer.concat(audioBuffer);
                const callback = this.audioCallbacks.get(callId);
                if (callback) {
                  callback(fullAudio);
                }
                audioBuffer = [];
              }
            }, 500); // 500ms de silêncio = fim do turno
          }
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      ws.on('close', () => {
        this.logger.info(`🔌 WebSocket desconectado para call ${callId}`);
        this.audioStreams.delete(callId);
        if (silenceTimeout) clearTimeout(silenceTimeout);
      });

      ws.on('error', (error) => {
        this.logger.error(`Erro WebSocket para call ${callId}:`, error);
      });
    });
  }

  /**
   * Parse de mensagem do stream Telnyx
   */
  private parseStreamMessage(data: Buffer): { type: 'audio' | 'event'; payload: any } {
    try {
      // Tentar parsear como JSON primeiro
      const json = JSON.parse(data.toString());
      
      if (json.event === 'media') {
        // Áudio em base64
        return {
          type: 'audio',
          payload: Buffer.from(json.media.payload, 'base64'),
        };
      }
      
      return { type: 'event', payload: json };
    } catch {
      // Raw audio
      return { type: 'audio', payload: data };
    }
  }

  /**
   * Registra callback para áudio recebido
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
   * Processa webhook do Telnyx
   */
  handleWebhook(event: any): void {
    const eventType = event.data?.event_type || event.event_type;
    this.logger.debug(`📡 Webhook: ${eventType}`);

    const telnyxEvent: TelnyxCallEvent = {
      type: eventType,
      payload: {
        call_control_id: event.data?.payload?.call_control_id,
        call_leg_id: event.data?.payload?.call_leg_id,
        call_session_id: event.data?.payload?.call_session_id,
        from: event.data?.payload?.from,
        to: event.data?.payload?.to,
        state: event.data?.payload?.state,
      },
    };

    // Handlers específicos por tipo de evento
    switch (eventType) {
      case 'call.initiated':
        this.logger.info(`📞 Chamada iniciada: ${telnyxEvent.payload.call_control_id}`);
        break;

      case 'call.answered':
        this.logger.info(`✅ Chamada atendida: ${telnyxEvent.payload.call_control_id}`);
        // Iniciar streaming quando a chamada é atendida
        this.startAudioStream(telnyxEvent.payload.call_control_id);
        break;

      case 'call.hangup':
        this.logger.info(`📴 Chamada encerrada: ${telnyxEvent.payload.call_control_id}`);
        // Limpar recursos
        const callId = telnyxEvent.payload.call_control_id;
        this.audioStreams.delete(callId);
        this.audioCallbacks.delete(callId);
        break;

      case 'call.machine.detection.ended':
        const result = event.data?.payload?.result;
        this.logger.info(`🤖 AMD resultado: ${result}`);
        if (result === 'machine') {
          // Caixa postal detectada - encerrar ou deixar mensagem
          this.logger.info('Caixa postal detectada');
        }
        break;

      case 'streaming.started':
        this.logger.info(`🎙️ Streaming iniciado: ${telnyxEvent.payload.call_control_id}`);
        break;

      case 'streaming.stopped':
        this.logger.info(`🎙️ Streaming parado: ${telnyxEvent.payload.call_control_id}`);
        break;
    }

    // Notificar callback
    if (this.callEventCallback) {
      this.callEventCallback(telnyxEvent);
    }
  }

  /**
   * Atende uma chamada inbound
   */
  async answerCall(callId: string): Promise<void> {
    await this.apiRequest('POST', `/calls/${callId}/actions/answer`, {});
    this.logger.info(`✅ Chamada ${callId} atendida`);
  }

  /**
   * Transfere chamada para outro número
   */
  async transferCall(callId: string, toNumber: string): Promise<void> {
    await this.apiRequest('POST', `/calls/${callId}/actions/transfer`, {
      to: toNumber,
    });
    this.logger.info(`↗️ Chamada ${callId} transferida para ${toNumber}`);
  }

  /**
   * Coloca chamada em espera
   */
  async holdCall(callId: string, audioUrl?: string): Promise<void> {
    await this.apiRequest('POST', `/calls/${callId}/actions/hold`, {
      audio_url: audioUrl,
    });
    this.logger.info(`⏸️ Chamada ${callId} em espera`);
  }

  /**
   * Retoma chamada da espera
   */
  async unholdCall(callId: string): Promise<void> {
    await this.apiRequest('POST', `/calls/${callId}/actions/unhold`, {});
    this.logger.info(`▶️ Chamada ${callId} retomada`);
  }
}

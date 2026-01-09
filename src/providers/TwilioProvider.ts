/**
 * TwilioProvider - Provider de telefonia Twilio
 * 
 * Responsável por:
 * - Fazer chamadas outbound via API REST
 * - Streaming de áudio bidirecional via Media Streams (WebSocket)
 * - Gerenciar eventos de chamada
 * 
 * Documentação:
 * - Voice API: https://www.twilio.com/docs/voice/api
 * - Media Streams: https://www.twilio.com/docs/voice/media-streams
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  ITelephonyProvider,
  TwilioConfig,
  TwilioCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';

// Interface para resposta da API Twilio
// https://www.twilio.com/docs/voice/api/call-resource
interface TwilioCallResponse {
  sid: string;
  account_sid: string;
  status: string;
  direction: string;
  from: string;
  from_formatted: string;
  to: string;
  to_formatted: string;
  date_created: string;
  date_updated: string;
  start_time?: string;
  end_time?: string;
  duration?: string;
  price?: string;
  price_unit?: string;
  answered_by?: string;
  api_version: string;
  uri: string;
}

// Interface para mensagens do Media Stream
interface TwilioMediaMessage {
  event: 'connected' | 'start' | 'media' | 'stop' | 'mark';
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string; // Base64 encoded audio
  };
  mark?: {
    name: string;
  };
}

export class TwilioProvider extends EventEmitter implements ITelephonyProvider {
  private config: TwilioConfig;
  private logger: Logger;
  private baseUrl = 'https://api.twilio.com/2010-04-01';
  
  // WebSocket connections por call (streamSid -> WebSocket)
  private audioStreams: Map<string, WebSocket> = new Map();
  
  // Mapeamento callSid -> streamSid
  private callToStream: Map<string, string> = new Map();
  
  // Callbacks de áudio recebido
  private audioCallbacks: Map<string, (audio: Buffer) => void> = new Map();
  
  // Event callback
  private callEventCallback?: (event: TwilioCallEvent) => void;

  constructor(config: TwilioConfig) {
    super();
    this.config = config;
    this.logger = new Logger('Twilio');
  }

  /**
   * Gera header de autenticação Basic Auth
   */
  private getAuthHeader(): string {
    const credentials = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');
    return `Basic ${credentials}`;
  }

  /**
   * Faz requisição para API Twilio
   */
  private async apiRequest<T>(
    method: string,
    endpoint: string,
    body?: Record<string, string>
  ): Promise<T> {
    const url = `${this.baseUrl}/Accounts/${this.config.accountSid}${endpoint}`;
    
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': this.getAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };

    if (body) {
      options.body = new URLSearchParams(body).toString();
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Twilio API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Gera TwiML para streaming de áudio bidirecional
   */
  private generateStreamTwiML(): string {
    const streamUrl = this.config.webhookUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    
    this.logger.info(`🔗 Stream URL: ${streamUrl}/media-stream`);
    
    // O TwiML precisa de um <Say> ou <Play> antes do <Connect><Stream>
    // para que a chamada não desligue imediatamente
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR" voice="Polly.Camila">.</Say>
  <Connect>
    <Stream url="${streamUrl}/media-stream" />
  </Connect>
</Response>`;
  }

  /**
   * Inicia uma chamada outbound
   * 
   * Documentação: https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls
   */
  async makeCall(phoneNumber: string): Promise<string> {
    this.logger.info(`📞 Iniciando chamada para ${phoneNumber}`);

    try {
      // TwiML inline para iniciar Media Stream
      const twiml = this.generateStreamTwiML();
      
      // Parâmetros conforme documentação oficial da Twilio
      // StatusCallbackEvent aceita valores separados por espaço
      const response = await this.apiRequest<TwilioCallResponse>('POST', '/Calls.json', {
        To: phoneNumber,
        From: this.config.phoneNumber,
        Twiml: twiml,
        // Status callbacks - https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls#receive-call-status-updates
        StatusCallback: `${this.config.webhookUrl}/call-status`,
        StatusCallbackEvent: 'initiated ringing answered completed',
        StatusCallbackMethod: 'POST',
        // AMD (Answering Machine Detection)
        // Valores válidos: Enable, DetectMessageEnd
        // https://www.twilio.com/docs/voice/answering-machine-detection
        MachineDetection: 'DetectMessageEnd',
        MachineDetectionTimeout: '30',
        AsyncAmd: 'true',
        AsyncAmdStatusCallback: `${this.config.webhookUrl}/amd-status`,
        AsyncAmdStatusCallbackMethod: 'POST',
      });

      const callSid = response.sid;
      this.logger.info(`✅ Chamada iniciada: ${callSid}`);

      return callSid;
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
      await this.apiRequest('POST', `/Calls/${callId}.json`, {
        Status: 'completed',
      });
      
      // Fechar WebSocket se existir
      const streamSid = this.callToStream.get(callId);
      if (streamSid) {
        const ws = this.audioStreams.get(streamSid);
        if (ws) {
          ws.close();
          this.audioStreams.delete(streamSid);
        }
        this.callToStream.delete(callId);
      }
      
      this.audioCallbacks.delete(callId);
      this.logger.info(`✅ Chamada ${callId} encerrada`);
    } catch (error) {
      this.logger.error(`Erro ao encerrar chamada ${callId}:`, error);
      throw error;
    }
  }

  /**
   * Envia áudio para a chamada via Media Stream
   * O áudio deve estar em formato mulaw 8kHz (formato padrão do Twilio)
   */
  async sendAudio(callId: string, audioBuffer: Buffer): Promise<void> {
    const streamSid = this.callToStream.get(callId);
    if (!streamSid) {
      this.logger.warn(`Stream não encontrado para call ${callId}`);
      return;
    }

    const ws = this.audioStreams.get(streamSid);
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Converter para base64 e enviar no formato esperado pelo Twilio
      const base64Audio = audioBuffer.toString('base64');
      
      const message = JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: base64Audio,
        },
      });
      
      ws.send(message);
      this.logger.debug(`🔊 Áudio enviado: ${audioBuffer.length} bytes`);
    } else {
      this.logger.warn(`WebSocket não disponível para call ${callId}`);
    }
  }

  /**
   * Envia marca para sincronização de áudio
   */
  async sendMark(callId: string, markName: string): Promise<void> {
    const streamSid = this.callToStream.get(callId);
    if (!streamSid) return;

    const ws = this.audioStreams.get(streamSid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({
        event: 'mark',
        streamSid: streamSid,
        mark: {
          name: markName,
        },
      });
      ws.send(message);
    }
  }

  /**
   * Limpa o buffer de áudio (para barge-in)
   */
  async clearAudioBuffer(callId: string): Promise<void> {
    const streamSid = this.callToStream.get(callId);
    if (!streamSid) return;

    const ws = this.audioStreams.get(streamSid);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const message = JSON.stringify({
        event: 'clear',
        streamSid: streamSid,
      });
      ws.send(message);
      this.logger.debug(`🧹 Buffer de áudio limpo para call ${callId}`);
    }
  }

  /**
   * Configura WebSocket server para receber Media Streams do Twilio
   */
  setupWebSocketServer(wss: WebSocket.Server): void {
    wss.on('connection', (ws, req) => {
      this.logger.info(`🔌 WebSocket conectado: ${req.url}`);

      let currentCallSid: string | null = null;
      let currentStreamSid: string | null = null;

      ws.on('message', (data: Buffer) => {
        try {
          const message: TwilioMediaMessage = JSON.parse(data.toString());
          
          switch (message.event) {
            case 'connected':
              this.logger.info('📡 Media Stream conectado');
              break;

            case 'start':
              if (message.start) {
                currentCallSid = message.start.callSid;
                currentStreamSid = message.start.streamSid;
                
                this.audioStreams.set(currentStreamSid, ws);
                this.callToStream.set(currentCallSid, currentStreamSid);
                
                this.logger.info(`🎙️ Stream iniciado: call=${currentCallSid}, stream=${currentStreamSid}`);
                this.logger.info(`📊 Formato: ${JSON.stringify(message.start.mediaFormat)}`);
              }
              break;

            case 'media':
              if (message.media && currentCallSid) {
                // Decodificar áudio de base64
                const audioBuffer = Buffer.from(message.media.payload, 'base64');
                
                // Notificar callback
                const callback = this.audioCallbacks.get(currentCallSid);
                if (callback) {
                  callback(audioBuffer);
                }
              }
              break;

            case 'mark':
              if (message.mark) {
                this.logger.debug(`🏷️ Mark recebido: ${message.mark.name}`);
                this.emit('mark', { callId: currentCallSid, name: message.mark.name });
              }
              break;

            case 'stop':
              this.logger.info(`⏹️ Stream parado: ${currentStreamSid}`);
              break;
          }
        } catch (error) {
          this.logger.error('Erro ao processar mensagem:', error);
        }
      });

      ws.on('close', () => {
        this.logger.info(`🔌 WebSocket desconectado: ${currentStreamSid}`);
        if (currentStreamSid) {
          this.audioStreams.delete(currentStreamSid);
        }
        if (currentCallSid) {
          this.callToStream.delete(currentCallSid);
          this.audioCallbacks.delete(currentCallSid);
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`Erro WebSocket:`, error);
      });
    });
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
  onCallEvent(callback: (event: TwilioCallEvent) => void): void {
    this.callEventCallback = callback;
  }

  /**
   * Processa webhook de status da chamada
   */
  handleStatusWebhook(body: Record<string, string>): void {
    const callStatus = body.CallStatus;
    const callSid = body.CallSid;
    
    this.logger.debug(`📡 Status webhook: ${callStatus} (${callSid})`);

    // Mapear status do Twilio para nosso tipo
    const statusMap: Record<string, TwilioCallEvent['type']> = {
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

    const eventType = statusMap[callStatus] || 'initiated';

    const event: TwilioCallEvent = {
      type: eventType,
      payload: {
        callSid: callSid,
        accountSid: body.AccountSid,
        from: body.From,
        to: body.To,
        callStatus: callStatus,
        direction: body.Direction as 'outbound-api' | 'inbound',
      },
    };

    // Log específico por evento
    switch (eventType) {
      case 'initiated':
        this.logger.info(`📞 Chamada iniciada: ${callSid}`);
        break;
      case 'ringing':
        this.logger.info(`🔔 Chamada tocando: ${callSid}`);
        break;
      case 'answered':
        this.logger.info(`✅ Chamada atendida: ${callSid}`);
        break;
      case 'completed':
        this.logger.info(`📴 Chamada encerrada: ${callSid}`);
        // Limpar recursos
        const streamSid = this.callToStream.get(callSid);
        if (streamSid) {
          this.audioStreams.delete(streamSid);
          this.callToStream.delete(callSid);
        }
        this.audioCallbacks.delete(callSid);
        break;
      case 'busy':
      case 'no-answer':
      case 'canceled':
      case 'failed':
        this.logger.warn(`⚠️ Chamada ${eventType}: ${callSid}`);
        break;
    }

    // Notificar callback
    if (this.callEventCallback) {
      this.callEventCallback(event);
    }
  }

  /**
   * Processa webhook de AMD (Answering Machine Detection)
   */
  handleAmdWebhook(body: Record<string, string>): void {
    const callSid = body.CallSid;
    const answeredBy = body.AnsweredBy;
    const machineDetectionDuration = body.MachineDetectionDuration;
    
    this.logger.info(`🤖 AMD resultado: ${answeredBy} (${callSid})`);
    
    if (answeredBy === 'machine_start' || answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_silence' || answeredBy === 'machine_end_other') {
      this.logger.info(`📠 Caixa postal detectada (${answeredBy}) - duração: ${machineDetectionDuration}ms`);
      this.emit('amd', { callId: callSid, result: answeredBy, duration: machineDetectionDuration });
    } else if (answeredBy === 'human') {
      this.logger.info(`👤 Humano detectado`);
      this.emit('amd', { callId: callSid, result: 'human', duration: machineDetectionDuration });
    }
  }

  /**
   * Retorna informações de uma chamada
   */
  async getCallInfo(callId: string): Promise<TwilioCallResponse> {
    return this.apiRequest<TwilioCallResponse>('GET', `/Calls/${callId}.json`);
  }

  /**
   * Faz chamada outbound usando URL em vez de TwiML inline
   * Útil quando você tem um servidor servindo TwiML
   * 
   * Documentação: https://www.twilio.com/docs/voice/tutorials/how-to-make-outbound-phone-calls
   */
  async makeCallWithUrl(phoneNumber: string, twimlUrl: string): Promise<string> {
    this.logger.info(`📞 Iniciando chamada para ${phoneNumber} com URL: ${twimlUrl}`);

    try {
      const response = await this.apiRequest<TwilioCallResponse>('POST', '/Calls.json', {
        To: phoneNumber,
        From: this.config.phoneNumber,
        Url: twimlUrl,
        Method: 'POST',
        StatusCallback: `${this.config.webhookUrl}/call-status`,
        StatusCallbackEvent: 'initiated ringing answered completed',
        StatusCallbackMethod: 'POST',
        Timeout: '30',
      });

      const callSid = response.sid;
      this.logger.info(`✅ Chamada iniciada: ${callSid}`);

      return callSid;
    } catch (error) {
      this.logger.error('Erro ao iniciar chamada:', error);
      throw error;
    }
  }

  /**
   * Modifica uma chamada em progresso
   * 
   * Documentação: https://www.twilio.com/docs/voice/tutorials/how-to-modify-calls-in-progress
   */
  async updateCall(callId: string, options: { url?: string; twiml?: string; status?: 'canceled' | 'completed' }): Promise<TwilioCallResponse> {
    this.logger.info(`🔄 Atualizando chamada ${callId}`);

    const params: Record<string, string> = {};
    if (options.url) params.Url = options.url;
    if (options.twiml) params.Twiml = options.twiml;
    if (options.status) params.Status = options.status;

    return this.apiRequest<TwilioCallResponse>('POST', `/Calls/${callId}.json`, params);
  }
}

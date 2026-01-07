/**
 * VoiceAgent - Orquestrador principal do sistema
 * 
 * Responsável por:
 * - Gerenciar o fluxo de chamadas
 * - Coordenar STT → LLM → TTS
 * - Usar fillers para reduzir latência percebida
 * - Coletar métricas detalhadas
 */

import { EventEmitter } from 'events';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import WebSocket from 'ws';
import {
  VoiceAgentConfig,
  VoiceAgentEvents,
  CallSession,
  ConversationTurn,
  TurnMetrics,
  FillerContext,
  CallSummary,
  LatencyBreakdown,
  TelnyxCallEvent,
} from '../types';
import { Logger } from '../utils/Logger';

export class VoiceAgent extends EventEmitter {
  private config: VoiceAgentConfig;
  private activeCalls: Map<string, CallSession> = new Map();
  private logger: Logger;

  constructor(config: VoiceAgentConfig) {
    super();
    this.config = config;
    this.logger = new Logger('VoiceAgent');
  }

  /**
   * Inicia o servidor HTTP para webhooks do Telnyx
   */
  async start(port: number): Promise<void> {
    const server = createServer(this.handleWebhook.bind(this));
    
    // Criar WebSocket server para streaming de áudio
    const wss = new WebSocket.Server({ server, path: '/audio' });
    this.setupAudioWebSocket(wss);
    
    server.listen(port, () => {
      this.logger.info(`🎧 Voice Agent listening on port ${port}`);
      this.logger.info(`🔌 WebSocket server ready at ws://localhost:${port}/audio`);
    });

    // Configurar handlers de eventos de telefonia
    this.config.telephony.onCallEvent((event) => {
      this.handleTelephonyEvent(event);
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
        conversationStage: this.detectConversationStage(session),
      };

      const filler = this.config.fillerManager.getFiller(fillerContext);
      let fillerSent = false;

      if (filler) {
        // Enviar filler imediatamente enquanto LLM processa
        timestamps.fillerStart = Date.now();
        await this.config.telephony.sendAudio(callId, filler.audioBuffer);
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

      // Construir mensagens para o LLM
      const messages = this.buildLLMMessages(session);
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
      await this.config.telephony.sendAudio(callId, ttsResult.audioBuffer);

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
   * Constrói as mensagens para o LLM incluindo contexto e histórico
   */
  private buildLLMMessages(session: CallSession): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    // Substituir placeholders no system prompt
    let systemPrompt = this.config.systemPrompt
      .replace('{prospectName}', session.prospectName || 'Cliente')
      .replace('{companyName}', session.companyName || 'empresa')
      .replace('{context}', this.generateContext(session));

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Adicionar histórico de conversa (últimas N mensagens para não exceder contexto)
    const recentHistory = session.conversationHistory.slice(-10);
    for (const turn of recentHistory) {
      messages.push({
        role: turn.role === 'agent' ? 'assistant' : 'user',
        content: turn.content,
      });
    }

    return messages;
  }

  /**
   * Gera contexto dinâmico baseado no estado da conversa
   */
  private generateContext(session: CallSession): string {
    const turnCount = session.conversationHistory.length;
    const duration = Date.now() - session.startedAt.getTime();

    let context = `Turno ${turnCount + 1} da conversa. `;
    context += `Duração: ${Math.round(duration / 1000)}s. `;

    if (turnCount === 0) {
      context += 'Esta é a abertura da chamada. Apresente-se brevemente.';
    } else if (turnCount < 4) {
      context += 'Fase de introdução. Descubra se há interesse.';
    } else if (turnCount < 8) {
      context += 'Fase de qualificação. Entenda as necessidades.';
    } else {
      context += 'Fase de fechamento. Tente agendar próximo passo.';
    }

    return context;
  }

  /**
   * Detecta o estágio da conversa para seleção de fillers
   */
  private detectConversationStage(session: CallSession): FillerContext['conversationStage'] {
    const turnCount = session.conversationHistory.length;
    
    if (turnCount < 2) return 'intro';
    if (turnCount < 6) return 'qualifying';
    if (turnCount < 10) return 'presenting';
    return 'closing';
  }

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
   * Handler para webhooks do Telnyx
   */
  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const event = JSON.parse(body);
        this.handleTelephonyEvent(event);
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
   * Handler para eventos de telefonia
   */
  private handleTelephonyEvent(event: TelnyxCallEvent): void {
    const eventType = event.type;
    const callId = event.payload.call_control_id;
    
    this.logger.debug(`📡 Evento Telnyx: ${eventType} para chamada ${callId}`);
    
    switch (eventType) {
      case 'call.initiated':
        this.logger.info(`📞 Chamada iniciada: ${callId}`);
        break;

      case 'call.answered':
        this.handleCallAnswered(callId);
        break;

      case 'call.hangup':
        this.handleCallHangup(callId);
        break;

      case 'call.machine.detection.ended':
        // Detectou se é pessoa ou caixa postal
        this.logger.info(`🤖 AMD: chamada ${callId}`);
        break;

      default:
        this.logger.debug(`Evento não tratado: ${eventType}`);
    }
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
      // Gerar mensagem de abertura com o LLM
      const messages = this.buildLLMMessages(session);
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
      await this.config.telephony.sendAudio(callId, ttsResult.audioBuffer);

      this.logger.info(`✅ Saudação enviada: "${response.text.substring(0, 50)}..."`);
    } catch (error) {
      this.logger.error(`Erro ao gerar saudação para ${callId}:`, error);
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

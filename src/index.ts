/**
 * Voice AI Prospecting System - Proof of Concept
 * 
 * Stack:
 * - Telnyx/Twilio: Telefonia (SIP/WebSocket)
 * - OpenAI: Transcrição (Whisper) + LLM (GPT-4o Realtime ou Chat)
 * - ElevenLabs: Text-to-Speech
 * 
 * Arquitetura modular com métricas de latência em cada etapa
 */

import { VoiceAgent } from './core/VoiceAgent';
import { TelnyxProvider } from './providers/TelnyxProvider';
import { TwilioProvider } from './providers/TwilioProvider';
import { OpenAITranscriber } from './providers/OpenAITranscriber';
import { ElevenLabsScribe } from './providers/ElevenLabsScribe';
import { OpenAILLM } from './providers/OpenAILLM';
import { ElevenLabsTTS } from './providers/ElevenLabsTTS';
import { FillerManager } from './core/FillerManager';
import { MetricsCollector } from './core/MetricsCollector';
import { Logger } from './utils/Logger';
import { config } from './config';
import { ITelephonyProvider, ITranscriber } from './types';

async function main() {
  const logger = new Logger('Main');
  logger.info('🚀 Iniciando Voice AI POC...');
  logger.info(`📡 Modo de telefonia: ${config.mode}`);

  // Inicializar métricas
  const metrics = new MetricsCollector();

  // Inicializar provider de telefonia baseado no MODE
  let telephony: ITelephonyProvider;
  
  if (config.mode === 'twilio') {
    logger.info('📞 Usando Twilio como provider de telefonia');
    telephony = new TwilioProvider(config.twilio);
  } else if (config.mode === 'telnyx') {
    logger.info('📞 Usando Telnyx como provider de telefonia');
    telephony = new TelnyxProvider(config.telnyx);
  } else {
    throw new Error(`Modo de telefonia inválido para este entry point: ${config.mode}. Use 'telnyx' ou 'twilio'. Para modo local, use 'npm run local'.`);
  }

  // Inicializar outros providers
  // Twilio usa ElevenLabsScribe (streaming STT) para baixa latência
  // Telnyx usa OpenAITranscriber (batch STT)
  let transcriber: ITranscriber;
  if (config.mode === 'twilio') {
    logger.info('🎤 Usando ElevenLabs Scribe (STT streaming) para Twilio');
    transcriber = new ElevenLabsScribe(config.elevenlabs);
  } else {
    logger.info('🎤 Usando OpenAI Whisper (STT batch) para Telnyx');
    transcriber = new OpenAITranscriber(config.openai);
  }
  
  const llm = new OpenAILLM(config.openai);
  const tts = new ElevenLabsTTS(config.elevenlabs);

  // Inicializar sistema de fillers
  const fillerManager = new FillerManager(tts);
  if (config.fillers.preloadOnStartup) {
    logger.info('🔄 Pré-carregando fillers...');
    await fillerManager.preloadFillers();
    logger.info('✅ Fillers pré-carregados');
  } else {
    logger.info('⏭️  Pré-carregamento de fillers desabilitado (config.fillers.preloadOnStartup = false)');
  }

  // Criar agente de voz
  const agent = new VoiceAgent({
    telephony,
    transcriber,
    llm,
    tts,
    fillerManager,
    metrics,
    systemPrompt: config.agent.systemPrompt,
  });

  // Registrar handlers
  agent.on('call:started', (callId) => {
    logger.info(`📞 Chamada iniciada: ${callId}`);
  });

  agent.on('call:ended', (callId, summary) => {
    logger.info(`📴 Chamada encerrada: ${callId}`);
    logger.info(`📊 Métricas da chamada:`, summary.metrics);
  });

  agent.on('metrics:update', (data) => {
    logger.debug(`⏱️ ${data.stage}: ${data.duration}ms`);
  });

  // Iniciar servidor
  await agent.start(config.server.port);
  logger.info(`✅ Servidor rodando na porta ${config.server.port}`);
}

main().catch(console.error);

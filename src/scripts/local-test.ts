#!/usr/bin/env npx tsx
/**
 * Script de teste local para Voice AI
 * 
 * Permite testar todo o pipeline STT → LLM → TTS
 * usando o microfone e alto-falante do computador.
 * 
 * Uso: npm run local
 * 
 * Requisitos:
 * - macOS: brew install sox portaudio
 * - Linux: apt-get install sox libsox-fmt-all
 */

import { config, validateConfig } from '../config';
import { LocalAudioProvider } from '../providers/LocalAudioProvider';
import { OpenAITranscriber } from '../providers/OpenAITranscriber';
import { ElevenLabsScribe } from '../providers/ElevenLabsScribe';
import { OpenAILLM } from '../providers/OpenAILLM';
import { ElevenLabsTTS } from '../providers/ElevenLabsTTS';
import { FillerManager } from '../core/FillerManager';
import { StreamingVoiceAgent } from '../core/StreamingVoiceAgent';
import { Logger } from '../utils/Logger';
import { ITranscriber } from '../types';

const logger = new Logger('LocalTest');

// Cores para o terminal
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
};

function printBanner(): void {
  console.clear();
  console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║${COLORS.bright}              VOICE AI POC - MODO LOCAL                       ${COLORS.reset}${COLORS.cyan}║
╠══════════════════════════════════════════════════════════════╣
║${COLORS.reset} Status: ${COLORS.green}Iniciando...${COLORS.reset}                                       ${COLORS.cyan}║
║${COLORS.reset} Pressione ${COLORS.yellow}CTRL+C${COLORS.reset} para sair                                 ${COLORS.cyan}║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);
}

function printStatus(status: string): void {
  process.stdout.write(`\r${COLORS.dim}[${new Date().toLocaleTimeString()}]${COLORS.reset} ${status}          `);
}

function printMessage(role: 'user' | 'agent', message: string): void {
  const icon = role === 'user' ? '👤' : '🤖';
  const color = role === 'user' ? COLORS.blue : COLORS.green;
  const label = role === 'user' ? 'Usuário' : 'Agente';
  
  // Truncar mensagem se muito longa
  const displayMessage = message.length > 60 
    ? message.substring(0, 60) + '...' 
    : message;
  
  console.log(`\n${COLORS.dim}[${new Date().toLocaleTimeString()}]${COLORS.reset} ${icon} ${color}${label}:${COLORS.reset} "${displayMessage}"`);
}

function printMetrics(metrics: { stt: number; llm: number; tts: number; total: number; timeToFirstAudio: number }): void {
  console.log(`${COLORS.dim}           ⏱️  STT: ${metrics.stt}ms | LLM: ${metrics.llm}ms | TTS: ${metrics.tts}ms${COLORS.reset}`);
  console.log(`${COLORS.dim}           ⚡ Time to First Audio: ${COLORS.yellow}${metrics.timeToFirstAudio}ms${COLORS.reset}`);
}

function printBargeIn(): void {
  console.log(`\n${COLORS.yellow}🔇 Barge-in detectado! Parando reprodução...${COLORS.reset}`);
}

async function main(): Promise<void> {
  printBanner();

  try {
    // Validar configuração
    logger.info('Validando configuração...');
    validateConfig();
    logger.info('✅ Configuração OK');

    // Verificar dependências do sistema
    console.log(`\n${COLORS.yellow}⚠️  Certifique-se de ter instalado:${COLORS.reset}`);
    console.log(`   ${COLORS.dim}macOS: brew install sox portaudio${COLORS.reset}`);
    console.log(`   ${COLORS.dim}Linux: apt-get install sox libsox-fmt-all${COLORS.reset}\n`);

    // Inicializar providers
    logger.info('Inicializando providers...');
    
    const localProvider = new LocalAudioProvider();
    const llm = new OpenAILLM(config.openai);
    const tts = new ElevenLabsTTS(config.elevenlabs);

    // Escolher STT baseado na configuração
    let transcriber: ITranscriber;
    
    if (config.stt.provider === 'elevenlabs') {
      logger.info('🚀 Usando ElevenLabs Scribe (STT streaming)');
      transcriber = new ElevenLabsScribe({
        apiKey: config.elevenlabs.apiKey,
        ...config.stt.elevenlabs,
      });
    } else {
      logger.info('📦 Usando OpenAI Whisper (STT batch)');
      transcriber = new OpenAITranscriber(config.openai);
    }

    logger.info('✅ Providers inicializados');

    // Warmup do TTS
    logger.info('🔥 Aquecendo conexão com ElevenLabs TTS...');
    await tts.warmup();
    logger.info('✅ TTS aquecido');

    // Warmup do STT se for Scribe
    if (config.stt.provider === 'elevenlabs' && 'warmup' in transcriber) {
      logger.info('🔥 Aquecendo conexão com ElevenLabs Scribe...');
      await (transcriber as ElevenLabsScribe).warmup();
      logger.info('✅ Scribe aquecido');
    }

    // Inicializar FillerManager e pré-carregar fillers
    logger.info('🔄 Carregando fillers...');
    const fillerManager = new FillerManager(tts);
    await fillerManager.preloadFillers();
    logger.info('✅ Fillers carregados');

    // Criar agente de streaming
    const agent = new StreamingVoiceAgent({
      transcriber,
      llm,
      tts,
      fillerManager,
      systemPrompt: config.agent.systemPrompt,
      localProvider,
    });

    // Registrar listeners
    agent.on('user:spoke', (callId: string, text: string) => {
      printMessage('user', text);
    });

    agent.on('agent:spoke', (callId: string, text: string) => {
      printMessage('agent', text);
    });

    // Transcrições parciais (apenas Scribe)
    agent.on('partial:transcript', (callId: string, text: string) => {
      process.stdout.write(`\r${COLORS.dim}[${new Date().toLocaleTimeString()}] 👂 "${text}"${' '.repeat(20)}${COLORS.reset}`);
    });

    agent.on('metrics', (turnId: string, latency: any) => {
      printMetrics(latency);
    });

    localProvider.on('playback:interrupted', () => {
      printBargeIn();
    });

    agent.on('session:ended', (callId: string, summary: any) => {
      console.log(`\n${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗`);
      console.log(`║${COLORS.bright}                    SESSÃO ENCERRADA                          ${COLORS.reset}${COLORS.cyan}║`);
      console.log(`╠══════════════════════════════════════════════════════════════╣${COLORS.reset}`);
      console.log(`${COLORS.cyan}║${COLORS.reset} Duração: ${Math.round(summary.duration / 1000)}s                                              ${COLORS.cyan}║`);
      console.log(`${COLORS.cyan}║${COLORS.reset} Turnos: ${summary.turns}                                                ${COLORS.cyan}║`);
      console.log(`${COLORS.cyan}║${COLORS.reset} Latência média STT: ${summary.metrics.averageLatency.stt}ms                            ${COLORS.cyan}║`);
      console.log(`${COLORS.cyan}║${COLORS.reset} Latência média LLM: ${summary.metrics.averageLatency.llm}ms                            ${COLORS.cyan}║`);
      console.log(`${COLORS.cyan}║${COLORS.reset} Time to First Audio médio: ${summary.metrics.averageLatency.timeToFirstAudio}ms                  ${COLORS.cyan}║`);
      console.log(`${COLORS.cyan}╚══════════════════════════════════════════════════════════════╝${COLORS.reset}`);
    });

    // Iniciar sessão (simulando ligação de vendas - sem dados do prospect inicialmente)
    console.log(`\n${COLORS.green}📞 Simulando ligação de vendas...${COLORS.reset}`);
    console.log(`${COLORS.dim}   A vendedora vai se apresentar e pedir seu nome.${COLORS.reset}`);
    console.log(`${COLORS.dim}   Você pode interromper falando por cima (barge-in).${COLORS.reset}\n`);

    const callId = await agent.startLocalSession({
      // Não passar dados inicialmente - a vendedora vai coletar
      name: undefined,
      company: undefined,
    });

    // Handler para CTRL+C
    let isShuttingDown = false;
    process.on('SIGINT', async () => {
      if (isShuttingDown) {
        console.log(`\n${COLORS.yellow}⚠️ Aguarde, salvando gravação...${COLORS.reset}`);
        return; // Evitar múltiplas execuções
      }
      isShuttingDown = true;
      
      console.log(`\n\n${COLORS.yellow}⏹️  Encerrando sessão...${COLORS.reset}`);
      console.log(`${COLORS.dim}   Aguarde enquanto a gravação é salva...${COLORS.reset}`);
      
      try {
        const summary = await agent.endSession(callId);
        
        if (summary) {
          console.log(`\n${COLORS.green}✅ Sessão encerrada com sucesso!${COLORS.reset}`);
          console.log(`${COLORS.dim}   Duração: ${Math.round(summary.duration / 1000)}s${COLORS.reset}`);
          console.log(`${COLORS.dim}   Turnos: ${summary.turns}${COLORS.reset}`);
        }
      } catch (error) {
        console.error(`${COLORS.red}❌ Erro ao encerrar sessão:${COLORS.reset}`, error);
      }
      
      // Delay maior para garantir que a gravação foi salva
      console.log(`${COLORS.dim}   Finalizando...${COLORS.reset}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      process.exit(0);
    });

    // Manter processo rodando
    printStatus(`${COLORS.green}Ouvindo...${COLORS.reset} (CTRL+C para sair)`);

  } catch (error) {
    logger.error('❌ Erro fatal:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('sox') || error.message.includes('spawn')) {
        console.log(`\n${COLORS.yellow}💡 Dica: Instale o SoX com:${COLORS.reset}`);
        console.log(`   ${COLORS.cyan}brew install sox portaudio${COLORS.reset} (macOS)`);
        console.log(`   ${COLORS.cyan}apt-get install sox libsox-fmt-all${COLORS.reset} (Linux)`);
      } else if (error.message.includes('OPENAI')) {
        console.log(`\n${COLORS.yellow}💡 Dica: Verifique sua OPENAI_API_KEY no .env${COLORS.reset}`);
      } else if (error.message.includes('ELEVENLABS')) {
        console.log(`\n${COLORS.yellow}💡 Dica: Verifique sua ELEVENLABS_API_KEY no .env${COLORS.reset}`);
      }
    }
    
    process.exit(1);
  }
}

// Executar
main();

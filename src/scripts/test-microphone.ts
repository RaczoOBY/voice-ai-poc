#!/usr/bin/env npx tsx
/**
 * Script de teste isolado para microfone + STT
 * 
 * Testa:
 * 1. Se o microfone está funcionando
 * 2. OpenAI Whisper (batch)
 * 3. ElevenLabs Scribe (streaming)
 * 
 * Uso: npm run test:mic
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../config';
import { OpenAITranscriber } from '../providers/OpenAITranscriber';
import { ElevenLabsScribe } from '../providers/ElevenLabsScribe';
import { ITranscriber } from '../types';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║           TESTE DE MICROFONE + STT                             ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

// Configurações de VAD
const VAD_CONFIG = {
  ENERGY_THRESHOLD: 0.02,
  SILENCE_DURATION_MS: 1000,
  MIN_SPEECH_DURATION_MS: 500,
};

// Modo de teste: 'whisper' | 'scribe' | 'both'
const TEST_MODE = (process.env.TEST_STT_MODE || 'both') as 'whisper' | 'scribe' | 'both';

async function testMicrophone(): Promise<void> {
  // 1. Verificar SoX
  console.log(`${COLORS.yellow}1. Verificando SoX...${COLORS.reset}`);
  const { execSync } = require('child_process');
  
  try {
    const soxVersion = execSync('sox --version 2>&1').toString().trim();
    console.log(`${COLORS.green}✅ SoX: ${soxVersion.split('\n')[0]}${COLORS.reset}\n`);
  } catch {
    console.log(`${COLORS.red}❌ SoX não encontrado! Instale: brew install sox${COLORS.reset}\n`);
    process.exit(1);
  }

  // 2. Inicializar transcritor(es)
  console.log(`${COLORS.yellow}2. Inicializando transcritores...${COLORS.reset}`);
  console.log(`   Modo de teste: ${COLORS.cyan}${TEST_MODE}${COLORS.reset}`);
  console.log(`   STT_PROVIDER configurado: ${COLORS.cyan}${config.stt.provider}${COLORS.reset}\n`);

  let whisperTranscriber: OpenAITranscriber | null = null;
  let scribeTranscriber: ElevenLabsScribe | null = null;

  // Inicializar Whisper
  if (TEST_MODE === 'whisper' || TEST_MODE === 'both') {
    try {
      whisperTranscriber = new OpenAITranscriber(config.openai);
      console.log(`${COLORS.green}   ✅ OpenAI Whisper inicializado${COLORS.reset}`);
    } catch (error: any) {
      console.log(`${COLORS.red}   ❌ Whisper falhou: ${error.message}${COLORS.reset}`);
    }
  }

  // Inicializar Scribe
  if (TEST_MODE === 'scribe' || TEST_MODE === 'both') {
    try {
      scribeTranscriber = new ElevenLabsScribe({
        apiKey: config.elevenlabs.apiKey,
        ...config.stt.elevenlabs,
      });
      console.log(`${COLORS.green}   ✅ ElevenLabs Scribe inicializado${COLORS.reset}`);
      
      // Testar conexão WebSocket
      console.log(`${COLORS.dim}   Conectando ao WebSocket...${COLORS.reset}`);
      await scribeTranscriber.startStream('test');
      console.log(`${COLORS.green}   ✅ WebSocket conectado!${COLORS.reset}`);
    } catch (error: any) {
      console.log(`${COLORS.red}   ❌ Scribe falhou: ${error.message}${COLORS.reset}`);
      scribeTranscriber = null;
    }
  }

  if (!whisperTranscriber && !scribeTranscriber) {
    console.log(`\n${COLORS.red}❌ Nenhum transcritor disponível!${COLORS.reset}`);
    process.exit(1);
  }

  console.log();

  // 3. Iniciar captura
  console.log(`${COLORS.yellow}3. Iniciando captura do microfone...${COLORS.reset}`);
  console.log(`${COLORS.dim}   Fale algo e aguarde 1s de silêncio para transcrever${COLORS.reset}`);
  console.log(`${COLORS.dim}   Pressione CTRL+C para sair${COLORS.reset}\n`);

  try {
    const record = require('node-record-lpcm16');
    
    const recording = record.record({
      sampleRate: 16000,
      channels: 1,
      threshold: 0,
      recorder: 'sox',
      silence: '10.0',
      endOnSilence: false,
    });

    const stream = recording.stream();
    
    // Estado
    let audioBuffer: Buffer[] = [];
    let isSpeaking = false;
    let silenceStart: number | null = null;
    let speechStart: number | null = null;
    let transcriptionCount = 0;

    // Para Scribe streaming
    let scribeBuffer: Buffer[] = [];

    stream.on('data', async (chunk: Buffer) => {
      // Calcular energia
      let sum = 0;
      for (let i = 0; i < chunk.length; i += 2) {
        const sample = chunk.readInt16LE(i) / 32768;
        sum += sample * sample;
      }
      const energy = Math.sqrt(sum / (chunk.length / 2));
      const now = Date.now();

      // Barra de volume
      const bars = Math.min(50, Math.floor(energy * 500));
      const volumeBar = '█'.repeat(bars) + '░'.repeat(50 - bars);
      const isSpeakingNow = energy > VAD_CONFIG.ENERGY_THRESHOLD;
      const status = isSpeakingNow
        ? `${COLORS.green}🗣️ FALANDO${COLORS.reset}`
        : `${COLORS.dim}🤫 silêncio${COLORS.reset}`;
      process.stdout.write(`\r  [${volumeBar}] ${status} (${energy.toFixed(3)})    `);

      // Enviar para Scribe em tempo real (se disponível)
      if (scribeTranscriber && scribeTranscriber.isStreamConnected()) {
        scribeTranscriber.feedAudio('test', chunk);
      }

      // VAD manual para Whisper
      if (energy > VAD_CONFIG.ENERGY_THRESHOLD) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStart = now;
          silenceStart = null;
          audioBuffer = [];
          scribeBuffer = [];
          console.log(`\n${COLORS.blue}🎤 Início de fala detectado...${COLORS.reset}`);
        }
        audioBuffer.push(chunk);
        silenceStart = null;
      } else if (isSpeaking) {
        audioBuffer.push(chunk);
        
        if (!silenceStart) {
          silenceStart = now;
        }

        const silenceDuration = now - silenceStart;
        if (silenceDuration >= VAD_CONFIG.SILENCE_DURATION_MS) {
          const speechDuration = now - (speechStart || now);
          
          if (speechDuration >= VAD_CONFIG.MIN_SPEECH_DURATION_MS) {
            console.log(`\n${COLORS.yellow}📝 Fim da fala (${speechDuration}ms). Transcrevendo...${COLORS.reset}\n`);
            
            const fullAudio = Buffer.concat(audioBuffer);
            transcriptionCount++;

            // Testar Whisper
            if (whisperTranscriber) {
              try {
                console.log(`${COLORS.magenta}[Whisper]${COLORS.reset} Processando...`);
                const startSTT = Date.now();
                const result = await whisperTranscriber.transcribe(fullAudio);
                const sttDuration = Date.now() - startSTT;
                
                console.log(`${COLORS.magenta}[Whisper]${COLORS.reset} ${COLORS.green}✅ ${sttDuration}ms${COLORS.reset}`);
                console.log(`         ${COLORS.cyan}"${result.text}"${COLORS.reset}\n`);
              } catch (error: any) {
                console.log(`${COLORS.magenta}[Whisper]${COLORS.reset} ${COLORS.red}❌ ${error.message}${COLORS.reset}\n`);
              }
            }

            // Testar Scribe (batch mode para comparação)
            if (scribeTranscriber) {
              try {
                console.log(`${COLORS.blue}[Scribe]${COLORS.reset} Processando...`);
                const startSTT = Date.now();
                const result = await scribeTranscriber.transcribe(fullAudio);
                const sttDuration = Date.now() - startSTT;
                
                console.log(`${COLORS.blue}[Scribe]${COLORS.reset} ${COLORS.green}✅ ${sttDuration}ms${COLORS.reset}`);
                console.log(`         ${COLORS.cyan}"${result.text}"${COLORS.reset}\n`);
              } catch (error: any) {
                console.log(`${COLORS.blue}[Scribe]${COLORS.reset} ${COLORS.red}❌ ${error.message}${COLORS.reset}\n`);
              }
            }

            console.log(`${COLORS.dim}─────────────────────────────────────────────${COLORS.reset}\n`);
          } else {
            console.log(`\n${COLORS.dim}⏭️ Fala muito curta (${speechDuration}ms), ignorando${COLORS.reset}\n`);
          }

          isSpeaking = false;
          speechStart = null;
          silenceStart = null;
          audioBuffer = [];
        }
      }
    });

    // Callback para Scribe streaming (transcrições em tempo real)
    if (scribeTranscriber) {
      scribeTranscriber.onPartialTranscript('test', (text) => {
        process.stdout.write(`\r${COLORS.blue}[Scribe Parcial]${COLORS.reset} ${text}${' '.repeat(30)}`);
      });

      scribeTranscriber.onTranscript('test', (result) => {
        console.log(`\n${COLORS.blue}[Scribe Committed]${COLORS.reset} ${COLORS.green}"${result.text}"${COLORS.reset} (${result.duration}ms)`);
      });
    }

    stream.on('error', (error: Error) => {
      console.log(`\n\n${COLORS.red}❌ ERRO no microfone: ${error.message}${COLORS.reset}\n`);
      process.exit(1);
    });

    process.on('SIGINT', async () => {
      console.log(`\n\n${COLORS.cyan}⏹️ Parando...${COLORS.reset}`);
      recording.stop();
      
      if (scribeTranscriber) {
        await scribeTranscriber.disconnect();
      }
      
      console.log(`\n${COLORS.green}Resumo:${COLORS.reset}`);
      console.log(`   Transcrições: ${transcriptionCount}`);
      console.log(`   Whisper: ${whisperTranscriber ? '✅ OK' : '❌ Não usado'}`);
      console.log(`   Scribe: ${scribeTranscriber ? '✅ OK' : '❌ Não usado'}`);
      
      process.exit(0);
    });

    console.log(`${COLORS.green}✅ Sistema pronto! Fale algo...${COLORS.reset}\n`);

  } catch (error: any) {
    console.log(`${COLORS.red}❌ Erro: ${error.message}${COLORS.reset}`);
    process.exit(1);
  }
}

// Executar
testMicrophone();

#!/usr/bin/env npx tsx
/**
 * Script de teste isolado para microfone + STT
 * 
 * Testa:
 * 1. Se o microfone está funcionando corretamente no macOS
 * 2. Se a transcrição (OpenAI Whisper) está funcionando
 */

import dotenv from 'dotenv';
dotenv.config();

import { config } from '../config';
import { OpenAITranscriber } from '../providers/OpenAITranscriber';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  blue: '\x1b[34m',
};

console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║           TESTE DE MICROFONE + STT - macOS                    ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

// Configurações de VAD - ajustado para ambientes com ruído
const VAD_CONFIG = {
  ENERGY_THRESHOLD:0.02,      // Aumentado para filtrar ruído de fundo
  SILENCE_DURATION_MS: 1000,   // 1 segundo de silêncio para finalizar
  MIN_SPEECH_DURATION_MS: 500, // Mínimo 0.5s de fala
};

async function testMicrophone(): Promise<void> {
  console.log(`${COLORS.yellow}1. Verificando se SoX está instalado...${COLORS.reset}`);
  
  const { execSync } = require('child_process');
  
  try {
    const soxVersion = execSync('sox --version 2>&1').toString().trim();
    console.log(`${COLORS.green}✅ SoX encontrado: ${soxVersion.split('\n')[0]}${COLORS.reset}\n`);
  } catch {
    console.log(`${COLORS.red}❌ SoX não encontrado!${COLORS.reset}`);
    console.log(`${COLORS.yellow}   Instale com: brew install sox${COLORS.reset}\n`);
    process.exit(1);
  }

  console.log(`${COLORS.yellow}2. Inicializando transcritor (OpenAI Whisper)...${COLORS.reset}`);
  
  let transcriber: OpenAITranscriber;
  try {
    transcriber = new OpenAITranscriber(config.openai);
    console.log(`${COLORS.green}✅ Transcritor inicializado${COLORS.reset}\n`);
  } catch (error) {
    console.log(`${COLORS.red}❌ Erro ao inicializar transcritor:${COLORS.reset}`);
    console.log(`   Verifique sua OPENAI_API_KEY no .env`);
    process.exit(1);
  }

  console.log(`${COLORS.yellow}3. Iniciando captura do microfone...${COLORS.reset}`);
  console.log(`${COLORS.dim}   Fale algo e aguarde 0.8s de silêncio para transcrever${COLORS.reset}`);
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
    
    // Estado do VAD
    let audioBuffer: Buffer[] = [];
    let isSpeaking = false;
    let silenceStart: number | null = null;
    let speechStart: number | null = null;
    let transcriptionCount = 0;

    stream.on('data', async (chunk: Buffer) => {
      // Calcular energia
      let sum = 0;
      for (let i = 0; i < chunk.length; i += 2) {
        const sample = chunk.readInt16LE(i) / 32768;
        sum += sample * sample;
      }
      const energy = Math.sqrt(sum / (chunk.length / 2));
      const now = Date.now();

      // Mostrar barra de volume com indicador de threshold
      const bars = Math.min(50, Math.floor(energy * 500));
      const thresholdBar = Math.floor(VAD_CONFIG.ENERGY_THRESHOLD * 500);
      const volumeBar = '█'.repeat(bars) + '░'.repeat(50 - bars);
      const isSpeakingNow = energy > VAD_CONFIG.ENERGY_THRESHOLD;
      const status = isSpeakingNow
        ? `${COLORS.green}🗣️ FALANDO${COLORS.reset}`
        : `${COLORS.dim}🤫 silêncio${COLORS.reset}`;
      // Mostrar energia atual vs threshold
      process.stdout.write(`\r  [${volumeBar}] ${status} (${energy.toFixed(3)} ${isSpeakingNow ? '>' : '<'} ${VAD_CONFIG.ENERGY_THRESHOLD})    `);

      // VAD: Detectar início de fala
      if (energy > VAD_CONFIG.ENERGY_THRESHOLD) {
        if (!isSpeaking) {
          isSpeaking = true;
          speechStart = now;
          silenceStart = null;
          audioBuffer = [];
          console.log(`\n${COLORS.blue}🎤 Detectado início de fala...${COLORS.reset}`);
        }
        audioBuffer.push(chunk);
        silenceStart = null;
      } else if (isSpeaking) {
        audioBuffer.push(chunk);
        
        if (!silenceStart) {
          silenceStart = now;
        }

        // Verificar fim de fala
        const silenceDuration = now - silenceStart;
        if (silenceDuration >= VAD_CONFIG.SILENCE_DURATION_MS) {
          const speechDuration = now - (speechStart || now);
          
          if (speechDuration >= VAD_CONFIG.MIN_SPEECH_DURATION_MS) {
            console.log(`\n${COLORS.yellow}📝 Transcrevendo ${speechDuration}ms de áudio...${COLORS.reset}`);
            
            // Transcrever
            const fullAudio = Buffer.concat(audioBuffer);
            try {
              const startSTT = Date.now();
              const result = await transcriber.transcribe(fullAudio);
              const sttDuration = Date.now() - startSTT;
              
              transcriptionCount++;
              console.log(`${COLORS.green}✅ Transcrição #${transcriptionCount} (${sttDuration}ms):${COLORS.reset}`);
              console.log(`   ${COLORS.cyan}"${result.text}"${COLORS.reset}`);
              console.log(`   ${COLORS.dim}Confiança: ${((result.confidence || 0) * 100).toFixed(0)}% | Idioma: ${result.language || 'auto'}${COLORS.reset}\n`);
            } catch (error: any) {
              console.log(`${COLORS.red}❌ Erro na transcrição: ${error.message}${COLORS.reset}\n`);
            }
          } else {
            console.log(`\n${COLORS.dim}⏭️ Fala muito curta (${speechDuration}ms), ignorando${COLORS.reset}\n`);
          }

          // Reset
          isSpeaking = false;
          speechStart = null;
          silenceStart = null;
          audioBuffer = [];
        }
      }
    });

    stream.on('error', (error: Error) => {
      console.log(`\n\n${COLORS.red}❌ ERRO ao capturar áudio:${COLORS.reset}`);
      console.log(`   ${error.message}\n`);
      
      if (error.message.includes('spawn') || error.message.includes('sox')) {
        console.log(`${COLORS.yellow}Possíveis soluções:${COLORS.reset}`);
        console.log(`  1. Instale SoX: ${COLORS.cyan}brew install sox${COLORS.reset}`);
        console.log(`  2. Verifique permissões do microfone nas Configurações`);
        console.log(`  3. Tente rodar no Terminal.app ao invés do Cursor\n`);
      }
      
      process.exit(1);
    });

    // Parar com CTRL+C
    process.on('SIGINT', () => {
      console.log(`\n\n${COLORS.cyan}⏹️ Parando...${COLORS.reset}`);
      recording.stop();
      
      console.log(`\n${COLORS.green}Resumo:${COLORS.reset}`);
      console.log(`   Transcrições realizadas: ${transcriptionCount}`);
      
      if (transcriptionCount > 0) {
        console.log(`\n${COLORS.green}✅ Microfone + STT funcionando corretamente!${COLORS.reset}\n`);
      } else {
        console.log(`\n${COLORS.yellow}⚠️ Nenhuma transcrição realizada.${COLORS.reset}`);
        console.log(`   Certifique-se de falar por pelo menos 0.3s${COLORS.reset}\n`);
      }
      
      process.exit(0);
    });

    console.log(`${COLORS.green}✅ Sistema pronto! Fale algo...${COLORS.reset}\n`);

  } catch (error) {
    console.log(`${COLORS.red}❌ Erro ao iniciar:${COLORS.reset}`);
    console.log(error);
    process.exit(1);
  }
}

// Executar
testMicrophone();

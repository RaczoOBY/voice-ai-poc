#!/usr/bin/env npx tsx
/**
 * Teste isolado do ElevenLabs Scribe (STT streaming)
 * 
 * Baseado na documentação oficial:
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */

import dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';

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
║           TESTE ISOLADO - ElevenLabs Scribe                    ║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);

const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!API_KEY) {
  console.log(`${COLORS.red}❌ ELEVENLABS_API_KEY não configurada!${COLORS.reset}`);
  process.exit(1);
}

async function testScribe(): Promise<void> {
  console.log(`${COLORS.yellow}1. Conectando ao WebSocket...${COLORS.reset}`);
  
  const params = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    language_code: 'pt',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: '0.5',
    audio_format: 'pcm_16000',
    include_timestamps: 'false',
  });

  const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`;
  console.log(`${COLORS.dim}   URL: ${wsUrl}${COLORS.reset}`);
  
  const ws = new WebSocket(wsUrl, {
    headers: {
      'xi-api-key': API_KEY,
    },
  });

  ws.on('open', () => {
    console.log(`${COLORS.green}✅ Conectado!${COLORS.reset}\n`);
    console.log(`${COLORS.yellow}2. Iniciando captura do microfone...${COLORS.reset}`);
    startMicrophone(ws);
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      console.log(`\n${COLORS.blue}📥 Evento recebido:${COLORS.reset}`);
      console.log(JSON.stringify(event, null, 2));
      
      if (event.message_type === 'partialTranscript' && event.text) {
        console.log(`${COLORS.cyan}   Parcial: "${event.text}"${COLORS.reset}`);
      } else if (event.message_type === 'committedTranscript' && event.text) {
        console.log(`${COLORS.green}   ✅ Final: "${event.text}"${COLORS.reset}`);
      }
    } catch (e) {
      console.log(`${COLORS.red}   Erro ao parsear: ${data.toString()}${COLORS.reset}`);
    }
  });

  ws.on('error', (error) => {
    console.log(`${COLORS.red}❌ Erro WebSocket: ${error.message}${COLORS.reset}`);
  });

  ws.on('close', (code, reason) => {
    console.log(`\n${COLORS.yellow}🔌 Conexão fechada: ${code} - ${reason.toString()}${COLORS.reset}`);
    process.exit(0);
  });
}

function startMicrophone(ws: WebSocket): void {
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
    let chunkCount = 0;
    let bytesSent = 0;

    stream.on('data', (chunk: Buffer) => {
      chunkCount++;
      bytesSent += chunk.length;
      
      // Mostrar progresso
      if (chunkCount % 50 === 0) {
        console.log(`${COLORS.dim}   📤 ${chunkCount} chunks enviados (${(bytesSent / 1024).toFixed(1)} KB)${COLORS.reset}`);
      }

      // Enviar para o Scribe
      const message = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
        sample_rate: 16000,
        commit: false,
      });

      try {
        ws.send(message);
      } catch (e) {
        // Ignora erros de envio
      }
    });

    stream.on('error', (error: Error) => {
      console.log(`${COLORS.red}❌ Erro no microfone: ${error.message}${COLORS.reset}`);
    });

    console.log(`${COLORS.green}✅ Microfone ativo! Fale algo...${COLORS.reset}`);
    console.log(`${COLORS.dim}   Pressione CTRL+C para sair${COLORS.reset}\n`);

    process.on('SIGINT', () => {
      console.log(`\n${COLORS.yellow}⏹️ Encerrando...${COLORS.reset}`);
      
      // Enviar commit final
      ws.send(JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: '',
        sample_rate: 16000,
        commit: true,
      }));
      
      recording.stop();
      
      setTimeout(() => {
        ws.close();
      }, 1000);
    });

  } catch (error: any) {
    console.log(`${COLORS.red}❌ Erro ao iniciar microfone: ${error.message}${COLORS.reset}`);
    ws.close();
  }
}

// Executar
testScribe();

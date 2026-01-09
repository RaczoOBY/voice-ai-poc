import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';
import 'dotenv/config';

const SCRIBE_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';

async function testScribe() {
  // Usar o arquivo já convertido para PCM 16kHz pelo sox
  const audioPath = path.join(__dirname, 'recordings/2026-01-09T19-45-50-216Z_twilio-CAd057e8/user_audio_pcm16k.wav');
  
  console.log('🎤 Enviando áudio para ElevenLabs Scribe...');
  console.log(`📁 Arquivo: ${audioPath}`);
  console.log(`📊 Tamanho: ${fs.statSync(audioPath).size} bytes`);
  
  // Ler o arquivo WAV e pular o header (44 bytes)
  const wavBuffer = fs.readFileSync(audioPath);
  const pcm16k = wavBuffer.subarray(44); // Pular header WAV - já está em PCM 16kHz
  
  console.log(`📊 PCM 16kHz: ${pcm16k.length} bytes (~${(pcm16k.length / 32000).toFixed(1)}s)`);
  
  // Conectar ao Scribe com 16kHz
  const params = new URLSearchParams({
    model_id: 'scribe_v2_realtime',
    language_code: 'pt',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: '0.5',
    audio_format: 'pcm_16000', // PCM 16kHz
    include_timestamps: 'false',
  });
  
  const wsUrl = `${SCRIBE_WS_URL}?${params.toString()}`;
  
  return new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
      },
    });
    
    let transcriptions: string[] = [];
    let partials: string[] = [];
    
    ws.on('open', () => {
      console.log('✅ Conectado ao Scribe');
      
      // Enviar áudio em chunks de 3200 bytes (~100ms a 16kHz)
      const chunkSize = 3200;
      let offset = 0;
      
      const sendChunk = () => {
        if (offset >= pcm16k.length) {
          console.log('📤 Todo áudio enviado, aguardando transcrição final...');
          // Enviar EOF após um delay
          setTimeout(() => {
            console.log('📤 Enviando EOF...');
            ws.send(JSON.stringify({ type: 'eof' }));
          }, 2000);
          return;
        }
        
        const chunk = pcm16k.subarray(offset, Math.min(offset + chunkSize, pcm16k.length));
        ws.send(chunk);
        offset += chunkSize;
        
        // Simular streaming (~20ms por chunk para enviar mais rápido)
        setTimeout(sendChunk, 20);
      };
      
      sendChunk();
    });
    
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.message_type === 'session_started') {
          console.log(`📝 Sessão iniciada: ${message.session_id}`);
        } else if (message.message_type === 'partial_transcript') {
          if (message.text && message.text.trim()) {
            console.log(`🔄 Parcial: "${message.text}"`);
            partials.push(message.text);
          }
        } else if (message.message_type === 'committed_transcript') {
          console.log(`✅ FINAL: "${message.text}"`);
          transcriptions.push(message.text);
        } else if (message.message_type?.includes('error')) {
          console.error(`❌ Erro Scribe: ${JSON.stringify(message)}`);
        } else {
          console.log(`📨 Mensagem: ${message.message_type}`);
        }
      } catch (e) {
        // Ignorar mensagens não-JSON
      }
    });
    
    ws.on('close', () => {
      console.log('\n' + '='.repeat(50));
      console.log('📊 RESULTADO FINAL SCRIBE:');
      console.log(`"${transcriptions.join(' ') || partials[partials.length - 1] || '(vazio)'}"`);
      console.log('='.repeat(50));
      resolve();
    });
    
    ws.on('error', (err) => {
      console.error('❌ Erro WebSocket:', err);
      reject(err);
    });
    
    // Timeout de segurança
    setTimeout(() => {
      console.log('⏰ Timeout - fechando conexão');
      ws.close();
    }, 30000);
  });
}

testScribe().catch(console.error);

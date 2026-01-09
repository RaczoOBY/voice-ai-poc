import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

async function testWhisper() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const audioPath = path.join(__dirname, 'recordings/2026-01-09T19-45-50-216Z_twilio-CAd057e8/user_audio.wav');
  
  console.log('🎤 Enviando áudio para OpenAI Whisper...');
  console.log(`📁 Arquivo: ${audioPath}`);
  console.log(`📊 Tamanho: ${fs.statSync(audioPath).size} bytes`);
  
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-1',
    language: 'pt',
  });
  
  console.log('\n✅ Transcrição Whisper:');
  console.log(`"${transcription.text}"`);
}

testWhisper().catch(console.error);

import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

async function testScribeHTTP() {
  const audioPath = path.join(__dirname, 'recordings/2026-01-09T19-45-50-216Z_twilio-CAd057e8/user_audio_pcm16k.wav');
  
  console.log('🎤 Enviando áudio para ElevenLabs Scribe (HTTP)...');
  console.log(`📁 Arquivo: ${audioPath}`);
  console.log(`📊 Tamanho: ${fs.statSync(audioPath).size} bytes`);
  
  const formData = new FormData();
  const audioBuffer = fs.readFileSync(audioPath);
  const blob = new Blob([audioBuffer], { type: 'audio/wav' });
  formData.append('file', blob, 'audio.wav');
  formData.append('model_id', 'scribe_v1'); // Usar modelo não-streaming
  formData.append('language_code', 'pt');
  
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY!,
    },
    body: formData,
  });
  
  if (!response.ok) {
    const error = await response.text();
    console.error(`❌ Erro: ${response.status} ${error}`);
    return;
  }
  
  const result = await response.json();
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 RESULTADO SCRIBE HTTP:');
  console.log(`"${result.text || JSON.stringify(result)}"`);
  console.log('='.repeat(50));
}

testScribeHTTP().catch(console.error);

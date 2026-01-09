/**
 * Script para converter gravações de áudio μ-law para WAV
 * Permite ouvir o que foi realmente capturado pelo Twilio
 */

import * as fs from 'fs';
import * as path from 'path';

// Tabela de conversão μ-law → PCM linear
const MULAW_TO_LINEAR: number[] = (() => {
  const table: number[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    const mulaw = ~i;
    const sign = mulaw & 0x80;
    const exponent = (mulaw >> 4) & 0x07;
    const mantissa = mulaw & 0x0F;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = sign !== 0 ? -sample : sample;
  }
  return table;
})();

function convertMulawToWav(mulawPath: string, outputPath: string): void {
  const mulawBuffer = fs.readFileSync(mulawPath);
  
  // Converter μ-law para PCM 16-bit (mantendo 8kHz)
  const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);
  
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = MULAW_TO_LINEAR[mulawBuffer[i]];
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  
  // Criar header WAV
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;
  
  const wavHeader = Buffer.alloc(44);
  
  // RIFF header
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(fileSize, 4);
  wavHeader.write('WAVE', 8);
  
  // fmt chunk
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16); // chunk size
  wavHeader.writeUInt16LE(1, 20); // PCM format
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(sampleRate * numChannels * bitsPerSample / 8, 28); // byte rate
  wavHeader.writeUInt16LE(numChannels * bitsPerSample / 8, 32); // block align
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  
  // data chunk
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(dataSize, 40);
  
  // Combinar header e dados
  const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
  fs.writeFileSync(outputPath, wavBuffer);
  
  const durationSec = mulawBuffer.length / 8000;
  console.log(`✅ Convertido: ${outputPath}`);
  console.log(`   Duração: ${durationSec.toFixed(2)}s`);
  console.log(`   Tamanho: ${(wavBuffer.length / 1024).toFixed(2)}KB`);
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  // Listar gravações disponíveis
  const recordingsDir = path.join(__dirname, '../../recordings');
  const recordings = fs.readdirSync(recordingsDir)
    .filter(f => f.includes('twilio'))
    .sort()
    .reverse()
    .slice(0, 10);
  
  console.log('📁 Gravações Twilio recentes:');
  recordings.forEach((r, i) => {
    console.log(`   ${i + 1}. ${r}`);
  });
  console.log('\nUso: npx tsx src/scripts/convert-recording.ts <nome-pasta>');
  console.log('Ex:  npx tsx src/scripts/convert-recording.ts 2026-01-09T20-00-48-730Z_twilio-CAd8cd1e');
  process.exit(0);
}

const recordingName = args[0];
const recordingDir = path.join(__dirname, '../../recordings', recordingName);

if (!fs.existsSync(recordingDir)) {
  console.error(`❌ Gravação não encontrada: ${recordingDir}`);
  process.exit(1);
}

// Converter user_audio.raw para WAV
const userAudioPath = path.join(recordingDir, 'user_audio.raw');
const userWavPath = path.join(recordingDir, 'user_audio_converted.wav');

if (fs.existsSync(userAudioPath)) {
  console.log('\n🎤 Convertendo áudio do usuário (o que o Scribe recebeu)...');
  convertMulawToWav(userAudioPath, userWavPath);
} else {
  console.log('⚠️  user_audio.raw não encontrado');
}

// Converter agent_audio.raw para WAV
const agentAudioPath = path.join(recordingDir, 'agent_audio.raw');
const agentWavPath = path.join(recordingDir, 'agent_audio_converted.wav');

if (fs.existsSync(agentAudioPath)) {
  console.log('\n🤖 Convertendo áudio do agente...');
  convertMulawToWav(agentAudioPath, agentWavPath);
} else {
  console.log('⚠️  agent_audio.raw não encontrado');
}

console.log('\n🎧 Abra os arquivos .wav para ouvir o que foi capturado!');

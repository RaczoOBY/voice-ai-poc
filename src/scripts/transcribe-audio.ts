/**
 * Script para transcrever arquivo de áudio usando OpenAI Whisper
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';

config();

const AUDIO_FILE = process.argv[2] || 'audio_IMG_1462.m4a';

async function transcribeAudio() {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const audioPath = path.resolve(process.cwd(), AUDIO_FILE);
  
  if (!fs.existsSync(audioPath)) {
    console.error(`❌ Arquivo não encontrado: ${audioPath}`);
    process.exit(1);
  }
  
  const stats = fs.statSync(audioPath);
  console.log(`📁 Arquivo: ${AUDIO_FILE}`);
  console.log(`📊 Tamanho: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`\n🎤 Iniciando transcrição com OpenAI Whisper...\n`);
  
  const startTime = Date.now();
  
  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      language: 'pt',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });
    
    const duration = Date.now() - startTime;
    
    console.log(`✅ Transcrição concluída em ${(duration / 1000).toFixed(2)}s\n`);
    console.log('═'.repeat(80));
    console.log('📝 TRANSCRIÇÃO COMPLETA:');
    console.log('═'.repeat(80));
    console.log(response.text);
    console.log('═'.repeat(80));
    
    // Salvar transcrição em arquivo
    const outputDir = path.dirname(audioPath);
    const baseName = path.basename(audioPath, path.extname(audioPath));
    
    // Salvar texto simples
    const txtPath = path.join(outputDir, `${baseName}_transcricao.txt`);
    fs.writeFileSync(txtPath, response.text);
    console.log(`\n💾 Transcrição salva em: ${txtPath}`);
    
    // Salvar JSON completo com segmentos
    const jsonPath = path.join(outputDir, `${baseName}_transcricao.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(response, null, 2));
    console.log(`💾 JSON completo salvo em: ${jsonPath}`);
    
    // Mostrar segmentos se disponíveis
    if (response.segments && response.segments.length > 0) {
      console.log(`\n📋 Segmentos (${response.segments.length} total):`);
      console.log('-'.repeat(80));
      
      for (const seg of response.segments) {
        const start = formatTime(seg.start);
        const end = formatTime(seg.end);
        console.log(`[${start} → ${end}] ${seg.text.trim()}`);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Erro na transcrição:', error.message);
    if (error.response) {
      console.error('Detalhes:', error.response.data);
    }
    process.exit(1);
  }
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

transcribeAudio();

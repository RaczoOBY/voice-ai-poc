#!/usr/bin/env npx tsx
/**
 * Benchmark de latência do pipeline Voice AI
 * 
 * Testa cada componente individualmente e o pipeline completo
 * para medir latências e identificar gargalos.
 * 
 * Uso: npm run test:latency
 */

import { config, validateConfig } from '../config';
import { OpenAITranscriber } from '../providers/OpenAITranscriber';
import { OpenAILLM } from '../providers/OpenAILLM';
import { ElevenLabsTTS } from '../providers/ElevenLabsTTS';
import { Logger } from '../utils/Logger';
import { readFile } from 'fs/promises';
import { join } from 'path';

const logger = new Logger('LatencyBenchmark');

interface BenchmarkResult {
  component: string;
  iterations: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
}

// Texto de teste para o benchmark
const TEST_TEXTS = [
  'Olá, tudo bem?',
  'Entendi, deixa eu verificar isso para você.',
  'Perfeito, nossa solução pode te ajudar a automatizar o atendimento via WhatsApp.',
  'Você gostaria de agendar uma demonstração gratuita para conhecer melhor o produto?',
];

// Mensagens de teste para o LLM
const TEST_MESSAGES = [
  { role: 'system' as const, content: 'Você é um assistente de vendas.' },
  { role: 'user' as const, content: 'Olá, quero saber mais sobre o produto.' },
];

async function measureLatency(fn: () => Promise<void>, iterations: number): Promise<number[]> {
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await fn();
    results.push(Date.now() - start);
  }
  
  return results;
}

function calculateStats(results: number[]): Omit<BenchmarkResult, 'component' | 'iterations'> {
  const sorted = [...results].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  
  return {
    avgMs: Math.round(sum / sorted.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
  };
}

async function benchmarkTTS(tts: ElevenLabsTTS, iterations: number): Promise<BenchmarkResult> {
  logger.info(`🔊 Testando TTS (${iterations} iterações)...`);
  
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const text = TEST_TEXTS[i % TEST_TEXTS.length];
    const start = Date.now();
    await tts.synthesize(text);
    results.push(Date.now() - start);
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    component: 'TTS (ElevenLabs)',
    iterations,
    ...calculateStats(results),
  };
}

async function benchmarkLLM(llm: OpenAILLM, iterations: number): Promise<BenchmarkResult> {
  logger.info(`🤖 Testando LLM (${iterations} iterações)...`);
  
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await llm.generate(TEST_MESSAGES, { maxTokens: 100 });
    results.push(Date.now() - start);
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    component: 'LLM (GPT-4o)',
    iterations,
    ...calculateStats(results),
  };
}

async function benchmarkSTT(transcriber: OpenAITranscriber, iterations: number): Promise<BenchmarkResult> {
  logger.info(`🎤 Testando STT (${iterations} iterações)...`);
  
  // Gerar um buffer de áudio simulado (silêncio de 1 segundo)
  // Em produção, usar um arquivo de áudio real
  const sampleRate = 16000;
  const duration = 1; // 1 segundo
  const audioBuffer = Buffer.alloc(sampleRate * 2 * duration); // 16-bit mono
  
  // Converter para WAV
  const wavBuffer = transcriber.convertPcmToWav(audioBuffer, sampleRate, 1, 16);
  
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      await transcriber.transcribe(wavBuffer);
    } catch {
      // Silêncio pode falhar na transcrição, mas queremos medir a latência
    }
    results.push(Date.now() - start);
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    component: 'STT (Whisper)',
    iterations,
    ...calculateStats(results),
  };
}

function printResults(results: BenchmarkResult[]): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                         RESULTADOS DO BENCHMARK                              ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Componente          │ Iterações │  Avg (ms) │  Min (ms) │  Max (ms) │ P95 (ms)║');
  console.log('╠═════════════════════╪═══════════╪═══════════╪═══════════╪═══════════╪═════════╣');
  
  for (const result of results) {
    const name = result.component.padEnd(19);
    const iter = result.iterations.toString().padStart(9);
    const avg = result.avgMs.toString().padStart(9);
    const min = result.minMs.toString().padStart(9);
    const max = result.maxMs.toString().padStart(9);
    const p95 = result.p95Ms.toString().padStart(7);
    console.log(`║ ${name} │${iter} │${avg} │${min} │${max} │${p95}  ║`);
  }
  
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝');
  
  // Análise
  console.log('');
  console.log('📊 ANÁLISE:');
  
  const totalAvg = results.reduce((sum, r) => sum + r.avgMs, 0);
  console.log(`   Total estimado (sequencial): ${totalAvg}ms`);
  
  const thresholds = config.metrics.alertThresholds;
  console.log('');
  console.log('   Comparação com thresholds:');
  
  for (const result of results) {
    let threshold: number;
    let thresholdName: string;
    
    if (result.component.includes('STT')) {
      threshold = thresholds.stt;
      thresholdName = 'stt';
    } else if (result.component.includes('LLM')) {
      threshold = thresholds.llm;
      thresholdName = 'llm';
    } else {
      threshold = thresholds.tts;
      thresholdName = 'tts';
    }
    
    const status = result.avgMs <= threshold ? '✅' : '⚠️';
    console.log(`   ${status} ${result.component}: ${result.avgMs}ms (threshold: ${threshold}ms)`);
  }
  
  // Gargalo
  const maxResult = results.reduce((max, r) => r.avgMs > max.avgMs ? r : max);
  console.log('');
  console.log(`   🎯 Gargalo identificado: ${maxResult.component}`);
  
  // Recomendações
  console.log('');
  console.log('💡 RECOMENDAÇÕES:');
  
  if (maxResult.component.includes('LLM')) {
    console.log('   • Considere usar GPT-4o-mini para menor latência');
    console.log('   • Use streaming para começar TTS antes do LLM terminar');
  } else if (maxResult.component.includes('STT')) {
    console.log('   • Considere usar Deepgram Nova-3 para menor latência');
    console.log('   • Use a OpenAI Realtime API para streaming');
  } else if (maxResult.component.includes('TTS')) {
    console.log('   • O modelo eleven_flash_v2_5 já é otimizado para latência');
    console.log('   • Considere usar Cartesia Sonic para latência ainda menor');
  }
}

async function main() {
  logger.info('🚀 Iniciando benchmark de latência...');
  logger.info('');
  
  try {
    // Validar configuração
    validateConfig();
    logger.info('✅ Configuração validada');
    logger.info('');

    // Inicializar providers
    const tts = new ElevenLabsTTS(config.elevenlabs);
    const llm = new OpenAILLM(config.openai);
    const transcriber = new OpenAITranscriber(config.openai);
    
    // Warmup
    logger.info('🔥 Aquecendo conexões...');
    await tts.warmup();
    await llm.generate([{ role: 'user', content: 'oi' }], { maxTokens: 5 });
    logger.info('✅ Conexões aquecidas');
    logger.info('');

    // Número de iterações
    const iterations = parseInt(process.env.BENCHMARK_ITERATIONS || '5');
    logger.info(`📝 Executando ${iterations} iterações por componente`);
    logger.info('');

    // Executar benchmarks
    const results: BenchmarkResult[] = [];
    
    results.push(await benchmarkTTS(tts, iterations));
    results.push(await benchmarkLLM(llm, iterations));
    results.push(await benchmarkSTT(transcriber, iterations));
    
    // Exibir resultados
    printResults(results);
    
    logger.info('');
    logger.info('🎉 Benchmark concluído!');

  } catch (error) {
    logger.error('❌ Erro durante benchmark:', error);
    process.exit(1);
  }
}

main();

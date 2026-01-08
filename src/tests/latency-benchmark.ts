#!/usr/bin/env npx tsx
/**
 * Benchmark de latência do pipeline Voice AI
 * 
 * Testa cada componente individualmente e o pipeline completo
 * para medir latências e identificar gargalos.
 * 
 * Uso: npm run test:latency
 * 
 * Variáveis de ambiente:
 *   BENCHMARK_ITERATIONS=10  - Número de iterações por teste
 *   BENCHMARK_SKIP_STT=1     - Pular testes de STT
 *   BENCHMARK_SKIP_LLM=1     - Pular testes de LLM
 *   BENCHMARK_SKIP_TTS=1     - Pular testes de TTS
 *   BENCHMARK_SKIP_PIPELINE=1 - Pular teste de pipeline completo
 */

import { config, validateConfig } from '../config';
import { OpenAITranscriber } from '../providers/OpenAITranscriber';
import { OpenAILLM } from '../providers/OpenAILLM';
import { ElevenLabsTTS } from '../providers/ElevenLabsTTS';
import { ElevenLabsScribe } from '../providers/ElevenLabsScribe';
import { Logger } from '../utils/Logger';

const logger = new Logger('LatencyBenchmark');

interface BenchmarkResult {
  component: string;
  iterations: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  p50Ms: number;
}

interface PipelineResult {
  sttMs: number;
  llmMs: number;
  ttsMs: number;
  ttfaMs: number; // Time to First Audio
  totalMs: number;
}

// Texto de teste para o benchmark
const TEST_TEXTS = [
  'Olá, tudo bem?',
  'Entendi, deixa eu verificar isso para você.',
  'Perfeito, nossa solução pode te ajudar a automatizar o atendimento via WhatsApp.',
  'Você gostaria de agendar uma demonstração gratuita para conhecer melhor o produto?',
];

// Mensagens de teste para o LLM (prompt reduzido para benchmark)
const TEST_MESSAGES_SIMPLE = [
  { role: 'system' as const, content: 'Você é um assistente de vendas conciso. Responda em 1-2 frases.' },
  { role: 'user' as const, content: 'Olá, quero saber mais sobre o produto.' },
];

// Mensagens com contexto maior (similar ao uso real)
const TEST_MESSAGES_FULL = [
  { role: 'system' as const, content: config.agent.systemPrompt.substring(0, 2000) }, // Primeiros 2000 chars
  { role: 'user' as const, content: 'Oi, aqui é o João.' },
  { role: 'assistant' as const, content: 'Oi João! Que bom falar com você. Vi que você se cadastrou... como posso te ajudar?' },
  { role: 'user' as const, content: 'Quero saber mais sobre a ferramenta de automação.' },
];

function calculateStats(results: number[]): Omit<BenchmarkResult, 'component' | 'iterations'> {
  const sorted = [...results].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  
  return {
    avgMs: Math.round(sum / sorted.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
  };
}

// ============================================================================
// BENCHMARK: TTS (ElevenLabs)
// ============================================================================

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

async function benchmarkTTSStream(tts: ElevenLabsTTS, iterations: number): Promise<BenchmarkResult> {
  logger.info(`🔊 Testando TTS Stream TTFB (${iterations} iterações)...`);
  
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const text = TEST_TEXTS[i % TEST_TEXTS.length];
    const start = Date.now();
    let ttfb = 0;
    
    await tts.synthesizeStream(text, (chunk) => {
      if (ttfb === 0) {
        ttfb = Date.now() - start;
      }
    });
    
    results.push(ttfb);
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    component: 'TTS Stream TTFB',
    iterations,
    ...calculateStats(results),
  };
}

// ============================================================================
// BENCHMARK: LLM (OpenAI)
// ============================================================================

async function benchmarkLLM(
  llm: OpenAILLM, 
  iterations: number, 
  useFullContext: boolean = false
): Promise<BenchmarkResult> {
  const contextType = useFullContext ? 'contexto completo' : 'contexto simples';
  logger.info(`🤖 Testando LLM - ${contextType} (${iterations} iterações)...`);
  
  const messages = useFullContext ? TEST_MESSAGES_FULL : TEST_MESSAGES_SIMPLE;
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await llm.generate(messages, { maxTokens: 80 });
    results.push(Date.now() - start);
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    component: useFullContext ? 'LLM (full ctx)' : 'LLM (simple)',
    iterations,
    ...calculateStats(results),
  };
}

// ============================================================================
// BENCHMARK: STT (Whisper - Batch)
// ============================================================================

async function benchmarkSTTWhisper(transcriber: OpenAITranscriber, iterations: number): Promise<BenchmarkResult> {
  logger.info(`🎤 Testando STT Whisper (${iterations} iterações)...`);
  
  // Gerar um buffer de áudio simulado (silêncio de 1 segundo)
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

// ============================================================================
// BENCHMARK: STT (ElevenLabs Scribe - Streaming)
// ============================================================================

async function benchmarkSTTScribe(iterations: number): Promise<BenchmarkResult> {
  logger.info(`🎤 Testando STT Scribe (${iterations} iterações)...`);
  
  const scribe = new ElevenLabsScribe({
    apiKey: config.elevenlabs.apiKey,
    language: 'pt',
    vadSilenceThresholdMs: 300, // VAD rápido para benchmark
  });
  
  await scribe.warmup();
  
  // Gerar um buffer de áudio simulado (100ms de "fala" + silêncio)
  const sampleRate = 16000;
  const audioBuffer = Buffer.alloc(sampleRate * 2 * 2); // 2 segundos
  // Adicionar algum ruído para simular fala
  for (let i = 0; i < sampleRate * 2; i += 2) {
    const value = Math.floor(Math.random() * 1000 - 500);
    audioBuffer.writeInt16LE(value, i);
  }
  
  const results: number[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    
    try {
      const result = await scribe.transcribe(audioBuffer);
      results.push(result.duration || Date.now() - start);
    } catch {
      results.push(Date.now() - start);
    }
    process.stdout.write('.');
  }
  console.log('');
  
  await scribe.disconnect();
  
  return {
    component: 'STT (Scribe)',
    iterations,
    ...calculateStats(results),
  };
}

// ============================================================================
// BENCHMARK: Pipeline Completo (STT -> LLM -> TTS)
// ============================================================================

async function benchmarkPipeline(
  llm: OpenAILLM,
  tts: ElevenLabsTTS,
  iterations: number
): Promise<{ result: BenchmarkResult; details: PipelineResult[] }> {
  logger.info(`🔄 Testando Pipeline Completo (${iterations} iterações)...`);
  
  const results: number[] = [];
  const details: PipelineResult[] = [];
  
  // Simular transcrição já feita (foco em LLM + TTS)
  const userText = 'Quero saber mais sobre a ferramenta de automação de WhatsApp.';
  
  for (let i = 0; i < iterations; i++) {
    const pipelineStart = Date.now();
    
    // Fase 1: STT (simulado - assumir 300ms típico do Scribe)
    const sttMs = 300;
    
    // Fase 2: LLM
    const llmStart = Date.now();
    const messages = [
      ...TEST_MESSAGES_SIMPLE,
      { role: 'user' as const, content: userText },
    ];
    const llmResponse = await llm.generate(messages, { maxTokens: 80 });
    const llmMs = Date.now() - llmStart;
    
    // Fase 3: TTS (medir TTFB)
    const ttsStart = Date.now();
    let ttfb = 0;
    
    await tts.synthesizeStream(llmResponse.text, (chunk) => {
      if (ttfb === 0) {
        ttfb = Date.now() - ttsStart;
      }
    });
    
    const ttsMs = ttfb;
    const ttfaMs = sttMs + llmMs + ttsMs; // Time to First Audio
    const totalMs = Date.now() - pipelineStart + sttMs;
    
    results.push(ttfaMs);
    details.push({ sttMs, llmMs, ttsMs, ttfaMs, totalMs });
    
    process.stdout.write('.');
  }
  console.log('');
  
  return {
    result: {
      component: 'Pipeline (TTFA)',
      iterations,
      ...calculateStats(results),
    },
    details,
  };
}

// ============================================================================
// RELATÓRIO
// ============================================================================

function printResults(results: BenchmarkResult[], pipelineDetails?: PipelineResult[]): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                           RESULTADOS DO BENCHMARK                                    ║');
  console.log('╠══════════════════════════════════════════════════════════════════════════════════════╣');
  console.log('║ Componente          │ Iter │  Avg (ms) │  Min │  P50 │  P95 │  Max │ Status         ║');
  console.log('╠═════════════════════╪══════╪═══════════╪══════╪══════╪══════╪══════╪════════════════╣');
  
  const thresholds: Record<string, number> = {
    'STT': 300,
    'LLM': 1000,
    'TTS': 200,
    'Pipeline': 1500,
  };
  
  for (const result of results) {
    const name = result.component.padEnd(19);
    const iter = result.iterations.toString().padStart(4);
    const avg = result.avgMs.toString().padStart(9);
    const min = result.minMs.toString().padStart(4);
    const p50 = result.p50Ms.toString().padStart(4);
    const p95 = result.p95Ms.toString().padStart(4);
    const max = result.maxMs.toString().padStart(4);
    
    // Determinar threshold
    let threshold = 1000;
    for (const [key, value] of Object.entries(thresholds)) {
      if (result.component.includes(key)) {
        threshold = value;
        break;
      }
    }
    
    const status = result.avgMs <= threshold 
      ? '✅ OK'.padEnd(14) 
      : `⚠️ +${Math.round((result.avgMs - threshold) / threshold * 100)}%`.padEnd(14);
    
    console.log(`║ ${name} │${iter} │${avg} │${min} │${p50} │${p95} │${max} │ ${status} ║`);
  }
  
  console.log('╚══════════════════════════════════════════════════════════════════════════════════════╝');
  
  // Pipeline breakdown
  if (pipelineDetails && pipelineDetails.length > 0) {
    console.log('');
    console.log('📊 BREAKDOWN DO PIPELINE (médias):');
    
    const avgStt = Math.round(pipelineDetails.reduce((s, d) => s + d.sttMs, 0) / pipelineDetails.length);
    const avgLlm = Math.round(pipelineDetails.reduce((s, d) => s + d.llmMs, 0) / pipelineDetails.length);
    const avgTts = Math.round(pipelineDetails.reduce((s, d) => s + d.ttsMs, 0) / pipelineDetails.length);
    const avgTtfa = Math.round(pipelineDetails.reduce((s, d) => s + d.ttfaMs, 0) / pipelineDetails.length);
    
    console.log(`   STT:  ${avgStt}ms (${Math.round(avgStt / avgTtfa * 100)}%)`);
    console.log(`   LLM:  ${avgLlm}ms (${Math.round(avgLlm / avgTtfa * 100)}%)`);
    console.log(`   TTS:  ${avgTts}ms (${Math.round(avgTts / avgTtfa * 100)}%)`);
    console.log(`   ────────────────`);
    console.log(`   TTFA: ${avgTtfa}ms (target: 1500ms)`);
    
    // Gráfico de barras simples
    console.log('');
    console.log('   Contribuição por componente:');
    const total = avgStt + avgLlm + avgTts;
    const barWidth = 40;
    const sttBar = Math.round(avgStt / total * barWidth);
    const llmBar = Math.round(avgLlm / total * barWidth);
    const ttsBar = barWidth - sttBar - llmBar;
    
    console.log(`   [${'█'.repeat(sttBar)}${'▓'.repeat(llmBar)}${'░'.repeat(ttsBar)}]`);
    console.log(`    STT${'─'.repeat(sttBar - 3)} LLM${'─'.repeat(llmBar - 3)} TTS`);
  }
  
  // Análise
  console.log('');
  console.log('🎯 ANÁLISE:');
  
  // Gargalo
  const componentResults = results.filter(r => !r.component.includes('Pipeline') && !r.component.includes('TTFB'));
  if (componentResults.length > 0) {
    const maxResult = componentResults.reduce((max, r) => r.avgMs > max.avgMs ? r : max);
    console.log(`   Maior gargalo: ${maxResult.component} (${maxResult.avgMs}ms)`);
  }
  
  // Recomendações
  console.log('');
  console.log('💡 RECOMENDAÇÕES:');
  
  for (const result of results) {
    if (result.component.includes('LLM') && result.avgMs > 1000) {
      console.log('   • LLM: Considere usar GPT-4o-mini ou reduzir contexto');
    }
    if (result.component.includes('TTS') && !result.component.includes('TTFB') && result.avgMs > 400) {
      console.log('   • TTS: ElevenLabs Flash v2.5 já é otimizado para latência');
    }
    if (result.component.includes('Whisper') && result.avgMs > 500) {
      console.log('   • STT: Use ElevenLabs Scribe para streaming (já configurado)');
    }
    if (result.component.includes('Pipeline') && result.avgMs > 1500) {
      console.log('   • Pipeline: Implemente LLM→TTS streaming para reduzir TTFA');
    }
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           VOICE AI - BENCHMARK DE LATÊNCIA                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  
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
    let pipelineDetails: PipelineResult[] | undefined;
    
    // TTS
    if (!process.env.BENCHMARK_SKIP_TTS) {
      results.push(await benchmarkTTS(tts, iterations));
      results.push(await benchmarkTTSStream(tts, iterations));
    }
    
    // LLM
    if (!process.env.BENCHMARK_SKIP_LLM) {
      results.push(await benchmarkLLM(llm, iterations, false)); // Contexto simples
      results.push(await benchmarkLLM(llm, iterations, true));  // Contexto completo
    }
    
    // STT
    if (!process.env.BENCHMARK_SKIP_STT) {
      results.push(await benchmarkSTTWhisper(transcriber, iterations));
      try {
        results.push(await benchmarkSTTScribe(iterations));
      } catch (error) {
        logger.warn('⚠️ Scribe benchmark falhou:', error);
      }
    }
    
    // Pipeline completo
    if (!process.env.BENCHMARK_SKIP_PIPELINE) {
      const pipeline = await benchmarkPipeline(llm, tts, iterations);
      results.push(pipeline.result);
      pipelineDetails = pipeline.details;
    }
    
    // Exibir resultados
    printResults(results, pipelineDetails);
    
    logger.info('');
    logger.info('🎉 Benchmark concluído!');

  } catch (error) {
    logger.error('❌ Erro durante benchmark:', error);
    process.exit(1);
  }
}

main();

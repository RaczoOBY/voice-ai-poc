/**
 * MetricsCollector - Coletor de métricas de latência
 * 
 * Responsável por:
 * - Rastrear tempo de cada etapa do pipeline
 * - Calcular métricas agregadas
 * - Exportar dados para análise
 * - Alertar quando latências excedem thresholds
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import {
  IMetricsCollector,
  MetricEvent,
  TurnMetrics,
  CallMetrics,
  LatencyBreakdown,
} from '../types';
import { config } from '../config';
import { Logger } from '../utils/Logger';
import { v4 as uuidv4 } from 'uuid';

interface TurnData {
  turnId: string;
  events: MetricEvent[];
  startTime: number;
}

interface CallData {
  callId: string;
  turns: Map<string, TurnData>;
  allMetrics: TurnMetrics[];
  startTime: number;
}

export class MetricsCollector implements IMetricsCollector {
  private logger: Logger;
  private calls: Map<string, CallData> = new Map();
  private thresholds = config.metrics.alertThresholds;

  constructor() {
    this.logger = new Logger('Metrics');
  }

  /**
   * Inicia o tracking de um novo turno de conversa
   */
  startTurn(callId: string): string {
    const turnId = uuidv4().substring(0, 8);
    const now = Date.now();

    let callData = this.calls.get(callId);
    if (!callData) {
      callData = {
        callId,
        turns: new Map(),
        allMetrics: [],
        startTime: now,
      };
      this.calls.set(callId, callData);
    }

    callData.turns.set(turnId, {
      turnId,
      events: [],
      startTime: now,
    });

    this.logger.debug(`📊 Turn ${turnId} started for call ${callId}`);
    return turnId;
  }

  /**
   * Registra um evento de métrica
   */
  recordEvent(event: MetricEvent): void {
    const callData = this.calls.get(event.callId);
    if (!callData) {
      this.logger.warn(`Call ${event.callId} not found for event ${event.stage}`);
      return;
    }

    const turnData = callData.turns.get(event.turnId);
    if (!turnData) {
      this.logger.warn(`Turn ${event.turnId} not found for event ${event.stage}`);
      return;
    }

    turnData.events.push(event);
    this.logger.debug(`📊 Event: ${event.stage} at ${event.timestamp}`);
  }

  /**
   * Finaliza um turno e calcula as métricas
   */
  endTurn(callId: string, turnId: string): TurnMetrics {
    const callData = this.calls.get(callId);
    if (!callData) {
      throw new Error(`Call ${callId} not found`);
    }

    const turnData = callData.turns.get(turnId);
    if (!turnData) {
      throw new Error(`Turn ${turnId} not found`);
    }

    const latency = this.calculateLatency(turnData.events);
    
    // Verificar thresholds e alertar
    this.checkThresholds(latency, turnId);

    const metrics: TurnMetrics = {
      turnId,
      timestamp: new Date(),
      latency,
      audioInputDuration: 0, // Será preenchido pelo VoiceAgent
      audioOutputDuration: 0,
      fillerUsed: false,
    };

    callData.allMetrics.push(metrics);
    callData.turns.delete(turnId);

    return metrics;
  }

  /**
   * Calcula latências a partir dos eventos
   */
  private calculateLatency(events: MetricEvent[]): LatencyBreakdown {
    const getTimestamp = (stage: MetricEvent['stage']): number | undefined => {
      return events.find((e) => e.stage === stage)?.timestamp;
    };

    const sttStart = getTimestamp('stt_start');
    const sttEnd = getTimestamp('stt_end');
    const llmStart = getTimestamp('llm_start');
    const llmEnd = getTimestamp('llm_end');
    const ttsStart = getTimestamp('tts_start');
    const ttsFirstByte = getTimestamp('tts_first_byte');
    const ttsEnd = getTimestamp('tts_end');

    const stt = sttEnd && sttStart ? sttEnd - sttStart : 0;
    const llm = llmEnd && llmStart ? llmEnd - llmStart : 0;
    const tts = ttsEnd && ttsStart ? ttsEnd - ttsStart : 0;
    const total = ttsEnd && sttStart ? ttsEnd - sttStart : 0;
    const timeToFirstAudio = ttsFirstByte && sttStart ? ttsFirstByte - sttStart : total;

    return { stt, llm, tts, total, timeToFirstAudio };
  }

  /**
   * Verifica se latências excedem thresholds e emite alertas
   */
  private checkThresholds(latency: LatencyBreakdown, turnId: string): void {
    const alerts: string[] = [];

    if (latency.stt > this.thresholds.stt) {
      alerts.push(`STT ${latency.stt}ms > ${this.thresholds.stt}ms`);
    }
    if (latency.llm > this.thresholds.llm) {
      alerts.push(`LLM ${latency.llm}ms > ${this.thresholds.llm}ms`);
    }
    if (latency.tts > this.thresholds.tts) {
      alerts.push(`TTS ${latency.tts}ms > ${this.thresholds.tts}ms`);
    }
    if (latency.total > this.thresholds.total) {
      alerts.push(`Total ${latency.total}ms > ${this.thresholds.total}ms`);
    }

    if (alerts.length > 0) {
      this.logger.warn(`⚠️ Turn ${turnId} latency alerts: ${alerts.join(', ')}`);
    }
  }

  /**
   * Retorna métricas agregadas de uma chamada
   */
  getCallMetrics(callId: string): CallMetrics {
    const callData = this.calls.get(callId);
    if (!callData) {
      throw new Error(`Call ${callId} not found`);
    }

    const turns = callData.allMetrics;
    if (turns.length === 0) {
      return {
        totalDuration: Date.now() - callData.startTime,
        turns: [],
        averageLatency: { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 },
        peakLatency: { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 },
        fillersUsed: 0,
        transcriptionErrors: 0,
      };
    }

    // Calcular médias
    const sum = turns.reduce(
      (acc, t) => ({
        stt: acc.stt + t.latency.stt,
        llm: acc.llm + t.latency.llm,
        tts: acc.tts + t.latency.tts,
        total: acc.total + t.latency.total,
        timeToFirstAudio: acc.timeToFirstAudio + t.latency.timeToFirstAudio,
      }),
      { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 }
    );

    const averageLatency: LatencyBreakdown = {
      stt: Math.round(sum.stt / turns.length),
      llm: Math.round(sum.llm / turns.length),
      tts: Math.round(sum.tts / turns.length),
      total: Math.round(sum.total / turns.length),
      timeToFirstAudio: Math.round(sum.timeToFirstAudio / turns.length),
    };

    // Calcular picos
    const peakLatency = turns.reduce(
      (peak, t) => ({
        stt: Math.max(peak.stt, t.latency.stt),
        llm: Math.max(peak.llm, t.latency.llm),
        tts: Math.max(peak.tts, t.latency.tts),
        total: Math.max(peak.total, t.latency.total),
        timeToFirstAudio: Math.max(peak.timeToFirstAudio, t.latency.timeToFirstAudio),
      }),
      { stt: 0, llm: 0, tts: 0, total: 0, timeToFirstAudio: 0 }
    );

    return {
      totalDuration: Date.now() - callData.startTime,
      turns,
      averageLatency,
      peakLatency,
      fillersUsed: turns.filter((t) => t.fillerUsed).length,
      transcriptionErrors: 0, // Contado externamente
    };
  }

  /**
   * Exporta métricas para arquivo JSON
   */
  async exportMetrics(callId: string): Promise<void> {
    if (!config.metrics.saveDetailedMetrics) {
      return;
    }

    const callData = this.calls.get(callId);
    if (!callData) {
      this.logger.warn(`Call ${callId} not found for export`);
      return;
    }

    const metrics = this.getCallMetrics(callId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `call-${callId}-${timestamp}.json`;
    const filepath = join(config.metrics.metricsPath, filename);

    // Garantir que o diretório existe
    await mkdir(config.metrics.metricsPath, { recursive: true });

    const exportData = {
      callId,
      exportedAt: new Date().toISOString(),
      summary: {
        totalDuration: metrics.totalDuration,
        totalTurns: metrics.turns.length,
        fillersUsed: metrics.fillersUsed,
        averageLatency: metrics.averageLatency,
        peakLatency: metrics.peakLatency,
      },
      turns: metrics.turns.map((t) => ({
        turnId: t.turnId,
        timestamp: t.timestamp,
        latency: t.latency,
        fillerUsed: t.fillerUsed,
        fillerText: t.fillerText,
      })),
      thresholds: this.thresholds,
      analysis: this.analyzePerformance(metrics),
    };

    await writeFile(filepath, JSON.stringify(exportData, null, 2));
    this.logger.info(`📁 Metrics exported to ${filepath}`);
  }

  /**
   * Analisa performance e gera insights
   */
  private analyzePerformance(metrics: CallMetrics): {
    rating: 'excellent' | 'good' | 'acceptable' | 'poor';
    bottleneck: 'stt' | 'llm' | 'tts' | 'none';
    recommendations: string[];
  } {
    const avg = metrics.averageLatency;
    const recommendations: string[] = [];

    // Identificar gargalo
    let bottleneck: 'stt' | 'llm' | 'tts' | 'none' = 'none';
    const maxComponent = Math.max(avg.stt, avg.llm, avg.tts);
    
    if (maxComponent === avg.stt && avg.stt > this.thresholds.stt) {
      bottleneck = 'stt';
      recommendations.push('Considere usar Deepgram Nova-3 para menor latência de STT');
    } else if (maxComponent === avg.llm && avg.llm > this.thresholds.llm) {
      bottleneck = 'llm';
      recommendations.push('Considere usar GPT-4o-mini ou OpenAI Realtime API');
      recommendations.push('Reduza o tamanho do contexto/histórico');
    } else if (maxComponent === avg.tts && avg.tts > this.thresholds.tts) {
      bottleneck = 'tts';
      recommendations.push('Verifique a conexão com ElevenLabs ou reduza o texto');
    }

    // Calcular rating
    let rating: 'excellent' | 'good' | 'acceptable' | 'poor';
    if (avg.total < 800) {
      rating = 'excellent';
    } else if (avg.total < 1200) {
      rating = 'good';
    } else if (avg.total < 1500) {
      rating = 'acceptable';
    } else {
      rating = 'poor';
      recommendations.push('Latência total muito alta - considere fillers mais longos');
    }

    // Analisar uso de fillers
    const fillerRate = metrics.fillersUsed / Math.max(metrics.turns.length, 1);
    if (fillerRate < 0.3 && avg.total > 1000) {
      recommendations.push('Aumente o uso de fillers para mascarar latência');
    }

    return { rating, bottleneck, recommendations };
  }

  /**
   * Gera relatório de métricas em formato legível
   */
  generateReport(callId: string): string {
    const metrics = this.getCallMetrics(callId);
    const analysis = this.analyzePerformance(metrics);

    let report = `
╔══════════════════════════════════════════════════════════════╗
║                    RELATÓRIO DE MÉTRICAS                      ║
╠══════════════════════════════════════════════════════════════╣
║ Call ID: ${callId.padEnd(48)} ║
║ Duração: ${Math.round(metrics.totalDuration / 1000)}s | Turnos: ${metrics.turns.length.toString().padEnd(35)} ║
╠══════════════════════════════════════════════════════════════╣
║                    LATÊNCIA MÉDIA                             ║
╠──────────────────────────────────────────────────────────────╣
║ STT:              ${metrics.averageLatency.stt.toString().padEnd(6)}ms ${this.getIndicator(metrics.averageLatency.stt, this.thresholds.stt).padEnd(28)} ║
║ LLM:              ${metrics.averageLatency.llm.toString().padEnd(6)}ms ${this.getIndicator(metrics.averageLatency.llm, this.thresholds.llm).padEnd(28)} ║
║ TTS:              ${metrics.averageLatency.tts.toString().padEnd(6)}ms ${this.getIndicator(metrics.averageLatency.tts, this.thresholds.tts).padEnd(28)} ║
║ Total:            ${metrics.averageLatency.total.toString().padEnd(6)}ms ${this.getIndicator(metrics.averageLatency.total, this.thresholds.total).padEnd(28)} ║
║ Time to Audio:    ${metrics.averageLatency.timeToFirstAudio.toString().padEnd(6)}ms                              ║
╠══════════════════════════════════════════════════════════════╣
║                    LATÊNCIA PICO                              ║
╠──────────────────────────────────────────────────────────────╣
║ STT:              ${metrics.peakLatency.stt.toString().padEnd(6)}ms                              ║
║ LLM:              ${metrics.peakLatency.llm.toString().padEnd(6)}ms                              ║
║ TTS:              ${metrics.peakLatency.tts.toString().padEnd(6)}ms                              ║
║ Total:            ${metrics.peakLatency.total.toString().padEnd(6)}ms                              ║
╠══════════════════════════════════════════════════════════════╣
║ Fillers usados:   ${metrics.fillersUsed.toString().padEnd(46)} ║
║ Rating:           ${analysis.rating.toUpperCase().padEnd(46)} ║
║ Gargalo:          ${(analysis.bottleneck || 'nenhum').padEnd(46)} ║
╠══════════════════════════════════════════════════════════════╣
║ RECOMENDAÇÕES:                                                ║`;

    for (const rec of analysis.recommendations) {
      report += `\n║ • ${rec.substring(0, 58).padEnd(58)} ║`;
    }

    report += `
╚══════════════════════════════════════════════════════════════╝`;

    return report;
  }

  private getIndicator(value: number, threshold: number): string {
    if (value < threshold * 0.7) return '✅ Excelente';
    if (value < threshold) return '✅ OK';
    if (value < threshold * 1.3) return '⚠️ Atenção';
    return '❌ Crítico';
  }
}

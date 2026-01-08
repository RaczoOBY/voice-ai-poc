/**
 * LatencyAnalyzer - Analisa e identifica gargalos de latência
 */

import { Logger } from './Logger';
import { LatencyBreakdown } from '../types';

interface LatencyThresholds {
  stt: number;
  llm: number;
  tts: number;
  total: number;
  timeToFirstAudio: number;
}

interface ServiceAnalysis {
  service: 'STT' | 'LLM' | 'TTS' | 'Total' | 'Time to First Audio' | 'Speech Duration' | 'VAD Delay';
  currentLatency: number;
  targetLatency: number;
  deviation: number;
  deviationPercent: number;
  status: 'ok' | 'warning' | 'critical' | 'info';
  recommendation: string;
  isInfo?: boolean; // Indica se é apenas informativo (não é latência)
}

export class LatencyAnalyzer {
  private logger: Logger;
  private thresholds: LatencyThresholds;

  constructor(thresholds?: Partial<LatencyThresholds>) {
    this.logger = new Logger('LatencyAnalyzer');
    this.thresholds = {
      stt: thresholds?.stt || 300,      // Target: <300ms para Scribe
      llm: thresholds?.llm || 1000,     // Target: <1000ms para GPT-4o
      tts: thresholds?.tts || 200,      // Target: <200ms para ElevenLabs Flash
      total: thresholds?.total || 1500,  // Target: <1500ms voice-to-voice
      timeToFirstAudio: thresholds?.timeToFirstAudio || 1500, // Target: <1500ms
    };
  }

  /**
   * Analisa uma métrica de latência e identifica gargalos
   */
  analyze(latency: LatencyBreakdown): ServiceAnalysis[] {
    const analyses: ServiceAnalysis[] = [];

    // STT Analysis - agora mede apenas latência REAL (tempo até primeira parcial)
    analyses.push(this.analyzeService('STT', latency.stt, this.thresholds.stt, [
      'Latência real do STT (tempo até primeira transcrição parcial)',
      'Verifique conexão WebSocket com ElevenLabs Scribe',
      'Verifique se há problemas de rede ou latência com ElevenLabs',
    ]));

    // LLM Analysis
    analyses.push(this.analyzeService('LLM', latency.llm, this.thresholds.llm, [
      'Verifique conexão com OpenAI API',
      'Considere usar modelo mais rápido (gpt-4o-mini) se disponível',
      'Reduza tamanho do contexto histórico se muito grande',
      'Verifique se há problemas de rede',
    ]));

    // TTS Analysis
    analyses.push(this.analyzeService('TTS', latency.tts, this.thresholds.tts, [
      'Verifique conexão com ElevenLabs API',
      'Considere usar modelo Flash v2.5 para menor latência',
      'Verifique se há problemas de rede',
      'Considere reduzir tamanho do texto por chunk',
    ]));

    // Total Analysis
    analyses.push(this.analyzeService('Total', latency.total, this.thresholds.total, [
      'Otimize o serviço com maior latência identificado acima',
      'Considere usar streaming para reduzir latência total',
      'Verifique se há processamento sequencial que pode ser paralelizado',
    ]));

    // Time to First Audio Analysis
    analyses.push(this.analyzeService('Time to First Audio', latency.timeToFirstAudio, this.thresholds.timeToFirstAudio, [
      'Este é o tempo mais crítico para experiência do usuário',
      'Otimize principalmente STT e LLM que são os maiores gargalos',
      'Considere usar fillers para mascarar latência inicial',
    ]));

    // Adicionar métricas informativas (não são latência)
    if (latency.speechDuration !== undefined) {
      analyses.push(this.createInfoAnalysis('Speech Duration', latency.speechDuration, 
        'Tempo de fala do usuário (NÃO é latência, apenas informativo)'));
    }

    if (latency.vadDelay !== undefined) {
      analyses.push(this.createInfoAnalysis('VAD Delay', latency.vadDelay,
        'Tempo de espera do VAD após silêncio (configurável via vad_silence_threshold)'));
    }

    return analyses;
  }

  /**
   * Cria uma análise informativa (não é latência, apenas informação)
   */
  private createInfoAnalysis(service: ServiceAnalysis['service'], value: number, description: string): ServiceAnalysis {
    return {
      service,
      currentLatency: value,
      targetLatency: 0, // N/A para métricas informativas
      deviation: 0,
      deviationPercent: 0,
      status: 'info',
      recommendation: description,
      isInfo: true,
    };
  }

  /**
   * Analisa um serviço específico
   */
  private analyzeService(
    service: ServiceAnalysis['service'],
    currentLatency: number,
    targetLatency: number,
    recommendations: string[]
  ): ServiceAnalysis {
    const deviation = currentLatency - targetLatency;
    const deviationPercent = (deviation / targetLatency) * 100;

    let status: 'ok' | 'warning' | 'critical';
    if (currentLatency <= targetLatency) {
      status = 'ok';
    } else if (deviationPercent <= 50) {
      status = 'warning';
    } else {
      status = 'critical';
    }

    const recommendation = status === 'ok' 
      ? 'Latência dentro do esperado'
      : recommendations[0] || 'Verifique configurações do serviço';

    return {
      service,
      currentLatency,
      targetLatency,
      deviation,
      deviationPercent: Math.round(deviationPercent),
      status,
      recommendation,
    };
  }

  /**
   * Gera relatório formatado
   */
  generateReport(latency: LatencyBreakdown): string {
    const analyses = this.analyze(latency);
    
    // Separar análises de latência das informativas
    const latencyAnalyses = analyses.filter(a => !a.isInfo);
    const infoAnalyses = analyses.filter(a => a.isInfo);
    
    let report = '\n╔══════════════════════════════════════════════════════════════╗\n';
    report += '║           ANÁLISE DE LATÊNCIA - GARGALOS                    ║\n';
    report += '╠══════════════════════════════════════════════════════════════╣\n';
    
    // Métricas de latência (que importam para performance)
    for (const analysis of latencyAnalyses) {
      const icon = analysis.status === 'ok' ? '✅' : analysis.status === 'warning' ? '⚠️' : '🔴';
      
      report += `║ ${icon} ${analysis.service.padEnd(25)} │ ${analysis.currentLatency}ms (target: ${analysis.targetLatency}ms)\n`;
      
      if (analysis.status !== 'ok') {
        report += `║   └─ Desvio: +${analysis.deviation}ms (+${analysis.deviationPercent}%)\n`;
        report += `║   └─ Recomendação: ${analysis.recommendation}\n`;
      }
    }
    
    // Métricas informativas (não são latência)
    if (infoAnalyses.length > 0) {
      report += '╠══════════════════════════════════════════════════════════════╣\n';
      report += '║           INFORMAÇÕES ADICIONAIS (não são latência)         ║\n';
      report += '╠══════════════════════════════════════════════════════════════╣\n';
      
      for (const analysis of infoAnalyses) {
        report += `║ ℹ️ ${analysis.service.padEnd(25)} │ ${analysis.currentLatency}ms\n`;
        report += `║   └─ ${analysis.recommendation}\n`;
      }
    }
    
    report += '╚══════════════════════════════════════════════════════════════╝\n';
    
    // Identificar maior gargalo (apenas entre latências reais)
    const criticalServices = latencyAnalyses.filter(a => a.status === 'critical');
    const warningServices = latencyAnalyses.filter(a => a.status === 'warning');
    
    if (criticalServices.length > 0) {
      const biggestBottleneck = criticalServices.reduce((max, curr) => 
        curr.deviation > max.deviation ? curr : max
      );
      report += `\n🔴 MAIOR GARGALO: ${biggestBottleneck.service} (+${biggestBottleneck.deviation}ms acima do target)\n`;
      report += `   Priorize otimizar este serviço para melhorar experiência geral.\n`;
    } else if (warningServices.length > 0) {
      const biggestBottleneck = warningServices.reduce((max, curr) => 
        curr.deviation > max.deviation ? curr : max
      );
      report += `\n⚠️ ATENÇÃO: ${biggestBottleneck.service} está acima do target (+${biggestBottleneck.deviation}ms)\n`;
    } else {
      report += `\n✅ Todos os serviços estão dentro dos targets de latência!\n`;
    }
    
    return report;
  }

  /**
   * Loga análise formatada
   */
  logAnalysis(latency: LatencyBreakdown): void {
    const report = this.generateReport(latency);
    this.logger.info(report);
  }
}

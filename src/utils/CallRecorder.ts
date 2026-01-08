/**
 * CallRecorder - Gerencia transcrições de chamadas
 * 
 * Responsável apenas por:
 * - Criar pasta de gravação
 * - Salvar transcript.json
 * - Salvar transcript.txt
 * 
 * O áudio é gravado pelo AudioRoom (mixer em tempo real)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';
import { config } from '../config';
import { AgentThoughts } from '../types';

interface TranscriptEntry {
  timestamp: number;
  speaker: 'user' | 'agent';
  text: string;
  duration?: number;
}

interface CallRecordingMetadata {
  callId: string;
  startTime: string;
  endTime: string;
  duration: number;
  turns: number;
  transcript: TranscriptEntry[];
  internalThoughts?: AgentThoughts[];
  metrics?: {
    averageSTT: number;
    averageLLM: number;
    averageTTS: number;
    averageTimeToFirstAudio: number;
  };
}

export class CallRecorder {
  private logger: Logger;
  private callId: string;
  private startTime: Date;
  private transcript: TranscriptEntry[] = [];
  private internalThoughts: AgentThoughts[] = [];
  private isRecording: boolean = false;
  private recordingPath: string;
  private callFolder: string | null = null;

  constructor(callId: string) {
    this.logger = new Logger('CallRecorder');
    this.callId = callId;
    this.startTime = new Date();
    this.recordingPath = path.resolve(process.cwd(), config.recording?.savePath || './recordings');
    
    if (!fs.existsSync(this.recordingPath)) {
      fs.mkdirSync(this.recordingPath, { recursive: true });
    }
  }

  /**
   * Inicia a gravação - cria pasta para os arquivos
   */
  start(): void {
    if (!config.recording?.enabled) {
      this.logger.debug('Gravação desabilitada nas configurações');
      return;
    }

    const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
    this.callFolder = path.join(this.recordingPath, `${timestamp}_${this.callId}`);
    fs.mkdirSync(this.callFolder, { recursive: true });

    this.isRecording = true;

    this.logger.info(`🔴 Gravação iniciada: ${this.callId}`);
    this.logger.info(`   📁 Pasta: ${this.callFolder}`);
  }

  /**
   * Retorna o caminho da pasta de gravação
   */
  getRecordingFolder(): string | null {
    return this.callFolder;
  }

  /**
   * Adiciona entrada na transcrição
   */
  addTranscriptEntry(speaker: 'user' | 'agent', text: string, duration?: number): void {
    if (!this.isRecording || !config.recording?.saveTranscript) return;
    
    this.transcript.push({
      timestamp: Date.now() - this.startTime.getTime(),
      speaker,
      text,
      duration,
    });
  }

  /**
   * Adiciona pensamentos internos do agente
   */
  addThoughts(thoughts: AgentThoughts): void {
    if (!this.isRecording || !config.recording?.saveTranscript) return;
    
    this.internalThoughts.push(thoughts);
  }

  /**
   * Finaliza a gravação e salva transcrições
   */
  async stop(metrics?: CallRecordingMetadata['metrics']): Promise<string | null> {
    this.logger.info('⏹️ Finalizando transcrição...');
    
    if (!this.isRecording || !this.callFolder) {
      this.logger.warn('⚠️ Gravação não estava ativa');
      return null;
    }

    this.isRecording = false;
    const endTime = new Date();
    const duration = endTime.getTime() - this.startTime.getTime();

    const savedFiles: string[] = [];

    try {
      // Salvar transcrição
      if (config.recording?.saveTranscript && this.transcript.length > 0) {
        const metadata: CallRecordingMetadata = {
          callId: this.callId,
          startTime: this.startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration,
          turns: this.transcript.filter(t => t.speaker === 'user').length,
          transcript: this.transcript,
          internalThoughts: this.internalThoughts.length > 0 ? this.internalThoughts : undefined,
          metrics,
        };

        fs.writeFileSync(path.join(this.callFolder, 'transcript.json'), JSON.stringify(metadata, null, 2));
        savedFiles.push('transcript.json');

        fs.writeFileSync(path.join(this.callFolder, 'transcript.txt'), this.generateReadableTranscript(metadata));
        savedFiles.push('transcript.txt');
        
        this.logger.info(`📝 Transcrição salva`);
      }

      this.logger.info(`✅ Transcrição completa: ${this.callFolder}`);
      this.logger.info(`   Arquivos: ${savedFiles.join(', ')}`);

      return this.callFolder;

    } catch (error) {
      this.logger.error('❌ Erro ao salvar transcrição:', error);
      return this.callFolder;
    }
  }

  private generateReadableTranscript(metadata: CallRecordingMetadata): string {
    const lines: string[] = [
      '═══════════════════════════════════════════════════════════════',
      '                    TRANSCRIÇÃO DA CHAMADA',
      '═══════════════════════════════════════════════════════════════',
      '',
      `Call ID: ${metadata.callId}`,
      `Início: ${metadata.startTime}`,
      `Fim: ${metadata.endTime}`,
      `Duração: ${Math.round(metadata.duration / 1000)}s`,
      `Turnos: ${metadata.turns}`,
      '',
    ];

    if (metadata.metrics) {
      lines.push('MÉTRICAS:');
      lines.push(`  STT médio: ${metadata.metrics.averageSTT}ms`);
      lines.push(`  LLM médio: ${metadata.metrics.averageLLM}ms`);
      lines.push(`  TTS médio: ${metadata.metrics.averageTTS}ms`);
      lines.push(`  Time to First Audio médio: ${metadata.metrics.averageTimeToFirstAudio}ms`);
      lines.push('');
    }

    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('CONVERSA:');
    lines.push('───────────────────────────────────────────────────────────────');
    lines.push('');

    for (const entry of metadata.transcript) {
      const time = this.formatTimestamp(entry.timestamp);
      const speaker = entry.speaker === 'user' ? '👤 Usuário' : '🤖 Agente';
      lines.push(`[${time}] ${speaker}:`);
      lines.push(`"${entry.text}"`);
      lines.push('');
    }

    // Adicionar pensamentos internos se existirem
    if (metadata.internalThoughts && metadata.internalThoughts.length > 0) {
      lines.push('');
      lines.push('───────────────────────────────────────────────────────────────');
      lines.push('💭 PENSAMENTOS INTERNOS DO AGENTE:');
      lines.push('───────────────────────────────────────────────────────────────');
      lines.push('');

      for (const thought of metadata.internalThoughts) {
        const time = this.formatTimestamp(thought.timestamp.getTime() - this.startTime.getTime());
        lines.push(`[${time}] Turno ${thought.turnId}:`);
        lines.push(`  Análise: ${thought.userAnalysis}`);
        lines.push(`  Objetivo: ${thought.strategy.currentGoal}`);
        
        if (thought.strategy.nextSteps.length > 0) {
          lines.push(`  Próximos passos: ${thought.strategy.nextSteps.join(', ')}`);
        }
        
        if (thought.detectedNeeds.length > 0) {
          lines.push(`  Necessidades detectadas: ${thought.detectedNeeds.join(', ')}`);
        }
        
        if (thought.strategy.ifUserSays.length > 0) {
          lines.push(`  Contingências:`);
          thought.strategy.ifUserSays.forEach(c => {
            lines.push(`    - Se disser "${c.trigger}": ${c.action}`);
          });
        }
        
        lines.push(`  Confiança: ${(thought.confidence * 100).toFixed(0)}%`);
        lines.push('');
      }
    }

    lines.push('═══════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  private formatTimestamp(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}

/**
 * CallRecorder - Grava áudio e transcrições de chamadas com STREAMING
 * 
 * ESTRATÉGIA:
 * 1. Grava usuário e agente em arquivos WAV separados (streaming, sem acumular memória)
 * 2. No final, usa SoX para mixar os dois em um único arquivo
 * 
 * Isso garante:
 * - Streaming (não estoura memória)
 * - Qualidade de áudio (SoX faz mixagem profissional)
 * - Resistência a crashes (arquivos parciais salvos)
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { Logger } from './Logger';
import { config } from '../config';

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
  metrics?: {
    averageSTT: number;
    averageLLM: number;
    averageTTS: number;
    averageTimeToFirstAudio: number;
  };
}

// Constantes de áudio
const USER_SAMPLE_RATE = 16000;    // Microfone (Scribe espera 16kHz)
const AGENT_SAMPLE_RATE = 22050;   // ElevenLabs TTS
const OUTPUT_SAMPLE_RATE = 16000;  // Saída mixada
const BYTES_PER_SAMPLE = 2;        // 16-bit PCM
const WAV_HEADER_SIZE = 44;

export class CallRecorder {
  private logger: Logger;
  private callId: string;
  private startTime: Date;
  private transcript: TranscriptEntry[] = [];
  private isRecording: boolean = false;
  private recordingPath: string;
  private callFolder: string | null = null;
  
  // Streaming de áudio - arquivos separados
  private userWriteStream: fs.WriteStream | null = null;
  private agentWriteStream: fs.WriteStream | null = null;
  private userAudioPath: string | null = null;
  private agentAudioPath: string | null = null;
  private userBytesWritten: number = 0;
  private agentBytesWritten: number = 0;
  private userChunksWritten: number = 0;
  private agentChunksWritten: number = 0;

  constructor(callId: string) {
    this.logger = new Logger('CallRecorder');
    this.callId = callId;
    this.startTime = new Date();
    this.recordingPath = path.resolve(process.cwd(), config.recording?.savePath || './recordings');
    
    // Criar pasta de gravações se não existir
    if (!fs.existsSync(this.recordingPath)) {
      fs.mkdirSync(this.recordingPath, { recursive: true });
    }
  }

  /**
   * Inicia a gravação - Cria arquivos WAV separados para user e agent
   */
  start(): void {
    if (!config.recording?.enabled) {
      this.logger.debug('Gravação desabilitada nas configurações');
      return;
    }

    // Criar subpasta para esta chamada
    const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
    this.callFolder = path.join(this.recordingPath, `${timestamp}_${this.callId}`);
    fs.mkdirSync(this.callFolder, { recursive: true });

    // Criar arquivo WAV para usuário (16kHz)
    this.userAudioPath = path.join(this.callFolder, 'user_audio.wav');
    this.userWriteStream = fs.createWriteStream(this.userAudioPath);
    this.userWriteStream.write(this.createWavHeader(0, USER_SAMPLE_RATE));
    this.userBytesWritten = 0;
    this.userChunksWritten = 0;

    // Criar arquivo WAV para agente (22050Hz)
    this.agentAudioPath = path.join(this.callFolder, 'agent_audio.wav');
    this.agentWriteStream = fs.createWriteStream(this.agentAudioPath);
    this.agentWriteStream.write(this.createWavHeader(0, AGENT_SAMPLE_RATE));
    this.agentBytesWritten = 0;
    this.agentChunksWritten = 0;

    this.isRecording = true;
    this.logger.info(`🔴 Gravação iniciada: ${this.callId}`);
    this.logger.info(`   📁 Pasta: ${this.callFolder}`);
  }

  /**
   * Adiciona chunk de áudio do usuário (16kHz) - STREAMING direto para arquivo
   */
  addUserAudio(chunk: Buffer): void {
    if (!this.isRecording || !this.userWriteStream) return;
    
    this.userWriteStream.write(chunk);
    this.userBytesWritten += chunk.length;
    this.userChunksWritten++;
  }

  /**
   * Adiciona chunk de áudio do agente (22050Hz) - STREAMING direto para arquivo
   */
  addAgentAudio(chunk: Buffer): void {
    if (!this.isRecording || !this.agentWriteStream) return;
    
    this.agentWriteStream.write(chunk);
    this.agentBytesWritten += chunk.length;
    this.agentChunksWritten++;
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
   * Finaliza a gravação - Atualiza headers, mixa com SoX, salva transcrição
   */
  async stop(metrics?: CallRecordingMetadata['metrics']): Promise<string | null> {
    this.logger.info('⏹️ Finalizando gravação...');
    
    if (!this.isRecording || !this.callFolder) {
      this.logger.warn('⚠️ Gravação não estava ativa');
      return null;
    }

    this.isRecording = false;
    const endTime = new Date();
    const duration = endTime.getTime() - this.startTime.getTime();

    this.logger.info(`📊 Estatísticas da gravação:`);
    this.logger.info(`   Duração: ${Math.round(duration / 1000)}s`);
    this.logger.info(`   Chunks usuário: ${this.userChunksWritten} (${Math.round(this.userBytesWritten / 1024)}KB)`);
    this.logger.info(`   Chunks agente: ${this.agentChunksWritten} (${Math.round(this.agentBytesWritten / 1024)}KB)`);
    this.logger.info(`   Entradas de transcrição: ${this.transcript.length}`);

    const savedFiles: string[] = [];

    try {
      // PRIMEIRO: Finalizar arquivos de áudio separados
      await this.finalizeAudioFiles();
      
      if (this.userBytesWritten > 0) savedFiles.push('user_audio.wav');
      if (this.agentBytesWritten > 0) savedFiles.push('agent_audio.wav');

      // SEGUNDO: Mixar com SoX (mantém arquivos separados como backup)
      if (this.userBytesWritten > 0 || this.agentBytesWritten > 0) {
        const mixedPath = path.join(this.callFolder, 'call_recording.wav');
        const mixSuccess = await this.mixWithSox(mixedPath, duration);
        if (mixSuccess) {
          savedFiles.push('call_recording.wav');
          this.logger.info(`🎙️ Gravação mixada: call_recording.wav`);
        } else {
          this.logger.warn('⚠️ Mixagem falhou, arquivos separados mantidos como backup');
        }
      }

      // TERCEIRO: Salvar transcrição
      if (config.recording?.saveTranscript) {
        const metadata: CallRecordingMetadata = {
          callId: this.callId,
          startTime: this.startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration,
          turns: this.transcript.filter(t => t.speaker === 'user').length,
          transcript: this.transcript,
          metrics,
        };

        const transcriptPath = path.join(this.callFolder, 'transcript.json');
        fs.writeFileSync(transcriptPath, JSON.stringify(metadata, null, 2));
        savedFiles.push('transcript.json');
        this.logger.info(`📝 Transcrição salva: transcript.json`);

        // Também salvar como texto legível
        const readableTranscript = this.generateReadableTranscript(metadata);
        const readablePath = path.join(this.callFolder, 'transcript.txt');
        fs.writeFileSync(readablePath, readableTranscript);
        savedFiles.push('transcript.txt');
        this.logger.info(`📝 Transcrição legível salva: transcript.txt`);
      }

      this.logger.info(`✅ Gravação completa: ${this.callFolder}`);
      this.logger.info(`   Arquivos: ${savedFiles.join(', ')}`);

      return this.callFolder;

    } catch (error) {
      this.logger.error('❌ Erro ao salvar gravação:', error);
      if (savedFiles.length > 0) {
        this.logger.warn(`⚠️ Gravação parcial em: ${this.callFolder}`);
        return this.callFolder;
      }
      return null;
    }
  }

  /**
   * Finaliza os arquivos de áudio - Fecha streams e atualiza headers WAV
   */
  private async finalizeAudioFiles(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    // Fechar stream do usuário
    if (this.userWriteStream && this.userAudioPath) {
      closePromises.push(new Promise((resolve, reject) => {
        this.userWriteStream!.end(() => {
          try {
            if (this.userBytesWritten > 0) {
              const fd = fs.openSync(this.userAudioPath!, 'r+');
              const header = this.createWavHeader(this.userBytesWritten, USER_SAMPLE_RATE);
              fs.writeSync(fd, header, 0, WAV_HEADER_SIZE, 0);
              fs.closeSync(fd);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }));
    }

    // Fechar stream do agente
    if (this.agentWriteStream && this.agentAudioPath) {
      closePromises.push(new Promise((resolve, reject) => {
        this.agentWriteStream!.end(() => {
          try {
            if (this.agentBytesWritten > 0) {
              const fd = fs.openSync(this.agentAudioPath!, 'r+');
              const header = this.createWavHeader(this.agentBytesWritten, AGENT_SAMPLE_RATE);
              fs.writeSync(fd, header, 0, WAV_HEADER_SIZE, 0);
              fs.closeSync(fd);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      }));
    }

    await Promise.all(closePromises);
  }

  /**
   * Mixa os dois áudios usando SoX
   * SoX faz: resample, sincronização, mixagem profissional
   */
  private async mixWithSox(outputPath: string, durationMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const durationSec = Math.ceil(durationMs / 1000);
        
        // Verificar quais arquivos existem e têm conteúdo
        const hasUser = this.userAudioPath && this.userBytesWritten > 0;
        const hasAgent = this.agentAudioPath && this.agentBytesWritten > 0;

        if (!hasUser && !hasAgent) {
          this.logger.warn('⚠️ Nenhum áudio para mixar');
          resolve(false);
          return;
        }

        // Se só tem um, apenas copiar/converter
        if (!hasUser && hasAgent) {
          this.logger.info('🔄 Apenas áudio do agente - convertendo...');
          execSync(`sox "${this.agentAudioPath}" -r ${OUTPUT_SAMPLE_RATE} "${outputPath}"`, { stdio: 'pipe' });
          resolve(true);
          return;
        }

        if (hasUser && !hasAgent) {
          this.logger.info('🔄 Apenas áudio do usuário - copiando...');
          fs.copyFileSync(this.userAudioPath!, outputPath);
          resolve(true);
          return;
        }

        // Ambos existem - criar arquivos padronizados e mixar
        this.logger.info('🔄 Mixando áudios com SoX...');

        const tempDir = this.callFolder!;
        const userPadded = path.join(tempDir, 'user_padded.wav');
        const agentPadded = path.join(tempDir, 'agent_padded.wav');

        // Função para limpar arquivos temporários
        const cleanupTemp = () => {
          try {
            if (fs.existsSync(userPadded)) fs.unlinkSync(userPadded);
            if (fs.existsSync(agentPadded)) fs.unlinkSync(agentPadded);
          } catch (e) { /* ignore cleanup errors */ }
        };

        try {
          // Converter e padronizar usuário (já está em 16kHz, apenas pad)
          execSync(
            `sox "${this.userAudioPath}" -r ${OUTPUT_SAMPLE_RATE} "${userPadded}" pad 0 ${durationSec}`,
            { stdio: 'pipe', timeout: 30000 }  // 30s timeout
          );

          // Converter agente para 16kHz e pad
          // Reduzir volume do agente (0.8) para não sobrepor usuário
          execSync(
            `sox -v 0.8 "${this.agentAudioPath}" -r ${OUTPUT_SAMPLE_RATE} "${agentPadded}" pad 0 ${durationSec}`,
            { stdio: 'pipe', timeout: 30000 }
          );

          // Mixar os dois
          execSync(
            `sox -m "${userPadded}" "${agentPadded}" "${outputPath}" trim 0 ${durationSec}`,
            { stdio: 'pipe', timeout: 30000 }
          );

          cleanupTemp();
          this.logger.info(`✅ Mixagem concluída`);
          resolve(true);
        } catch (soxError: any) {
          this.logger.error('❌ Erro no SoX:', soxError.message);
          cleanupTemp();
          resolve(false);
        }
      } catch (error: any) {
        this.logger.error('❌ Erro ao mixar:', error.message);
        resolve(false);
      }
    });
  }

  /**
   * Gera transcrição legível em texto
   */
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

    lines.push('═══════════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Formata timestamp em MM:SS.mmm
   */
  private formatTimestamp(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = ms % 1000;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
  }

  /**
   * Cria header WAV
   */
  private createWavHeader(dataSize: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(WAV_HEADER_SIZE);
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    // RIFF chunk
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt sub-chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data sub-chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }
}

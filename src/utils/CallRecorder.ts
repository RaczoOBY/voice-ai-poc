/**
 * CallRecorder - Grava áudio e transcrições de chamadas
 * 
 * ESTRATÉGIA:
 * 1. Gravar user e agent com SILÊNCIO para preencher gaps (sincronizado!)
 * 2. Usar ffmpeg para mixar + adicionar fundo.mp3
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
const USER_SAMPLE_RATE = 16000;    // Microfone (16kHz)
const AGENT_SAMPLE_RATE = 22050;   // ElevenLabs TTS (22050Hz)
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
  
  // Streams para gravação
  private userStream: fs.WriteStream | null = null;
  private agentStream: fs.WriteStream | null = null;
  private userBytesWritten: number = 0;
  private agentBytesWritten: number = 0;
  
  // Timestamps para sincronização
  private recordingStartTime: number = 0;
  private lastUserTimestamp: number = 0;
  private lastAgentTimestamp: number = 0;

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
   * Inicia a gravação
   */
  start(): void {
    if (!config.recording?.enabled) {
      this.logger.debug('Gravação desabilitada nas configurações');
      return;
    }

    const timestamp = this.startTime.toISOString().replace(/[:.]/g, '-');
    this.callFolder = path.join(this.recordingPath, `${timestamp}_${this.callId}`);
    fs.mkdirSync(this.callFolder, { recursive: true });

    const userPath = path.join(this.callFolder, 'user_audio.wav');
    const agentPath = path.join(this.callFolder, 'agent_audio.wav');
    
    this.userStream = fs.createWriteStream(userPath);
    this.agentStream = fs.createWriteStream(agentPath);
    
    // Headers placeholder
    this.userStream.write(this.createWavHeader(0, USER_SAMPLE_RATE));
    this.agentStream.write(this.createWavHeader(0, AGENT_SAMPLE_RATE));
    
    this.userBytesWritten = 0;
    this.agentBytesWritten = 0;
    this.recordingStartTime = Date.now();
    this.lastUserTimestamp = 0;
    this.lastAgentTimestamp = 0;
    this.isRecording = true;

    this.logger.info(`🔴 Gravação iniciada: ${this.callId}`);
    this.logger.info(`   📁 Pasta: ${this.callFolder}`);
  }

  /**
   * Adiciona chunk de áudio do usuário (16kHz)
   */
  addUserAudio(chunk: Buffer): void {
    if (!this.isRecording || !this.userStream) return;
    
    const now = Date.now() - this.recordingStartTime;
    
    // Preencher gap com silêncio se necessário
    const gap = now - this.lastUserTimestamp;
    if (gap > 100 && this.lastUserTimestamp > 0) {
      const silenceBytes = Math.floor((gap / 1000) * USER_SAMPLE_RATE * BYTES_PER_SAMPLE);
      if (silenceBytes > 0 && silenceBytes < 1000000) { // Max 1MB de silêncio
        const silence = Buffer.alloc(silenceBytes, 0);
        this.userStream.write(silence);
        this.userBytesWritten += silenceBytes;
      }
    }
    
    this.userStream.write(chunk);
    this.userBytesWritten += chunk.length;
    this.lastUserTimestamp = now + (chunk.length / BYTES_PER_SAMPLE / USER_SAMPLE_RATE * 1000);
  }

  /**
   * Adiciona chunk de áudio do agente (22050Hz)
   * COM SILÊNCIO para manter sincronizado
   */
  addAgentAudio(chunk: Buffer): void {
    if (!this.isRecording || !this.agentStream) return;
    
    const now = Date.now() - this.recordingStartTime;
    
    // Preencher gap com silêncio se necessário
    const gap = now - this.lastAgentTimestamp;
    if (gap > 100 && this.lastAgentTimestamp > 0) {
      const silenceBytes = Math.floor((gap / 1000) * AGENT_SAMPLE_RATE * BYTES_PER_SAMPLE);
      if (silenceBytes > 0 && silenceBytes < 1000000) { // Max 1MB de silêncio
        const silence = Buffer.alloc(silenceBytes, 0);
        this.agentStream.write(silence);
        this.agentBytesWritten += silenceBytes;
      }
    }
    
    this.agentStream.write(chunk);
    this.agentBytesWritten += chunk.length;
    this.lastAgentTimestamp = now + (chunk.length / BYTES_PER_SAMPLE / AGENT_SAMPLE_RATE * 1000);
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
   * Finaliza a gravação
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

    await this.closeStreams();

    this.logger.info(`📊 Estatísticas da gravação:`);
    this.logger.info(`   Duração: ${Math.round(duration / 1000)}s`);
    this.logger.info(`   Bytes usuário: ${this.userBytesWritten}`);
    this.logger.info(`   Bytes agente: ${this.agentBytesWritten}`);

    const savedFiles: string[] = [];

    try {
      // Atualizar headers WAV
      await this.updateWavHeader(path.join(this.callFolder, 'user_audio.wav'), this.userBytesWritten, USER_SAMPLE_RATE);
      await this.updateWavHeader(path.join(this.callFolder, 'agent_audio.wav'), this.agentBytesWritten, AGENT_SAMPLE_RATE);
      
      if (this.userBytesWritten > 0) savedFiles.push('user_audio.wav');
      if (this.agentBytesWritten > 0) savedFiles.push('agent_audio.wav');

      // Mixar com ffmpeg (incluindo fundo.mp3)
      if (this.userBytesWritten > 0 && this.agentBytesWritten > 0) {
        const mixSuccess = this.mixWithFFmpeg();
        if (mixSuccess) {
          savedFiles.push('call_recording.wav');
        }
      }

      // Salvar transcrição
      if (config.recording?.saveTranscript && this.transcript.length > 0) {
        const metadata: CallRecordingMetadata = {
          callId: this.callId,
          startTime: this.startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration,
          turns: this.transcript.filter(t => t.speaker === 'user').length,
          transcript: this.transcript,
          metrics,
        };

        fs.writeFileSync(path.join(this.callFolder, 'transcript.json'), JSON.stringify(metadata, null, 2));
        savedFiles.push('transcript.json');

        fs.writeFileSync(path.join(this.callFolder, 'transcript.txt'), this.generateReadableTranscript(metadata));
        savedFiles.push('transcript.txt');
        
        this.logger.info(`📝 Transcrição salva`);
      }

      this.logger.info(`✅ Gravação completa: ${this.callFolder}`);
      this.logger.info(`   Arquivos: ${savedFiles.join(', ')}`);

      return this.callFolder;

    } catch (error) {
      this.logger.error('❌ Erro ao salvar gravação:', error);
      return this.callFolder;
    }
  }

  private closeStreams(): Promise<void> {
    return new Promise((resolve) => {
      let pending = 0;
      const checkDone = () => { pending--; if (pending <= 0) resolve(); };
      
      if (this.userStream) { pending++; this.userStream.end(checkDone); }
      if (this.agentStream) { pending++; this.agentStream.end(checkDone); }
      if (pending === 0) resolve();
    });
  }

  /**
   * Mixa user + agent + fundo.mp3 usando ffmpeg
   */
  private mixWithFFmpeg(): boolean {
    try {
      const userPath = path.join(this.callFolder!, 'user_audio.wav');
      const agentPath = path.join(this.callFolder!, 'agent_audio.wav');
      const outputPath = path.join(this.callFolder!, 'call_recording.wav');
      const bgMusicPath = path.resolve(process.cwd(), config.backgroundMusic?.filePath ?? 'src/audio/fundo.mp3');
      const bgVolume = config.backgroundMusic?.volume ?? 0.12;

      // Verificar ffmpeg
      try {
        execSync('which ffmpeg', { stdio: 'ignore' });
      } catch {
        this.logger.warn('⚠️ ffmpeg não encontrado. Instale com: brew install ffmpeg');
        return false;
      }

      this.logger.info('🔄 Mixando áudios com ffmpeg...');

      // Verificar se música de fundo existe
      const hasBgMusic = config.backgroundMusic?.enabled && fs.existsSync(bgMusicPath);

      let ffmpegCmd: string;
      
      if (hasBgMusic) {
        // Com música de fundo
        this.logger.info(`🎵 Incluindo música de fundo: ${bgMusicPath}`);
        ffmpegCmd = `ffmpeg -y \
          -i "${userPath}" \
          -i "${agentPath}" \
          -stream_loop -1 -i "${bgMusicPath}" \
          -filter_complex "\
            [0:a]aresample=22050,volume=1.0[user];\
            [1:a]volume=0.85[agent];\
            [2:a]volume=${bgVolume}[bg];\
            [user][agent]amix=inputs=2:duration=longest:dropout_transition=0[voices];\
            [voices][bg]amix=inputs=2:duration=first:dropout_transition=0[out]\
          " \
          -map "[out]" \
          -ar 22050 \
          -ac 1 \
          "${outputPath}" 2>/dev/null`;
      } else {
        // Sem música de fundo
        ffmpegCmd = `ffmpeg -y \
          -i "${userPath}" \
          -i "${agentPath}" \
          -filter_complex "\
            [0:a]aresample=22050,volume=1.0[user];\
            [1:a]volume=0.85[agent];\
            [user][agent]amix=inputs=2:duration=longest:dropout_transition=0[out]\
          " \
          -map "[out]" \
          -ar 22050 \
          -ac 1 \
          "${outputPath}" 2>/dev/null`;
      }

      execSync(ffmpegCmd, { stdio: 'ignore' });

      if (fs.existsSync(outputPath)) {
        const stats = fs.statSync(outputPath);
        this.logger.info(`✅ Gravação mixada: call_recording.wav (${Math.round(stats.size / 1024)}KB)`);
        if (hasBgMusic) {
          this.logger.info(`   🎵 Com música de fundo`);
        }
        return true;
      }

      return false;
    } catch (error: any) {
      this.logger.warn(`⚠️ Erro ao mixar: ${error.message}`);
      return false;
    }
  }

  private updateWavHeader(filePath: string, dataSize: number, sampleRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(filePath) || dataSize === 0) { resolve(); return; }
        const fd = fs.openSync(filePath, 'r+');
        fs.writeSync(fd, this.createWavHeader(dataSize, sampleRate), 0, WAV_HEADER_SIZE, 0);
        fs.closeSync(fd);
        resolve();
      } catch (error) { reject(error); }
    });
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

    lines.push('═══════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }

  private formatTimestamp(ms: number): string {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  private createWavHeader(dataSize: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(WAV_HEADER_SIZE);
    const byteRate = sampleRate * BYTES_PER_SAMPLE;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }
}

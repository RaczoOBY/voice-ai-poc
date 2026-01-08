/**
 * AudioRoom - Gravador de áudio com mixagem no final (v8)
 * 
 * Estratégia: Manter bytes originais, separar segmentos por timestamp
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './Logger';
import { config } from '../config';

const USER_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 22050;
const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_SIZE = 44;

interface UserSegment {
  startTimeMs: number;
  samples: number[];
}

interface AgentSegment {
  startTimeMs: number;
  buffer: Buffer;
}

export class AudioRoom {
  private logger: Logger;
  private outputPath: string | null = null;
  private isRecording: boolean = false;
  
  // User
  private userSegments: UserSegment[] = [];
  private currentUserSegment: UserSegment | null = null;
  
  // Agent - segmentos separados com bytes originais
  private agentSegments: AgentSegment[] = [];
  private currentAgentChunks: Buffer[] = [];
  private currentAgentStartMs: number = -1;
  
  // Background
  private bgBuffer: Int16Array | null = null;
  private bgVolume: number = 0.12;
  private bgEnabled: boolean = false;
  
  private startTime: number = 0;

  constructor() {
    this.logger = new Logger('AudioRoom');
  }

  start(outputPath: string): void {
    this.outputPath = outputPath;
    
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.userSegments = [];
    this.currentUserSegment = null;
    this.agentSegments = [];
    this.currentAgentChunks = [];
    this.currentAgentStartMs = -1;
    this.isRecording = true;
    this.startTime = Date.now();
    
    this.loadBackground();
    
    this.logger.info(`🎙️ AudioRoom iniciado: ${outputPath}`);
  }

  private loadBackground(): void {
    if (!config.backgroundMusic?.enabled) return;
    
    const bgPath = path.resolve(process.cwd(), 'src/audio/fundo.wav');
    if (!fs.existsSync(bgPath)) return;
    
    try {
      const wav = fs.readFileSync(bgPath);
      const pcm = wav.subarray(WAV_HEADER_SIZE);
      this.bgBuffer = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      this.bgVolume = config.backgroundMusic?.volume ?? 0.12;
      this.bgEnabled = true;
      this.logger.info(`🎵 Background carregado`);
    } catch (e) {
      this.logger.error('Erro ao carregar background:', e);
    }
  }

  feedUserAudio(chunk: Buffer): void {
    if (!this.isRecording) return;
    
    const now = Date.now();
    const resampled = this.upsample(chunk);
    const samples = this.bufferToSamples(resampled);
    
    if (samples.length === 0) return;
    
    if (!this.currentUserSegment) {
      this.currentUserSegment = { startTimeMs: now - this.startTime, samples: [] };
    }
    
    this.currentUserSegment.samples.push(...samples);
    
    if (this.currentUserSegment.samples.length >= OUTPUT_SAMPLE_RATE * 0.5) {
      this.userSegments.push(this.currentUserSegment);
      this.currentUserSegment = null;
    }
  }

  /**
   * Áudio do TTS - acumula chunks no segmento atual
   */
  feedAgentAudio(chunk: Buffer): void {
    if (!this.isRecording) return;
    
    // Primeiro chunk do segmento: registrar timestamp
    if (this.currentAgentStartMs < 0) {
      this.currentAgentStartMs = Date.now() - this.startTime;
    }
    
    // Copiar buffer
    const copy = Buffer.alloc(chunk.length);
    chunk.copy(copy);
    this.currentAgentChunks.push(copy);
  }

  /**
   * Finaliza o segmento atual do agente
   */
  endAgentSegment(): void {
    if (this.currentAgentChunks.length > 0 && this.currentAgentStartMs >= 0) {
      // Concatenar chunks em um único buffer
      const buffer = Buffer.concat(this.currentAgentChunks);
      
      this.agentSegments.push({
        startTimeMs: this.currentAgentStartMs,
        buffer: buffer
      });
      
      this.logger.debug(`✅ Segmento agente: ${buffer.length} bytes @ ${this.currentAgentStartMs}ms`);
    }
    
    // Reset para próximo segmento
    this.currentAgentChunks = [];
    this.currentAgentStartMs = -1;
  }

  private bufferToSamples(buf: Buffer): number[] {
    const samples: number[] = [];
    const validLen = Math.floor(buf.length / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
    for (let i = 0; i < validLen; i += BYTES_PER_SAMPLE) {
      samples.push(buf.readInt16LE(i));
    }
    return samples;
  }

  private upsample(input: Buffer): Buffer {
    const validLen = Math.floor(input.length / BYTES_PER_SAMPLE) * BYTES_PER_SAMPLE;
    if (validLen < 4) return Buffer.alloc(0);
    
    const inSamples = validLen / BYTES_PER_SAMPLE;
    const ratio = USER_SAMPLE_RATE / OUTPUT_SAMPLE_RATE;
    const outSamples = Math.floor(inSamples / ratio);
    
    if (outSamples <= 0) return Buffer.alloc(0);
    
    const output = Buffer.alloc(outSamples * BYTES_PER_SAMPLE);
    
    for (let i = 0; i < outSamples; i++) {
      const srcPos = i * ratio;
      const srcIdx = Math.floor(srcPos);
      const frac = srcPos - srcIdx;
      
      if (srcIdx >= inSamples - 1) {
        output.writeInt16LE(input.readInt16LE((inSamples - 1) * BYTES_PER_SAMPLE), i * BYTES_PER_SAMPLE);
        continue;
      }
      
      const s1 = input.readInt16LE(srcIdx * BYTES_PER_SAMPLE);
      const s2 = input.readInt16LE((srcIdx + 1) * BYTES_PER_SAMPLE);
      output.writeInt16LE(Math.round(s1 + (s2 - s1) * frac), i * BYTES_PER_SAMPLE);
    }
    
    return output;
  }

  async stop(): Promise<void> {
    this.logger.info('⏹️ Finalizando AudioRoom...');
    this.isRecording = false;
    
    // Fechar segmentos pendentes
    if (this.currentUserSegment && this.currentUserSegment.samples.length > 0) {
      this.userSegments.push(this.currentUserSegment);
    }
    this.endAgentSegment();
    
    if (!this.outputPath) return;

    // Calcular duração total
    const totalDurationMs = Date.now() - this.startTime;
    const totalSamples = Math.ceil((totalDurationMs / 1000) * OUTPUT_SAMPLE_RATE);
    
    this.logger.info(`📊 Processando áudio...`);
    this.logger.info(`   Duração: ${Math.round(totalDurationMs/1000)}s (${totalSamples} samples)`);
    this.logger.info(`   User segmentos: ${this.userSegments.length}`);
    this.logger.info(`   Agent segmentos: ${this.agentSegments.length}`);
    
    // Criar buffer de mixagem
    const mixBuffer = new Int32Array(totalSamples);
    
    // 1. Background
    if (this.bgEnabled && this.bgBuffer) {
      this.logger.info('   🎵 Adicionando background...');
      for (let i = 0; i < totalSamples; i++) {
        mixBuffer[i] = Math.round(this.bgBuffer[i % this.bgBuffer.length] * this.bgVolume);
      }
    }
    
    // 2. User
    this.logger.info('   🎤 Adicionando user...');
    let userTotal = 0;
    for (const seg of this.userSegments) {
      const startSample = Math.floor((seg.startTimeMs / 1000) * OUTPUT_SAMPLE_RATE);
      for (let i = 0; i < seg.samples.length; i++) {
        const pos = startSample + i;
        if (pos >= 0 && pos < totalSamples) {
          mixBuffer[pos] += seg.samples[i];
          userTotal++;
        }
      }
    }
    this.logger.info(`   📈 User: ${userTotal} samples`);
    
    // 3. Agent - cada segmento no seu timestamp
    this.logger.info('   🔊 Adicionando agent...');
    let agentTotal = 0;
    for (const seg of this.agentSegments) {
      const startSample = Math.floor((seg.startTimeMs / 1000) * OUTPUT_SAMPLE_RATE);
      const numSamples = Math.floor(seg.buffer.length / BYTES_PER_SAMPLE);
      
      for (let i = 0; i < numSamples; i++) {
        const pos = startSample + i;
        if (pos >= 0 && pos < totalSamples) {
          const sample = seg.buffer.readInt16LE(i * BYTES_PER_SAMPLE);
          mixBuffer[pos] += sample;
          agentTotal++;
        }
      }
    }
    this.logger.info(`   📈 Agent: ${agentTotal} samples em ${this.agentSegments.length} segmentos`);
    
    // Converter para Buffer
    const outputBuffer = Buffer.alloc(totalSamples * BYTES_PER_SAMPLE);
    for (let i = 0; i < totalSamples; i++) {
      outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, mixBuffer[i])), i * BYTES_PER_SAMPLE);
    }
    
    // Escrever WAV
    const header = this.createWavHeader(outputBuffer.length);
    fs.writeFileSync(this.outputPath, Buffer.concat([header, outputBuffer]));
    
    this.logger.info(`✅ AudioRoom: ${Math.round((header.length + outputBuffer.length) / 1024)}KB`);
    
    this.userSegments = [];
    this.agentSegments = [];
  }

  private createWavHeader(dataSize: number): Buffer {
    const header = Buffer.alloc(WAV_HEADER_SIZE);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(OUTPUT_SAMPLE_RATE, 24);
    header.writeUInt32LE(OUTPUT_SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
    header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return header;
  }

  isActive(): boolean {
    return this.isRecording;
  }
}

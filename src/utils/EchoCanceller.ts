/**
 * EchoCanceller - Cancelamento de eco por correlação
 * 
 * Problema: Quando o alto-falante reproduz áudio (voz do agente), o microfone
 * captura esse som (eco), que é interpretado como fala do usuário.
 * 
 * Solução: Compara o áudio capturado com o áudio que está sendo reproduzido
 * usando correlação cruzada. Se a correlação for alta, é eco e deve ser ignorado.
 * 
 * Algoritmo:
 * 1. Mantém buffer circular do áudio de referência (o que está sendo reproduzido)
 * 2. Para cada chunk do microfone, calcula correlação com o buffer de referência
 * 3. Se correlação > threshold, classifica como eco
 * 4. Considera também a energia do sinal para evitar falsos positivos em silêncio
 */

import { Logger } from './Logger';

export interface EchoCancellerConfig {
  enabled: boolean;
  correlationThreshold: number;  // 0.0 a 1.0 - quanto maior, mais restritivo
  referenceBufferMs: number;     // Tamanho do buffer de referência em ms
  latencyCompensationMs: number; // Compensar delay entre playback e captura
  energyThreshold: number;       // Threshold mínimo de energia para considerar eco
  sampleRate: number;            // Taxa de amostragem (16000 para mic, 22050 para playback)
  debug: boolean;                // Logs detalhados
}

export interface EchoAnalysisResult {
  isEcho: boolean;
  correlation: number;
  micEnergy: number;
  refEnergy: number;
  confidence: number;
  reason: string;
}

const DEFAULT_CONFIG: EchoCancellerConfig = {
  enabled: true,
  correlationThreshold: 0.35,     // Threshold de correlação para detectar eco
  referenceBufferMs: 800,         // Buffer de 800ms de áudio de referência
  latencyCompensationMs: 80,      // Delay típico entre playback e captura
  energyThreshold: 0.015,         // Energia mínima para considerar eco (evita silêncio)
  sampleRate: 16000,              // Sample rate do microfone
  debug: false,
};

export class EchoCanceller {
  private logger: Logger;
  private config: EchoCancellerConfig;
  
  // Buffer circular de referência (áudio que está sendo reproduzido)
  // Armazena em formato normalizado (Float32Array)
  private referenceBuffer: Float32Array;
  private referenceWritePos: number = 0;
  private referenceBufferFilled: boolean = false;
  
  // Estado
  private isPlaybackActive: boolean = false;
  private playbackEndTime: number = 0;
  
  // Estatísticas
  private totalChunksProcessed: number = 0;
  private echoChunksDetected: number = 0;
  private lastCorrelations: number[] = [];
  private static readonly CORRELATION_HISTORY_SIZE = 10;

  constructor(config?: Partial<EchoCancellerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = new Logger('EchoCanceller');
    
    // Calcular tamanho do buffer em samples
    const bufferSamples = Math.floor(
      (this.config.referenceBufferMs / 1000) * this.config.sampleRate
    );
    this.referenceBuffer = new Float32Array(bufferSamples);
    
    this.logger.info(`🔇 EchoCanceller inicializado:`);
    this.logger.info(`   Buffer: ${this.config.referenceBufferMs}ms (${bufferSamples} samples)`);
    this.logger.info(`   Correlation threshold: ${this.config.correlationThreshold}`);
    this.logger.info(`   Energy threshold: ${this.config.energyThreshold}`);
  }

  /**
   * Alimenta o buffer de referência com áudio que está sendo reproduzido
   * Deve ser chamado quando o TTS envia áudio para o speaker
   * 
   * IMPORTANTE: O áudio de referência pode ter sample rate diferente (22050Hz)
   * mas para correlação isso não importa muito - queremos detectar padrões
   */
  feedReference(audioChunk: Buffer): void {
    if (!this.config.enabled) return;
    
    this.isPlaybackActive = true;
    
    // Converter Buffer (Int16) para Float32 normalizado
    const samples = this.bufferToFloat32(audioChunk);
    
    // Escrever no buffer circular
    for (let i = 0; i < samples.length; i++) {
      this.referenceBuffer[this.referenceWritePos] = samples[i];
      this.referenceWritePos = (this.referenceWritePos + 1) % this.referenceBuffer.length;
    }
    
    // Marcar que buffer tem dados suficientes após uma volta completa
    if (this.referenceWritePos === 0 && !this.referenceBufferFilled) {
      this.referenceBufferFilled = true;
      this.logger.debug('📦 Buffer de referência preenchido');
    }
    
    if (this.config.debug) {
      const energy = this.calculateEnergy(samples);
      this.logger.debug(`📦 Ref chunk: ${audioChunk.length} bytes, energia: ${energy.toFixed(4)}`);
    }
  }

  /**
   * Notifica que o playback terminou
   */
  endPlayback(): void {
    this.isPlaybackActive = false;
    this.playbackEndTime = Date.now();
    this.logger.debug('⏹️ Playback encerrado');
  }

  /**
   * Limpa o buffer de referência (chamar quando iniciar nova fala do agente)
   */
  clearReference(): void {
    this.referenceBuffer.fill(0);
    this.referenceWritePos = 0;
    this.referenceBufferFilled = false;
    this.lastCorrelations = [];
    this.logger.debug('🗑️ Buffer de referência limpo');
  }

  /**
   * Processa um chunk do microfone e determina se é eco
   */
  process(micChunk: Buffer): EchoAnalysisResult {
    this.totalChunksProcessed++;
    
    // Se desabilitado, nunca é eco
    if (!this.config.enabled) {
      return {
        isEcho: false,
        correlation: 0,
        micEnergy: 0,
        refEnergy: 0,
        confidence: 0,
        reason: 'AEC desabilitado',
      };
    }

    // Converter chunk do mic para Float32
    const micSamples = this.bufferToFloat32(micChunk);
    const micEnergy = this.calculateEnergy(micSamples);
    
    // Se energia muito baixa, não é eco (é silêncio)
    if (micEnergy < this.config.energyThreshold * 0.5) {
      return {
        isEcho: false,
        correlation: 0,
        micEnergy,
        refEnergy: 0,
        confidence: 1,
        reason: 'Energia muito baixa (silêncio)',
      };
    }

    // Se não tem referência ainda, não pode ser eco
    if (!this.referenceBufferFilled) {
      return {
        isEcho: false,
        correlation: 0,
        micEnergy,
        refEnergy: 0,
        confidence: 0.5,
        reason: 'Buffer de referência vazio',
      };
    }

    // Se playback parou há muito tempo, provavelmente não é eco
    const timeSincePlayback = Date.now() - this.playbackEndTime;
    if (!this.isPlaybackActive && timeSincePlayback > this.config.referenceBufferMs + 200) {
      return {
        isEcho: false,
        correlation: 0,
        micEnergy,
        refEnergy: 0,
        confidence: 0.8,
        reason: `Playback parou há ${timeSincePlayback}ms`,
      };
    }

    // Calcular correlação com múltiplos offsets (para compensar latência variável)
    const { maxCorrelation, bestOffset, refEnergy } = this.findBestCorrelation(micSamples);
    
    // Adicionar ao histórico de correlações
    this.lastCorrelations.push(maxCorrelation);
    if (this.lastCorrelations.length > EchoCanceller.CORRELATION_HISTORY_SIZE) {
      this.lastCorrelations.shift();
    }
    
    // Calcular média de correlações recentes (suaviza flutuações)
    const avgCorrelation = this.lastCorrelations.reduce((a, b) => a + b, 0) / this.lastCorrelations.length;
    
    // Determinar se é eco baseado em múltiplos fatores
    const isEcho = this.classifyAsEcho(maxCorrelation, avgCorrelation, micEnergy, refEnergy);
    
    if (isEcho) {
      this.echoChunksDetected++;
    }

    const result: EchoAnalysisResult = {
      isEcho,
      correlation: maxCorrelation,
      micEnergy,
      refEnergy,
      confidence: this.calculateConfidence(maxCorrelation, micEnergy, refEnergy),
      reason: isEcho 
        ? `Eco detectado (corr: ${maxCorrelation.toFixed(3)}, offset: ${bestOffset})`
        : `Não é eco (corr: ${maxCorrelation.toFixed(3)})`,
    };

    if (this.config.debug) {
      const icon = isEcho ? '🔇' : '🎤';
      this.logger.debug(`${icon} ${result.reason} | energia mic: ${micEnergy.toFixed(4)}`);
    }

    return result;
  }

  /**
   * Encontra a melhor correlação testando múltiplos offsets
   * Isso compensa a latência variável entre playback e captura
   */
  private findBestCorrelation(micSamples: Float32Array): { 
    maxCorrelation: number; 
    bestOffset: number;
    refEnergy: number;
  } {
    let maxCorrelation = 0;
    let bestOffset = 0;
    let refEnergy = 0;
    
    // Calcular energia do buffer de referência
    refEnergy = this.calculateEnergy(this.referenceBuffer);
    
    // Se referência tem pouca energia, não há eco
    if (refEnergy < this.config.energyThreshold) {
      return { maxCorrelation: 0, bestOffset: 0, refEnergy };
    }
    
    // Testar múltiplos offsets no buffer de referência
    // Offsets representam diferentes latências possíveis
    const offsetStep = Math.floor(this.config.sampleRate * 0.01); // 10ms steps
    const maxOffsetSamples = Math.floor((this.config.latencyCompensationMs * 2 / 1000) * this.config.sampleRate);
    
    for (let offset = 0; offset < maxOffsetSamples; offset += offsetStep) {
      // Extrair segmento do buffer de referência com o offset
      const refSegment = this.extractRefSegment(micSamples.length, offset);
      
      // Calcular correlação normalizada
      const correlation = this.normalizedCorrelation(micSamples, refSegment);
      
      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        bestOffset = offset;
      }
    }
    
    return { maxCorrelation, bestOffset, refEnergy };
  }

  /**
   * Extrai um segmento do buffer circular de referência
   */
  private extractRefSegment(length: number, offset: number): Float32Array {
    const segment = new Float32Array(length);
    
    // Calcular posição de leitura com offset
    // Lemos de trás para frente (áudio mais recente)
    let readPos = (this.referenceWritePos - length - offset + this.referenceBuffer.length) % this.referenceBuffer.length;
    if (readPos < 0) readPos += this.referenceBuffer.length;
    
    for (let i = 0; i < length; i++) {
      segment[i] = this.referenceBuffer[(readPos + i) % this.referenceBuffer.length];
    }
    
    return segment;
  }

  /**
   * Calcula correlação normalizada entre dois sinais
   * Retorna valor entre 0 e 1 (1 = sinais idênticos)
   */
  private normalizedCorrelation(a: Float32Array, b: Float32Array): number {
    const n = Math.min(a.length, b.length);
    
    let sumAB = 0;
    let sumA2 = 0;
    let sumB2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumAB += a[i] * b[i];
      sumA2 += a[i] * a[i];
      sumB2 += b[i] * b[i];
    }
    
    const denominator = Math.sqrt(sumA2 * sumB2);
    
    if (denominator < 1e-10) {
      return 0; // Evita divisão por zero
    }
    
    // Correlação pode ser negativa, mas estamos interessados no valor absoluto
    return Math.abs(sumAB / denominator);
  }

  /**
   * Classifica se é eco baseado em múltiplos fatores
   */
  private classifyAsEcho(
    correlation: number, 
    avgCorrelation: number, 
    micEnergy: number, 
    refEnergy: number
  ): boolean {
    // Fator 1: Correlação acima do threshold
    if (correlation < this.config.correlationThreshold) {
      return false;
    }
    
    // Fator 2: Playback ativo ou recente
    const timeSincePlayback = Date.now() - this.playbackEndTime;
    if (!this.isPlaybackActive && timeSincePlayback > this.config.referenceBufferMs) {
      return false;
    }
    
    // Fator 3: Energia do mic deve ser similar ou menor que a referência
    // Se mic tem MUITO mais energia, pode ser fala do usuário + eco
    const energyRatio = refEnergy > 0 ? micEnergy / refEnergy : 0;
    if (energyRatio > 3.0) {
      // Mic tem 3x mais energia que referência - provavelmente é fala do usuário
      return false;
    }
    
    // Fator 4: Consistência - correlação média também deve ser alta
    if (avgCorrelation < this.config.correlationThreshold * 0.7) {
      // Correlação instantânea alta mas média baixa - pode ser coincidência
      return false;
    }
    
    return true;
  }

  /**
   * Calcula confiança da classificação
   */
  private calculateConfidence(correlation: number, micEnergy: number, refEnergy: number): number {
    // Confiança baseada na distância do threshold
    const corrConfidence = Math.min(1, (correlation / this.config.correlationThreshold));
    
    // Confiança baseada na consistência de energia
    const energyRatio = refEnergy > 0 ? Math.min(2, micEnergy / refEnergy) : 0;
    const energyConfidence = 1 - Math.abs(1 - energyRatio) / 2;
    
    return (corrConfidence + energyConfidence) / 2;
  }

  /**
   * Converte Buffer Int16 para Float32 normalizado
   * Garante que não lê além do tamanho do buffer
   */
  private bufferToFloat32(buffer: Buffer): Float32Array {
    // Garantir que temos número par de bytes (16-bit = 2 bytes por sample)
    const validBytes = buffer.length - (buffer.length % 2);
    const samples = Math.floor(validBytes / 2);
    const float32 = new Float32Array(samples);
    
    for (let i = 0; i < samples; i++) {
      const offset = i * 2;
      if (offset + 1 < buffer.length) {
        float32[i] = buffer.readInt16LE(offset) / 32768; // Normaliza para -1 a 1
      }
    }
    
    return float32;
  }

  /**
   * Calcula energia RMS de um array de samples
   */
  private calculateEnergy(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Retorna estatísticas do cancelador de eco
   */
  getStats(): {
    totalProcessed: number;
    echoDetected: number;
    echoPercentage: number;
    avgCorrelation: number;
    isPlaybackActive: boolean;
    bufferFilled: boolean;
  } {
    const avgCorr = this.lastCorrelations.length > 0
      ? this.lastCorrelations.reduce((a, b) => a + b, 0) / this.lastCorrelations.length
      : 0;
    
    return {
      totalProcessed: this.totalChunksProcessed,
      echoDetected: this.echoChunksDetected,
      echoPercentage: this.totalChunksProcessed > 0 
        ? (this.echoChunksDetected / this.totalChunksProcessed) * 100 
        : 0,
      avgCorrelation: avgCorr,
      isPlaybackActive: this.isPlaybackActive,
      bufferFilled: this.referenceBufferFilled,
    };
  }

  /**
   * Reseta estatísticas
   */
  resetStats(): void {
    this.totalChunksProcessed = 0;
    this.echoChunksDetected = 0;
    this.lastCorrelations = [];
  }

  /**
   * Habilita/desabilita o cancelador de eco
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.logger.info(`🔇 EchoCanceller ${enabled ? 'habilitado' : 'desabilitado'}`);
  }

  /**
   * Atualiza o threshold de correlação
   */
  setCorrelationThreshold(threshold: number): void {
    this.config.correlationThreshold = Math.max(0, Math.min(1, threshold));
    this.logger.info(`🔧 Correlation threshold: ${this.config.correlationThreshold}`);
  }

  /**
   * Ativa/desativa modo debug
   */
  setDebug(debug: boolean): void {
    this.config.debug = debug;
  }

  /**
   * Verifica se está habilitado
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

/**
 * EchoFilter - Filtragem de eco e transcrições corrompidas
 * 
 * Detecta e filtra:
 * - Eco do agente (quando o STT transcreve a fala do próprio agente)
 * - Transcrições corrompidas (onomatopeias, ruído, repetições)
 * 
 * Usado por VoiceAgent e StreamingVoiceAgent para evitar
 * processar transcrições inválidas.
 */

import { Logger } from '../utils/Logger';

export interface EchoFilterConfig {
  /** Tamanho mínimo para considerar substring como eco (default: 10) */
  minEchoLength?: number;
  /** Quantidade máxima de "oi" antes de considerar eco (default: 3) */
  maxOiCount?: number;
  /** Histórico de respostas do agente a manter (default: 3) */
  historySize?: number;
}

const DEFAULT_CONFIG: Required<EchoFilterConfig> = {
  minEchoLength: 10,
  maxOiCount: 3,
  historySize: 3,
};

export class EchoFilter {
  private logger: Logger;
  private config: Required<EchoFilterConfig>;
  
  // Histórico de respostas do agente para detectar eco
  private agentResponses: Map<string, string[]> = new Map();
  
  // Modo single-session
  private singleSessionId: string | null = null;

  constructor(config?: EchoFilterConfig) {
    this.logger = new Logger('EchoFilter');
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Define sessão única (modo single-session para StreamingVoiceAgent)
   */
  setSingleSession(callId: string): void {
    this.singleSessionId = callId;
    this.initSession(callId);
  }

  /**
   * Inicializa histórico para uma sessão
   */
  initSession(callId: string): void {
    if (!this.agentResponses.has(callId)) {
      this.agentResponses.set(callId, []);
    }
  }

  /**
   * Resolve callId (usa single-session se não fornecido)
   */
  private resolveCallId(callId?: string): string {
    const id = callId || this.singleSessionId;
    if (!id) {
      throw new Error('CallId não fornecido e modo single-session não configurado');
    }
    return id;
  }

  /**
   * Registra uma resposta do agente para detecção de eco
   */
  registerAgentResponse(response: string, callId?: string): void {
    const id = this.resolveCallId(callId);
    
    if (!this.agentResponses.has(id)) {
      this.agentResponses.set(id, []);
    }
    
    const history = this.agentResponses.get(id)!;
    history.push(response);
    
    // Manter apenas as últimas N respostas
    while (history.length > this.config.historySize) {
      history.shift();
    }
  }

  /**
   * Verifica se a transcrição é provavelmente eco do agente
   * (substring EXATA do que o agente acabou de dizer)
   * 
   * IMPORTANTE: Este filtro é conservador!
   * Só filtra se for substring EXATA e significativa.
   */
  isLikelyAgentEcho(text: string, callId?: string): boolean {
    if (!text || text.length < 5) return false;
    
    const id = this.resolveCallId(callId);
    const history = this.agentResponses.get(id);
    
    if (!history || history.length === 0) return false;
    
    const normalizedText = text.toLowerCase().trim();
    
    // Verificar contra todas as respostas recentes do agente
    for (const agentResponse of history) {
      const normalizedAgent = agentResponse.toLowerCase();
      
      // Só considera eco se for substring EXATA de pelo menos N caracteres
      if (normalizedText.length >= this.config.minEchoLength && 
          normalizedAgent.includes(normalizedText)) {
        this.logger.debug(`🔇 Transcrição "${text.substring(0, 30)}..." é substring exata do agente`);
        return true;
      }
    }
    
    return false;
  }

  /**
   * Detecta se uma transcrição parece corrompida
   * (eco do agente, onomatopeias repetidas, ruído)
   */
  isTranscriptionCorrupted(text: string, callId?: string): boolean {
    if (!text || text.length === 0) return true;
    
    const normalized = text.toLowerCase().trim();
    
    // 1. Muito curta (menos de 5 chars) e não é uma palavra válida
    if (normalized.length < 5) {
      const validShortWords = ['sim', 'não', 'ok', 'oi', 'olá', 'tá', 'é'];
      if (!validShortWords.includes(normalized)) {
        return true;
      }
    }
    
    // 2. Apenas onomatopeias/interjeições
    const onomatopeiasPattern = /^(h+[um]+|hum+|uhum+|ah+|eh+|oh+|uh+)[.!?,\s]*$/i;
    if (onomatopeiasPattern.test(normalized)) {
      return true;
    }
    
    // 3. Repetições suspeitas (eco do agente dizendo "oi, oi, oi...")
    const repeatedWordPattern = /^(\w+[,.\s]+)\1{2,}/i;
    if (repeatedWordPattern.test(normalized)) {
      return true;
    }
    
    // 4. Muitas repetições de "oi" (padrão comum de eco)
    const oiCount = (normalized.match(/\boi\b/gi) || []).length;
    if (oiCount > this.config.maxOiCount) {
      return true;
    }
    
    // 5. Verificar se é eco do agente (substring do que ele disse)
    if (callId || this.singleSessionId) {
      if (this.isLikelyAgentEcho(normalized, callId)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Verifica se texto é ruído/onomatopeia curta
   * Usado para filtrar transcrições parciais
   */
  isNoise(text: string): boolean {
    const trimmed = text.trim();
    
    // Muito curto
    if (trimmed.length < 5) return true;
    
    // Apenas onomatopeias
    const noisePattern = /^(h+[um]+|hum+|uhum+|ah+|eh+|oh+|uh+)[.!?,\s]*$/i;
    return noisePattern.test(trimmed);
  }

  /**
   * Filtra transcrição - retorna null se deve ser ignorada
   */
  filter(text: string, callId?: string): string | null {
    if (!text || text.trim().length === 0) {
      return null;
    }
    
    const trimmed = text.trim();
    
    // Verificar se é eco do agente
    if (this.isLikelyAgentEcho(trimmed, callId)) {
      this.logger.info(`🔇 Ignorando eco do agente: "${trimmed.substring(0, 30)}..."`);
      return null;
    }
    
    // Verificar se é corrompida
    if (this.isTranscriptionCorrupted(trimmed, callId)) {
      this.logger.info(`🔇 Ignorando transcrição corrompida: "${trimmed.substring(0, 30)}..."`);
      return null;
    }
    
    return trimmed;
  }

  /**
   * Limpa histórico da sessão
   */
  clearSession(callId?: string): void {
    const id = this.resolveCallId(callId);
    this.agentResponses.delete(id);
  }

  /**
   * Limpa todo o histórico
   */
  clearAll(): void {
    this.agentResponses.clear();
    this.singleSessionId = null;
  }
}

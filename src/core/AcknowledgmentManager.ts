/**
 * AcknowledgmentManager - Gerenciamento de acknowledgments de escuta ativa
 * 
 * Responsável por:
 * - Cache de áudios pré-gerados ("Uhum", "Hm", "Ok")
 * - Controle de cooldown entre reproduções
 * - Preload em background para latência zero
 * 
 * Usado quando detectamos que o usuário continuou falando
 * para dar feedback de que o agente está ouvindo.
 */

import { Logger } from '../utils/Logger';
import { ITTS } from '../types';
import { config as appConfig } from '../config';

export interface AcknowledgmentConfig {
  /** Se acknowledgments estão habilitados */
  enabled?: boolean;
  /** Frases de acknowledgment */
  phrases?: string[];
  /** Cooldown entre acknowledgments em ms */
  cooldownMs?: number;
}

const DEFAULT_CONFIG: Required<AcknowledgmentConfig> = {
  enabled: true,
  phrases: ['Uhum', 'Hm', 'Tá'],
  cooldownMs: 3000,
};

export class AcknowledgmentManager {
  private logger: Logger;
  private config: Required<AcknowledgmentConfig>;
  private tts: ITTS;
  
  // Cache de áudios pré-gerados
  private audioCache: Map<string, Buffer> = new Map();
  
  // Controle de cooldown por sessão
  private lastPlayTime: Map<string, number> = new Map();
  
  // Modo single-session
  private singleSessionId: string | null = null;

  constructor(tts: ITTS, config?: AcknowledgmentConfig) {
    this.logger = new Logger('Acknowledgment');
    this.tts = tts;
    
    // Merge com config do app se disponível
    const appAckConfig = (appConfig as any).acknowledgments || {};
    this.config = {
      ...DEFAULT_CONFIG,
      ...appAckConfig,
      ...config,
    };
  }

  /**
   * Define sessão única (modo single-session para StreamingVoiceAgent)
   */
  setSingleSession(callId: string): void {
    this.singleSessionId = callId;
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
   * Verifica se acknowledgments estão habilitados
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Pré-carrega todos os áudios de acknowledgment em background
   * Garante latência zero quando precisar tocar
   */
  async preload(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.debug('⏭️ Acknowledgments desabilitados - pulando preload');
      return;
    }

    this.logger.debug('🎵 Pré-carregando áudios de acknowledgment...');

    const promises = this.config.phrases.map(async (phrase) => {
      if (!this.audioCache.has(phrase)) {
        try {
          const result = await this.tts.synthesize(phrase);
          this.audioCache.set(phrase, result.audioBuffer);
          this.logger.debug(`   ✅ "${phrase}" carregado`);
        } catch (error) {
          this.logger.warn(`   ⚠️ Erro ao carregar "${phrase}":`, error);
        }
      }
    });

    await Promise.all(promises);
    this.logger.debug(`✅ ${this.audioCache.size} acknowledgments pré-carregados`);
  }

  /**
   * Verifica se está em cooldown
   */
  isInCooldown(callId?: string): boolean {
    const id = this.resolveCallId(callId);
    const lastTime = this.lastPlayTime.get(id) || 0;
    const elapsed = Date.now() - lastTime;
    return elapsed < this.config.cooldownMs;
  }

  /**
   * Obtém tempo restante de cooldown em ms
   */
  getCooldownRemaining(callId?: string): number {
    const id = this.resolveCallId(callId);
    const lastTime = this.lastPlayTime.get(id) || 0;
    const elapsed = Date.now() - lastTime;
    return Math.max(0, this.config.cooldownMs - elapsed);
  }

  /**
   * Obtém um acknowledgment aleatório para tocar
   * Retorna null se desabilitado ou em cooldown
   */
  async getAcknowledgment(callId?: string): Promise<{ text: string; audio: Buffer } | null> {
    if (!this.config.enabled) {
      return null;
    }

    const id = this.resolveCallId(callId);

    // Verificar cooldown
    if (this.isInCooldown(id)) {
      const remaining = this.getCooldownRemaining(id);
      this.logger.debug(`⏳ Acknowledgment em cooldown (${remaining}ms restantes)`);
      return null;
    }

    // Selecionar frase aleatória
    const phrases = this.config.phrases;
    const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

    // Obter áudio do cache ou gerar
    let audioBuffer = this.audioCache.get(randomPhrase);

    if (!audioBuffer) {
      // Gerar em tempo real se não estiver no cache
      this.logger.debug(`🎵 Gerando áudio para "${randomPhrase}"...`);
      try {
        const result = await this.tts.synthesize(randomPhrase);
        audioBuffer = result.audioBuffer;
        // Cachear para próximas vezes
        this.audioCache.set(randomPhrase, audioBuffer);
      } catch (error) {
        this.logger.warn(`⚠️ Erro ao gerar acknowledgment:`, error);
        return null;
      }
    }

    // Atualizar tempo do último play
    this.lastPlayTime.set(id, Date.now());

    this.logger.info(`🎵 Acknowledgment: "${randomPhrase}"`);
    return { text: randomPhrase, audio: audioBuffer };
  }

  /**
   * Marca que um acknowledgment foi tocado (atualiza cooldown)
   */
  markPlayed(callId?: string): void {
    const id = this.resolveCallId(callId);
    this.lastPlayTime.set(id, Date.now());
  }

  /**
   * Reseta cooldown da sessão
   */
  resetCooldown(callId?: string): void {
    const id = this.resolveCallId(callId);
    this.lastPlayTime.delete(id);
  }

  /**
   * Limpa recursos da sessão
   */
  clearSession(callId?: string): void {
    const id = this.resolveCallId(callId);
    this.lastPlayTime.delete(id);
  }

  /**
   * Limpa todos os recursos
   */
  clearAll(): void {
    this.lastPlayTime.clear();
    // Não limpar audioCache - pode ser reutilizado
    this.singleSessionId = null;
  }
}

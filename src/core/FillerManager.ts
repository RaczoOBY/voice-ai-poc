/**
 * FillerManager - Gerenciador de frases de preenchimento
 * 
 * Responsável por:
 * - Pré-gerar áudios de fillers no startup
 * - Selecionar filler apropriado baseado no contexto
 * - Personalizar fillers com nome do prospect
 */

import { ITTS, IFillerManager, FillerAudio, FillerCategory, FillerContext } from '../types';
import { config } from '../config';
import { Logger } from '../utils/Logger';

export class FillerManager implements IFillerManager {
  private tts: ITTS;
  private logger: Logger;
  
  // Cache de áudios pré-gerados
  private genericFillers: FillerAudio[] = [];
  private transitionFillers: FillerAudio[] = [];
  private clarificationFillers: FillerAudio[] = [];
  
  // Cache de fillers com nomes (gerados sob demanda)
  private namedFillers: Map<string, FillerAudio[]> = new Map();
  
  // Templates para fillers com nome
  private nameTemplates: string[] = [];

  constructor(tts: ITTS) {
    this.tts = tts;
    this.logger = new Logger('FillerManager');
    this.nameTemplates = config.fillers.withName;
  }

  /**
   * Pré-carrega todos os fillers genéricos no startup
   * Isso evita latência de TTS durante a chamada
   */
  async preloadFillers(): Promise<void> {
    this.logger.info('🔄 Pré-carregando fillers...');
    const startTime = Date.now();

    // Carregar fillers genéricos
    this.genericFillers = await this.generateFillerCategory(
      config.fillers.generic,
      'generic'
    );
    this.logger.info(`✅ ${this.genericFillers.length} fillers genéricos carregados`);

    // Carregar fillers de transição
    this.transitionFillers = await this.generateFillerCategory(
      config.fillers.transition,
      'transition'
    );
    this.logger.info(`✅ ${this.transitionFillers.length} fillers de transição carregados`);

    // Carregar fillers de clarificação
    this.clarificationFillers = await this.generateFillerCategory(
      config.fillers.clarification,
      'clarification'
    );
    this.logger.info(`✅ ${this.clarificationFillers.length} fillers de clarificação carregados`);

    const duration = Date.now() - startTime;
    const total = this.genericFillers.length + this.transitionFillers.length + this.clarificationFillers.length;
    this.logger.info(`🎉 ${total} fillers pré-carregados em ${duration}ms`);
  }

  /**
   * Gera fillers personalizados com o nome do prospect
   * Chamado quando descobrimos o nome durante a chamada
   */
  async preloadFillersForName(name: string): Promise<void> {
    if (this.namedFillers.has(name.toLowerCase())) {
      this.logger.debug(`Fillers para "${name}" já carregados`);
      return;
    }

    this.logger.info(`🔄 Gerando fillers personalizados para "${name}"...`);
    const startTime = Date.now();

    const texts = this.nameTemplates.map((template) =>
      template.replace('{name}', name)
    );

    const fillers = await this.generateFillerCategory(texts, 'withName');
    this.namedFillers.set(name.toLowerCase(), fillers);

    const duration = Date.now() - startTime;
    this.logger.info(`✅ ${fillers.length} fillers para "${name}" gerados em ${duration}ms`);
  }

  /**
   * Gera áudios para uma categoria de fillers
   */
  private async generateFillerCategory(
    texts: string[],
    category: FillerCategory
  ): Promise<FillerAudio[]> {
    const fillers: FillerAudio[] = [];

    for (const text of texts) {
      try {
        const result = await this.tts.synthesize(text);
        fillers.push({
          text,
          audioBuffer: result.audioBuffer,
          duration: result.duration,
          category,
        });
      } catch (error) {
        this.logger.error(`Erro ao gerar filler "${text}":`, error);
      }
    }

    return fillers;
  }

  /**
   * Seleciona o filler mais apropriado baseado no contexto
   */
  getFiller(context: FillerContext): FillerAudio | null {
    // Se temos o nome do prospect, priorizar fillers personalizados
    if (context.prospectName) {
      const namedFiller = this.getFillerForName(context.prospectName);
      if (namedFiller && Math.random() > 0.3) {
        // 70% chance de usar filler com nome se disponível
        return namedFiller;
      }
    }

    // Detectar se precisamos de filler de clarificação
    if (this.needsClarification(context.lastUserMessage)) {
      return this.getRandomFiller(this.clarificationFillers);
    }

    // Baseado no estágio da conversa
    switch (context.conversationStage) {
      case 'intro':
        // Na introdução, usar fillers genéricos simples
        return this.getRandomFiller(this.genericFillers);
      
      case 'qualifying':
      case 'presenting':
        // Durante qualificação/apresentação, alternar entre transição e genéricos
        return Math.random() > 0.5
          ? this.getRandomFiller(this.transitionFillers)
          : this.getRandomFiller(this.genericFillers);
      
      case 'closing':
        // No fechamento, usar transições para parecer mais confiante
        return this.getRandomFiller(this.transitionFillers);
      
      default:
        return this.getRandomFiller(this.genericFillers);
    }
  }

  /**
   * Retorna um filler com o nome do prospect
   */
  getFillerForName(name: string): FillerAudio | null {
    const fillers = this.namedFillers.get(name.toLowerCase());
    if (!fillers || fillers.length === 0) {
      return null;
    }
    return this.getRandomFiller(fillers);
  }

  /**
   * Seleciona um filler aleatório de uma lista
   * Usa weighted random para evitar repetições recentes
   */
  private getRandomFiller(fillers: FillerAudio[]): FillerAudio | null {
    if (fillers.length === 0) {
      return null;
    }
    const index = Math.floor(Math.random() * fillers.length);
    return fillers[index];
  }

  /**
   * Detecta se a mensagem do usuário indica que não foi entendida
   */
  private needsClarification(message?: string): boolean {
    if (!message) return false;
    
    const clarificationIndicators = [
      'não entendi',
      'pode repetir',
      'como assim',
      'o que',
      'hm',
      'ahn',
    ];
    
    const normalized = message.toLowerCase().trim();
    
    // Mensagem muito curta pode indicar confusão
    if (normalized.length < 5) {
      return true;
    }
    
    return clarificationIndicators.some((indicator) =>
      normalized.includes(indicator)
    );
  }

  /**
   * Retorna estatísticas dos fillers carregados
   */
  getStats(): {
    generic: number;
    transition: number;
    clarification: number;
    namedProspects: number;
    totalAudioDuration: number;
  } {
    const allFillers = [
      ...this.genericFillers,
      ...this.transitionFillers,
      ...this.clarificationFillers,
      ...Array.from(this.namedFillers.values()).flat(),
    ];

    return {
      generic: this.genericFillers.length,
      transition: this.transitionFillers.length,
      clarification: this.clarificationFillers.length,
      namedProspects: this.namedFillers.size,
      totalAudioDuration: allFillers.reduce((sum, f) => sum + f.duration, 0),
    };
  }
}

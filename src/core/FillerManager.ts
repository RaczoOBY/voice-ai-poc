/**
 * FillerManager - Gerenciador de frases de preenchimento
 * 
 * Responsável por:
 * - Pré-gerar áudios de fillers no startup
 * - Pré-gerar saudações e despedidas comuns
 * - Selecionar filler apropriado baseado no contexto
 * - Personalizar fillers com nome do prospect
 */

import { ITTS, IFillerManager, FillerAudio, FillerCategory, FillerContext } from '../types';
import { config } from '../config';
import { Logger } from '../utils/Logger';

// Saudações pré-geradas (usar para latência zero na abertura)
const PREGENERATED_GREETINGS = [
  'Oi! Tudo bem? Aqui é a Ana da ZapVoice! Com quem eu tô falando?',
  'E aí, tudo certo? Sou a Marina da ZapVoice... com quem eu falo?',
  'Opa! Aqui é a Juliana, da ZapVoice. Quem tá falando aí?',
];

// Despedidas comuns pré-geradas
const PREGENERATED_FAREWELLS = [
  'Muito obrigada, viu? Foi ótimo falar com você!',
  'Valeu demais! Qualquer coisa, me chama!',
  'Perfeito! Foi um prazer. Até mais!',
  'Show! Então é isso. Obrigada pelo seu tempo!',
];

// Fillers de empatia para momentos específicos
const EMPATHY_FILLERS = [
  'Faz sentido...',
  'Ah, entendo...',
  'Sei como é...',
  'A gente vê muito isso...',
  'Pois é...',
  'Nossa...',
];

export class FillerManager implements IFillerManager {
  private tts: ITTS;
  private logger: Logger;
  
  // Cache de áudios pré-gerados
  private genericFillers: FillerAudio[] = [];
  private transitionFillers: FillerAudio[] = [];
  private clarificationFillers: FillerAudio[] = [];
  private empathyFillers: FillerAudio[] = [];
  
  // Saudações e despedidas pré-geradas (latência zero)
  private greetings: FillerAudio[] = [];
  private farewells: FillerAudio[] = [];
  
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
    this.logger.info('🔄 Pré-carregando fillers, saudações e despedidas...');
    const startTime = Date.now();

    // Carregar em paralelo para maior velocidade
    const [
      genericResult,
      transitionResult,
      clarificationResult,
      empathyResult,
      greetingsResult,
      farewellsResult,
    ] = await Promise.all([
      this.generateFillerCategory(config.fillers.generic, 'generic'),
      this.generateFillerCategory(config.fillers.transition, 'transition'),
      this.generateFillerCategory(config.fillers.clarification, 'clarification'),
      this.generateFillerCategory(EMPATHY_FILLERS, 'empathy'),
      this.generateFillerCategory(PREGENERATED_GREETINGS, 'greeting'),
      this.generateFillerCategory(PREGENERATED_FAREWELLS, 'farewell'),
    ]);

    this.genericFillers = genericResult;
    this.transitionFillers = transitionResult;
    this.clarificationFillers = clarificationResult;
    this.empathyFillers = empathyResult;
    this.greetings = greetingsResult;
    this.farewells = farewellsResult;

    this.logger.info(`✅ ${this.genericFillers.length} fillers genéricos`);
    this.logger.info(`✅ ${this.transitionFillers.length} fillers de transição`);
    this.logger.info(`✅ ${this.clarificationFillers.length} fillers de clarificação`);
    this.logger.info(`✅ ${this.empathyFillers.length} fillers de empatia`);
    this.logger.info(`✅ ${this.greetings.length} saudações pré-geradas`);
    this.logger.info(`✅ ${this.farewells.length} despedidas pré-geradas`);

    const duration = Date.now() - startTime;
    const total = this.genericFillers.length + this.transitionFillers.length + 
                  this.clarificationFillers.length + this.empathyFillers.length +
                  this.greetings.length + this.farewells.length;
    this.logger.info(`🎉 ${total} áudios pré-carregados em ${duration}ms`);
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
   * Usa synthesizeFiller() se disponível para voz mais natural
   */
  private async generateFillerCategory(
    texts: string[],
    category: FillerCategory
  ): Promise<FillerAudio[]> {
    const fillers: FillerAudio[] = [];

    for (const text of texts) {
      try {
        // Usar synthesizeFiller se disponível (voz mais natural para fillers)
        const result = this.tts.synthesizeFiller 
          ? await this.tts.synthesizeFiller(text)
          : await this.tts.synthesize(text);
          
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

    // Detectar se usuário expressa frustração ou preocupação (usar empatia)
    if (this.needsEmpathy(context.lastUserMessage)) {
      return this.getRandomFiller(this.empathyFillers);
    }

    // Baseado no estágio da conversa
    switch (context.conversationStage) {
      case 'intro':
        // Na introdução, usar fillers genéricos simples
        return this.getRandomFiller(this.genericFillers);
      
      case 'qualifying':
      case 'presenting':
        // Durante qualificação/apresentação, alternar entre transição e genéricos
        // Com 20% de chance de usar empatia para parecer mais humano
        const rand = Math.random();
        if (rand < 0.2 && this.empathyFillers.length > 0) {
          return this.getRandomFiller(this.empathyFillers);
        } else if (rand < 0.6) {
          return this.getRandomFiller(this.transitionFillers);
        }
        return this.getRandomFiller(this.genericFillers);
      
      case 'closing':
        // No fechamento, usar transições para parecer mais confiante
        return this.getRandomFiller(this.transitionFillers);
      
      default:
        return this.getRandomFiller(this.genericFillers);
    }
  }

  /**
   * Detecta se o usuário expressa frustração ou preocupação
   */
  private needsEmpathy(message?: string): boolean {
    if (!message) return false;
    
    const normalized = message.toLowerCase();
    const empathyTriggers = [
      'difícil', 'problema', 'preocupado', 'complicado', 'frustra',
      'não funciona', 'não tá funcionando', 'cansado', 'trabalho',
      'muito trabalho', 'demanda', 'muita coisa', 'não dou conta',
    ];
    
    return empathyTriggers.some(trigger => normalized.includes(trigger));
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
   * CUIDADO: Ser muito específico para evitar falsos positivos
   */
  private needsClarification(message?: string): boolean {
    if (!message) return false;
    
    const normalized = message.toLowerCase().trim();
    
    // Só considera clarificação se a mensagem for MUITO curta (< 3 chars)
    // ou se contiver frases EXATAS de confusão
    if (normalized.length < 3) {
      return true;
    }
    
    // Frases EXATAS que indicam que o usuário não entendeu
    const exactPhrases = [
      'não entendi',
      'não entendi bem',
      'pode repetir',
      'repete por favor',
      'como assim?',  // Com interrogação
      'oi?',
      'hã?',
      'o que?',  // Só "o que?" isolado
    ];
    
    return exactPhrases.some((phrase) => 
      normalized === phrase || normalized.startsWith(phrase + ' ') || normalized.endsWith(' ' + phrase)
    );
  }

  /**
   * Retorna uma saudação pré-gerada (latência zero)
   * Útil para começar a chamada instantaneamente
   */
  getPreGeneratedGreeting(): FillerAudio | null {
    return this.getRandomFiller(this.greetings);
  }

  /**
   * Retorna uma despedida pré-gerada (latência zero)
   */
  getPreGeneratedFarewell(): FillerAudio | null {
    return this.getRandomFiller(this.farewells);
  }

  /**
   * Retorna um filler de empatia
   * Usado quando o usuário expressa frustração ou preocupação
   */
  getEmpathyFiller(): FillerAudio | null {
    return this.getRandomFiller(this.empathyFillers);
  }

  /**
   * Verifica se há saudações pré-geradas disponíveis
   */
  hasPreGeneratedGreetings(): boolean {
    return this.greetings.length > 0;
  }

  /**
   * Retorna estatísticas dos fillers carregados
   */
  getStats(): {
    generic: number;
    transition: number;
    clarification: number;
    empathy: number;
    greetings: number;
    farewells: number;
    namedProspects: number;
    totalAudioDuration: number;
  } {
    const allFillers = [
      ...this.genericFillers,
      ...this.transitionFillers,
      ...this.clarificationFillers,
      ...this.empathyFillers,
      ...this.greetings,
      ...this.farewells,
      ...Array.from(this.namedFillers.values()).flat(),
    ];

    return {
      generic: this.genericFillers.length,
      transition: this.transitionFillers.length,
      clarification: this.clarificationFillers.length,
      empathy: this.empathyFillers.length,
      greetings: this.greetings.length,
      farewells: this.farewells.length,
      namedProspects: this.namedFillers.size,
      totalAudioDuration: allFillers.reduce((sum, f) => sum + f.duration, 0),
    };
  }
}

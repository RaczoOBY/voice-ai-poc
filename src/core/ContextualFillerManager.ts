/**
 * ContextualFillerManager - Gera fillers contextualizados baseados em transcrições parciais
 * 
 * Fluxo:
 * 1. Recebe transcrição parcial do Scribe
 * 2. Detecta intenção/pergunta do usuário
 * 3. Gera filler contextualizado rapidamente
 * 4. Retorna filler para tocar enquanto LLM gera resposta completa
 */

import { ILLM, ITTS, TTSResult } from '../types';
import { Logger } from '../utils/Logger';
import { config } from '../config';

interface ContextualFillerConfig {
  llm: ILLM;
  tts: ITTS;
  useQuickLLM?: boolean; // Se true, usa LLM rápido para fillers. Se false, usa templates
}

export class ContextualFillerManager {
  private config: ContextualFillerConfig;
  private logger: Logger;
  private lastPartialText: string = '';
  private lastFillerText: string = '';
  private fillerCache: Map<string, TTSResult> = new Map(); // Cache de fillers gerados

  constructor(config: ContextualFillerConfig) {
    this.config = config;
    this.logger = new Logger('ContextualFiller');
  }

  /**
   * Gera um filler contextualizado baseado na transcrição parcial
   * Retorna null se não houver contexto suficiente
   */
  async generateContextualFiller(partialText: string): Promise<TTSResult | null> {
    // Limpar texto parcial
    const cleanText = partialText.trim();
    
    // Se muito curto ou igual ao anterior, retornar null
    if (cleanText.length < 10 || cleanText === this.lastPartialText) {
      return null;
    }

    this.lastPartialText = cleanText;

    // Verificar cache
    const cacheKey = this.getCacheKey(cleanText);
    if (this.fillerCache.has(cacheKey)) {
      this.logger.debug(`Cache hit para: "${cleanText.substring(0, 30)}..."`);
      return this.fillerCache.get(cacheKey)!;
    }

    try {
      // Detectar intenção/pergunta
      const intent = this.detectIntent(cleanText);
      
      // Gerar filler baseado na intenção
      let fillerText: string;
      
      if (this.config.useQuickLLM) {
        // Usar LLM rápido para gerar filler mais natural
        fillerText = await this.generateFillerWithLLM(cleanText, intent);
      } else {
        // Usar templates pré-definidos (mais rápido)
        fillerText = this.generateFillerWithTemplate(intent, cleanText);
      }

      if (!fillerText) {
        return null;
      }

      this.lastFillerText = fillerText;

      // Sintetizar áudio do filler
      const startTime = Date.now();
      const audioResult = this.config.tts.synthesizeFiller
        ? await this.config.tts.synthesizeFiller(fillerText)
        : await this.config.tts.synthesize(fillerText);
      
      const duration = Date.now() - startTime;
      this.logger.info(`🎯 Filler contextual (${duration}ms): "${fillerText}"`);

      // Cachear resultado
      this.fillerCache.set(cacheKey, audioResult);

      return audioResult;
    } catch (error) {
      this.logger.error('Erro ao gerar filler contextual:', error);
      return null;
    }
  }

  /**
   * Detecta a intenção/pergunta do usuário baseado no texto parcial
   */
  private detectIntent(text: string): 'price' | 'feature' | 'support' | 'how' | 'what' | 'when' | 'generic' {
    const lower = text.toLowerCase();

    // Preço/custo
    if (lower.includes('quanto') || lower.includes('custo') || lower.includes('preço') || 
        lower.includes('valor') || lower.includes('paga') || lower.includes('cobra')) {
      return 'price';
    }

    // Funcionalidades
    if (lower.includes('faz') || lower.includes('funciona') || lower.includes('como funciona') ||
        lower.includes('recursos') || lower.includes('funcionalidade') || lower.includes('fazer')) {
      return 'feature';
    }

    // Suporte/atendimento
    if (lower.includes('suporte') || lower.includes('atendimento') || lower.includes('ajuda') ||
        lower.includes('contato') || lower.includes('falar')) {
      return 'support';
    }

    // Como fazer algo
    if (lower.startsWith('como') || lower.includes('como fazer') || lower.includes('como usar')) {
      return 'how';
    }

    // O que é algo
    if (lower.startsWith('o que') || lower.startsWith('que é') || lower.startsWith('qual')) {
      return 'what';
    }

    // Quando
    if (lower.startsWith('quando') || lower.includes('quando')) {
      return 'when';
    }

    return 'generic';
  }

  /**
   * Gera filler usando templates do config (rápido)
   */
  private generateFillerWithTemplate(intent: string, text: string): string {
    // Mapear intenções para chaves do config
    const intentMap: Record<string, keyof typeof config.fillers.contextual> = {
      price: 'price',
      feature: 'features',
      features: 'features',
      support: 'support',
      how: 'features',
      what: 'generic',
      when: 'generic',
      robot: 'robot',
      volume: 'volume',
      generic: 'generic',
    };

    const contextualKey = intentMap[intent] || 'generic';
    const options = config.fillers.contextual[contextualKey] || config.fillers.contextual.generic;
    return options[Math.floor(Math.random() * options.length)];
  }

  /**
   * Gera filler usando LLM (mais natural, mas mais lento)
   */
  private async generateFillerWithLLM(partialText: string, intent: string): Promise<string> {
    try {
      // Usar prompts do config
      const systemPrompt = config.fillers.llmSystemPrompt;
      const userPrompt = config.fillers.llmUserPromptTemplate.replace('{partialText}', partialText);

      const response = await this.config.llm.generate([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], {
        maxTokens: 20,
        temperature: 0.7,
      });

      const filler = response.text.trim();
      
      // Garantir que termina com "..."
      if (!filler.endsWith('...')) {
        return filler + '...';
      }
      
      return filler;
    } catch (error) {
      this.logger.error('Erro ao gerar filler com LLM:', error);
      // Fallback para template
      return this.generateFillerWithTemplate(intent, partialText);
    }
  }

  /**
   * Retorna o último filler gerado (para passar como contexto ao LLM)
   */
  getLastFillerText(): string {
    return this.lastFillerText;
  }

  /**
   * Gera chave de cache baseada no texto parcial
   */
  private getCacheKey(text: string): string {
    // Usar primeiras palavras + intenção como chave
    const words = text.toLowerCase().split(/\s+/).slice(0, 3).join('_');
    const intent = this.detectIntent(text);
    return `${intent}_${words}`;
  }

  /**
   * Limpa o cache
   */
  clearCache(): void {
    this.fillerCache.clear();
    this.lastPartialText = '';
    this.lastFillerText = '';
  }
}

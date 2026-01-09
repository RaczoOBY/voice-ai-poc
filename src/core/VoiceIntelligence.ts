/**
 * VoiceIntelligence - Camada de inteligência centralizada para agentes de voz
 * 
 * Esta classe centraliza toda a lógica de "inteligência" do agente:
 * - Construção de mensagens para o LLM (com pensamentos anteriores)
 * - Geração de contexto dinâmico baseado na fase da conversa
 * - Detecção de nome do cliente
 * - Processamento de pensamentos internos (ThinkingEngine)
 * 
 * Tanto VoiceAgent (Twilio/Telnyx) quanto StreamingVoiceAgent (local) usam esta classe,
 * garantindo qualidade consistente de respostas independente do canal de I/O.
 */

import { ILLM, CallSession, AgentThoughts } from '../types';
import { Logger } from '../utils/Logger';
import { config as appConfig, generatePhaseContext } from '../config';
import { ThinkingEngine } from './ThinkingEngine';

export interface VoiceIntelligenceConfig {
  llm: ILLM;
  systemPrompt: string;
  enableThinking?: boolean;
}

export class VoiceIntelligence {
  private config: VoiceIntelligenceConfig;
  private logger: Logger;
  private thinkingEngine: ThinkingEngine | null = null;

  constructor(config: VoiceIntelligenceConfig) {
    this.config = config;
    this.logger = new Logger('VoiceIntelligence');

    // Inicializar ThinkingEngine se habilitado
    const enableThinking = config.enableThinking ?? (appConfig.thinkingEngine?.enabled ?? false);
    if (enableThinking) {
      this.thinkingEngine = new ThinkingEngine({
        llm: config.llm,
      });
      this.logger.info('🧠 ThinkingEngine habilitado');
    } else {
      this.logger.info('💭 ThinkingEngine desabilitado');
    }
  }

  /**
   * Constrói mensagens para o LLM com contexto completo
   * Inclui pensamentos anteriores para manter coerência no raciocínio
   */
  buildLLMMessages(session: CallSession): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    let systemPrompt = this.config.systemPrompt
      .replace('{prospectName}', session.prospectName || 'Ainda não coletado')
      .replace('{companyName}', session.companyName || 'Não informada')
      .replace('{context}', this.generateContext(session));

    // Adicionar pensamentos anteriores ao contexto (últimos 2)
    if (session.internalThoughts && session.internalThoughts.length > 0) {
      const recentThoughts = session.internalThoughts.slice(-2);
      const thoughtsContext = ThinkingEngine.formatThoughtsForContext(recentThoughts);
      
      if (thoughtsContext) {
        systemPrompt += `\n\n═══════════════════════════════════════════════════════════════════════════════
💭 SEUS PENSAMENTOS ANTERIORES (use para manter coerência no raciocínio):
═══════════════════════════════════════════════════════════════════════════════
${thoughtsContext}
═══════════════════════════════════════════════════════════════════════════════`;
      }
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    // Adicionar histórico recente (6 para prompt slim, 10 para normal)
    const historyLimit = appConfig.agent?.useSlimPrompt ? -6 : -10;
    const recentHistory = session.conversationHistory.slice(historyLimit);
    for (const turn of recentHistory) {
      messages.push({
        role: turn.role === 'agent' ? 'assistant' : 'user',
        content: turn.content,
      });
    }

    return messages;
  }

  /**
   * Gera contexto dinâmico baseado na fase da conversa
   * Usa as fases configuradas em config.conversationPhases
   */
  generateContext(session: CallSession): string {
    const turnCount = session.conversationHistory.length;
    const duration = Date.now() - session.startedAt.getTime();
    const hasName = !!(session.prospectName && session.prospectName !== 'Visitante' && session.prospectName.length > 2);

    let context = `Turno ${turnCount + 1}. Duração: ${Math.round(duration / 1000)}s. `;

    // Usa função do config para determinar fase atual
    const phaseContext = generatePhaseContext(turnCount, hasName, session.prospectName || 'Cliente');
    context += phaseContext;

    return context;
  }

  /**
   * Extrai nome da resposta do usuário
   * Tenta identificar padrões como "Meu nome é X", "Sou o X", "Eu sou X", etc.
   */
  extractNameFromResponse(text: string): string | null {
    const lower = text.toLowerCase().trim();
    
    // Palavras comuns que NÃO são nomes (lista expandida)
    const commonWords = [
      // Respostas curtas
      'sim', 'não', 'ok', 'tá', 'ah', 'oi', 'olá', 'bom', 'boa', 'tarde', 'dia', 'noite',
      // Conjunções e preposições
      'se', 'for', 'como', 'é', 'o', 'a', 'de', 'da', 'do', 'que', 'qual', 'quando', 'onde', 'quem',
      // Verbos comuns
      'posso', 'cair', 'tudo', 'bem', 'meu', 'minha', 'sou', 'estou', 'falo', 'fala',
      'pode', 'fazer', 'faz', 'está', 'estão', 'tem', 'têm', 'ter',
      // Preposições
      'com', 'para', 'por', 'sobre',
      // Artigos
      'um', 'uma', 'uns', 'umas',
      // Pronomes
      'eu', 'você', 'ele', 'ela', 'nós', 'eles', 'elas',
      // Outras palavras comuns
      'fogo', 'seu', 'sua', 'nosso', 'nossa',
      // Palavras que podem começar frase mas não são nomes
      'essa', 'esse', 'esta', 'este', 'aqui', 'agora', 'mesma', 'mesmo', 'aquela', 'aquele',
    ];
    
    // Padrões explícitos de apresentação (mais confiáveis)
    const explicitPatterns = [
      /(?:meu nome é|eu sou|sou o|sou a|me chamo|chamo-me|é o|é a|chamo)\s+([a-záàâãéêíóôõúç]{3,25})/i,
      /(?:fala com|está falando com|falo com)\s+([a-záàâãéêíóôõúç]{3,25})/i,
      // Padrão para "com [Nome]" no final ou meio da frase (ex: "Essa mesma noite, com Oscar")
      /,?\s*com\s+([A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,20})\.?$/i,
      // Padrão para "aqui é [Nome]" ou "aqui é o [Nome]"
      /aqui (?:é|fala)\s+(?:o\s+|a\s+)?([a-záàâãéêíóôõúç]{3,25})/i,
    ];

    for (const pattern of explicitPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        // Validar: mínimo 3 caracteres, máximo 25, e não é palavra comum
        if (name.length >= 3 && name.length <= 25 && !commonWords.includes(name.toLowerCase())) {
          // Verificar se parece nome (não é número, não tem caracteres especiais estranhos)
          if (/^[a-záàâãéêíóôõúç]+$/i.test(name)) {
            // Capitalizar primeira letra
            return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
          }
        }
      }
    }

    // Se resposta é muito curta (1 palavra) e parece ser só o nome
    const words = text.trim().split(/\s+/);
    if (words.length === 1) {
      const word = words[0];
      // Validar: mínimo 3 caracteres, máximo 20, não é palavra comum, parece nome
      if (word.length >= 3 && word.length <= 20 && 
          !commonWords.includes(word.toLowerCase()) &&
          /^[a-záàâãéêíóôõúç]+$/i.test(word)) {
        // Se começa com maiúscula ou tem 4+ caracteres, provavelmente é nome
        if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(word) || word.length >= 4) {
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        }
      }
    }

    // Procurar por palavras que parecem nomes próprios na frase
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const cleanWord = word.replace(/[.,!?;:]$/, ''); // Remove pontuação final
      const lowerWord = cleanWord.toLowerCase();
      
      // Se a palavra começa com maiúscula e tem 3+ caracteres, provavelmente é nome próprio
      if (/^[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]{2,20}$/.test(cleanWord)) {
        // Verificar se não é palavra comum
        if (!commonWords.includes(lowerWord) && /^[a-záàâãéêíóôõúç]+$/i.test(cleanWord)) {
          this.logger.debug(`✅ Nome detectado por maiúscula inicial: ${cleanWord}`);
          return cleanWord; // Já está capitalizado
        }
      }
      
      // Se a palavra tem 3+ caracteres, não é comum, e parece nome próprio
      if (cleanWord.length >= 3 && cleanWord.length <= 20 &&
          !commonWords.includes(lowerWord) &&
          /^[a-záàâãéêíóôõúç]+$/i.test(cleanWord)) {
        // Verificar se está em contexto de apresentação
        const prevWord = i > 0 ? words[i - 1].replace(/[.,!?;:]$/, '').toLowerCase() : '';
        
        // Se está após "com", "o", "a", "do", "da", "de", "seu", "sua", provavelmente é nome
        if (['com', 'o', 'a', 'do', 'da', 'de', 'seu', 'sua', 'meu', 'minha'].includes(prevWord)) {
          this.logger.debug(`✅ Nome detectado por contexto (após "${prevWord}"): ${cleanWord}`);
          return cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1).toLowerCase();
        }
        
        // Se está antes de pontuação final e tem 4+ caracteres, pode ser nome
        if (word.endsWith('.') && cleanWord.length >= 4) {
          this.logger.debug(`✅ Nome detectado no final da frase: ${cleanWord}`);
          return cleanWord.charAt(0).toUpperCase() + cleanWord.slice(1).toLowerCase();
        }
      }
    }

    return null;
  }

  /**
   * Processa pensamentos internos em paralelo
   * Não bloqueia - executa em background enquanto o áudio é reproduzido
   */
  async processThoughtsInParallel(
    session: CallSession,
    agentResponse: string
  ): Promise<void> {
    // Verificar se ThinkingEngine está habilitado
    if (!this.thinkingEngine) return;

    // Encontrar última mensagem do usuário
    const userMessages = session.conversationHistory.filter(t => t.role === 'user');
    const lastUserMessage = userMessages.length > 0 
      ? userMessages[userMessages.length - 1].content 
      : '';

    if (!lastUserMessage) return;

    const turnId = `thought-${Date.now()}`;

    try {
      const thoughts = await this.thinkingEngine.processThoughts(
        session,
        lastUserMessage,
        agentResponse,
        turnId
      );

      if (thoughts) {
        // Adicionar pensamentos à sessão
        if (!session.internalThoughts) {
          session.internalThoughts = [];
        }
        session.internalThoughts.push(thoughts);

        // Manter apenas os últimos 5 pensamentos
        if (session.internalThoughts.length > 5) {
          session.internalThoughts = session.internalThoughts.slice(-5);
        }

        this.logger.debug(`💭 Pensamentos processados para turno ${turnId}`);
        this.logger.debug(`   Objetivo: ${thoughts.strategy.currentGoal}`);
        this.logger.debug(`   Confiança: ${(thoughts.confidence * 100).toFixed(0)}%`);
      }
    } catch (error) {
      // Erro não deve interromper o fluxo principal
      this.logger.warn('Erro ao processar pensamentos (não crítico):', error);
    }
  }

  /**
   * Tenta extrair e atualizar o nome do cliente na sessão
   * Retorna true se um nome foi encontrado
   */
  tryUpdateProspectName(session: CallSession, userText: string): boolean {
    // Só tenta extrair se ainda não tem nome
    if (session.prospectName && session.prospectName !== 'Cliente' && session.prospectName.length > 2) {
      return false;
    }

    const extractedName = this.extractNameFromResponse(userText);
    if (extractedName) {
      session.prospectName = extractedName;
      this.logger.info(`✅ Nome do cliente detectado: ${extractedName}`);
      return true;
    }

    return false;
  }

  /**
   * Verifica se o ThinkingEngine está habilitado
   */
  isThinkingEnabled(): boolean {
    return this.thinkingEngine !== null;
  }

  /**
   * Detecta o estágio da conversa baseado no histórico
   * Usado para seleção de fillers e contexto
   */
  detectConversationStage(session: CallSession): 'intro' | 'qualifying' | 'presenting' | 'closing' {
    const turnCount = session.conversationHistory.length;
    
    if (turnCount <= 2) return 'intro';
    if (turnCount <= 6) return 'qualifying';
    if (turnCount <= 10) return 'presenting';
    return 'closing';
  }
}

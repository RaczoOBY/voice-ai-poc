/**
 * ThinkingEngine - Engine de pensamentos internos do agente
 * 
 * Processa metacognição em paralelo durante a reprodução do áudio,
 * registrando raciocínio estratégico, próximos passos e necessidades detectadas
 * sem afetar a latência da resposta ao usuário.
 */

import { ILLM, CallSession, AgentThoughts, ConversationTurn } from '../types';
import { Logger } from '../utils/Logger';
import { config, generatePhaseContext, generateThinkingSystemPrompt } from '../config';

interface ThinkingEngineConfig {
  llm: ILLM;
}

export class ThinkingEngine {
  private config: ThinkingEngineConfig;
  private logger: Logger;

  constructor(config: ThinkingEngineConfig) {
    this.config = config;
    this.logger = new Logger('ThinkingEngine');
  }

  /**
   * Processa pensamentos internos do agente em paralelo
   * Não bloqueia - executa em background enquanto o áudio é reproduzido
   */
  async processThoughts(
    session: CallSession,
    lastUserMessage: string,
    lastAgentResponse: string,
    turnId: string
  ): Promise<AgentThoughts | null> {
    try {
      const messages = this.buildThinkingMessages(session, lastUserMessage, lastAgentResponse);
      
      const response = await this.config.llm.generate(messages, {
        maxTokens: 400, // Aumentado para garantir JSON completo
        temperature: 0.7, // Reduzido ligeiramente para JSON mais consistente
      });

      const thoughts = this.parseThoughts(response.text, turnId);
      
      if (thoughts) {
        this.logger.debug(`💭 Pensamentos gerados para turno ${turnId}`);
        this.logger.debug(`   Objetivo: ${thoughts.strategy.currentGoal}`);
        this.logger.debug(`   Confiança: ${(thoughts.confidence * 100).toFixed(0)}%`);
      }

      return thoughts;
    } catch (error) {
      // Erro não deve interromper o fluxo principal
      this.logger.warn('Erro ao processar pensamentos (não crítico):', error);
      return null;
    }
  }

  /**
   * Constrói mensagens para o LLM gerar pensamentos
   */
  private buildThinkingMessages(
    session: CallSession,
    lastUserMessage: string,
    lastAgentResponse: string
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const turnCount = session.conversationHistory.length;
    const hasName = !!(session.prospectName && session.prospectName.length > 2);
    const phaseContext = generatePhaseContext(turnCount, hasName, session.prospectName || 'Cliente');

    // Histórico recente (últimos 4 turnos)
    const recentHistory = session.conversationHistory.slice(-4);
    const historyText = recentHistory
      .map(t => `${t.role === 'user' ? 'Usuário' : 'Agente'}: ${t.content}`)
      .join('\n');

    // Pensamentos anteriores (últimos 2) para contexto
    const previousThoughts = session.internalThoughts?.slice(-2) || [];
    const previousThoughtsText = previousThoughts.length > 0
      ? previousThoughts.map(t => 
          `- Objetivo: ${t.strategy.currentGoal}\n  Análise: ${t.userAnalysis}`
        ).join('\n')
      : 'Nenhum pensamento anterior ainda.';

    const systemPrompt = this.getThinkingSystemPrompt();
    const userPrompt = `Você acabou de responder ao usuário. Analise a situação:

ÚLTIMA MENSAGEM DO USUÁRIO: "${lastUserMessage}"

SUA RESPOSTA: "${lastAgentResponse}"

CONTEXTO DA CONVERSA:
${historyText}

FASE ATUAL: ${phaseContext}

NOME DO CLIENTE: ${session.prospectName || 'Ainda não coletado'}

PENSAMENTOS ANTERIORES:
${previousThoughtsText}

Analise profundamente:
1. O que o usuário REALMENTE quis dizer? (além do literal)
2. Qual seu objetivo atual na conversa?
3. Quais são os próximos passos estratégicos?
4. Se o usuário disser X, qual ação tomar?
5. Que necessidades você detectou no cliente?
6. Quão confiante você está na direção da conversa? (0-1)

IMPORTANTE: Retorne APENAS um JSON válido, sem texto adicional antes ou depois.
NÃO inclua markdown (blocos de código com três crases), apenas o JSON puro.

Formato obrigatório:
{
  "userAnalysis": "análise profunda do que o usuário quis dizer",
  "strategy": {
    "currentGoal": "objetivo atual na conversa",
    "nextSteps": ["passo 1", "passo 2", "passo 3"],
    "ifUserSays": [
      { "trigger": "palavra ou frase", "action": "o que fazer" }
    ]
  },
  "detectedNeeds": ["necessidade 1", "necessidade 2"],
  "confidence": 0.8
}

REGRAS CRÍTICAS:
- Use aspas duplas para strings
- Não use vírgulas finais antes de }
- Feche todas as aspas
- Use números sem aspas para confidence
- Arrays devem usar [] e objetos {}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * Prompt do sistema para geração de pensamentos
   */
  private getThinkingSystemPrompt(): string {
    // Usar prompt do config se disponível, senão usar padrão
    try {
      return generateThinkingSystemPrompt();
    } catch {
      // Fallback se função não estiver disponível
      return `Você é um sistema de raciocínio interno de uma consultora de vendas.

SEU PAPEL:
- Analisar profundamente o que o usuário disse (além do literal)
- Planejar estratégia para próximos passos
- Detectar necessidades não expressas
- Preparar contingências (se usuário disser X, fazer Y)
- Avaliar confiança na direção da conversa

FORMATO DE RESPOSTA:
Sempre retorne JSON válido com os campos especificados. Seja específico e acionável.`;
    }
  }

  /**
   * Parseia a resposta do LLM em AgentThoughts estruturado
   * Tenta múltiplas estratégias para lidar com JSONs malformados
   */
  private parseThoughts(text: string, turnId: string): AgentThoughts | null {
    try {
      // Estratégia 1: Tentar extrair JSON completo da resposta
      let jsonMatch = text.match(/\{[\s\S]*\}/);
      
      if (!jsonMatch) {
        this.logger.warn('Não encontrou JSON na resposta de pensamentos');
        return null;
      }

      let jsonText = jsonMatch[0];
      let parsed: any = null;

      // Tentar parse direto
      try {
        parsed = JSON.parse(jsonText);
      } catch (parseError) {
        // Estratégia 2: Tentar corrigir JSON comum (vírgulas finais, aspas não fechadas)
        this.logger.debug('Tentando corrigir JSON malformado...');
        
        // Remover vírgulas finais antes de }
        jsonText = jsonText.replace(/,(\s*[}\]])/g, '$1');
        
        // Tentar fechar strings não fechadas (heurística simples)
        const openQuotes = (jsonText.match(/"/g) || []).length;
        if (openQuotes % 2 !== 0) {
          // Número ímpar de aspas - tentar fechar a última string
          jsonText = jsonText.replace(/"([^"]*)$/, '"$1"');
        }

        try {
          parsed = JSON.parse(jsonText);
        } catch (secondError) {
          // Estratégia 3: Tentar extrair apenas campos essenciais com regex
          this.logger.debug('Tentando extrair campos com regex...');
          parsed = this.extractFieldsWithRegex(jsonText);
          
          if (!parsed) {
            this.logger.warn('Não foi possível parsear JSON mesmo após correções');
            this.logger.debug(`JSON problemático (primeiros 500 chars): ${jsonText.substring(0, 500)}`);
            return null;
          }
        }
      }

      // Validar estrutura mínima
      if (!parsed || (!parsed.userAnalysis && !parsed.strategy)) {
        this.logger.warn('JSON de pensamentos incompleto após parsing');
        return null;
      }

      const thoughts: AgentThoughts = {
        timestamp: new Date(),
        turnId,
        userAnalysis: parsed.userAnalysis || parsed.user_analysis || 'Análise não disponível',
        strategy: {
          currentGoal: parsed.strategy?.currentGoal || parsed.strategy?.current_goal || 'Continuar qualificação',
          nextSteps: Array.isArray(parsed.strategy?.nextSteps) 
            ? parsed.strategy.nextSteps 
            : Array.isArray(parsed.strategy?.next_steps)
            ? parsed.strategy.next_steps
            : [],
          ifUserSays: Array.isArray(parsed.strategy?.ifUserSays)
            ? parsed.strategy.ifUserSays
            : Array.isArray(parsed.strategy?.if_user_says)
            ? parsed.strategy.if_user_says
            : [],
        },
        detectedNeeds: Array.isArray(parsed.detectedNeeds)
          ? parsed.detectedNeeds
          : Array.isArray(parsed.detected_needs)
          ? parsed.detected_needs
          : [],
        confidence: typeof parsed.confidence === 'number' 
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      };

      return thoughts;
    } catch (error) {
      this.logger.warn('Erro ao parsear pensamentos:', error);
      return null;
    }
  }

  /**
   * Extrai campos do JSON usando regex quando o JSON está muito malformado
   */
  private extractFieldsWithRegex(jsonText: string): any | null {
    try {
      const result: any = {
        userAnalysis: '',
        strategy: {
          currentGoal: '',
          nextSteps: [],
          ifUserSays: [],
        },
        detectedNeeds: [],
        confidence: 0.5,
      };

      // Extrair userAnalysis
      const userAnalysisMatch = jsonText.match(/"userAnalysis"\s*:\s*"([^"]*)"/i) ||
                                jsonText.match(/"user_analysis"\s*:\s*"([^"]*)"/i);
      if (userAnalysisMatch) {
        result.userAnalysis = userAnalysisMatch[1];
      }

      // Extrair currentGoal
      const goalMatch = jsonText.match(/"currentGoal"\s*:\s*"([^"]*)"/i) ||
                        jsonText.match(/"current_goal"\s*:\s*"([^"]*)"/i);
      if (goalMatch) {
        result.strategy.currentGoal = goalMatch[1];
      }

      // Extrair confidence
      const confidenceMatch = jsonText.match(/"confidence"\s*:\s*([0-9.]+)/i);
      if (confidenceMatch) {
        result.confidence = parseFloat(confidenceMatch[1]);
      }

      // Se pelo menos userAnalysis foi extraído, retornar
      if (result.userAnalysis || result.strategy.currentGoal) {
        return result;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Formata pensamentos anteriores para incluir no contexto do LLM principal
   */
  static formatThoughtsForContext(thoughts: AgentThoughts[]): string {
    if (thoughts.length === 0) return '';

    return thoughts.map(t => {
      const lines = [
        `TURNO ${t.turnId}:`,
        `  Análise: ${t.userAnalysis}`,
        `  Objetivo: ${t.strategy.currentGoal}`,
        `  Próximos passos: ${t.strategy.nextSteps.join(', ')}`,
      ];

      if (t.detectedNeeds.length > 0) {
        lines.push(`  Necessidades: ${t.detectedNeeds.join(', ')}`);
      }

      if (t.strategy.ifUserSays.length > 0) {
        lines.push(`  Contingências:`);
        t.strategy.ifUserSays.forEach(c => {
          lines.push(`    - Se disser "${c.trigger}": ${c.action}`);
        });
      }

      return lines.join('\n');
    }).join('\n\n');
  }
}

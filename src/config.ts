/**
 * Configuração centralizada do sistema
 * 
 * ARQUITETURA MODULAR:
 * - product: Informações do produto/serviço
 * - persona: Persona do agente de voz
 * - conversation: Fases e regras da conversa
 * - agent: Prompts gerados dinamicamente a partir das configs acima
 * 
 * Para testar um novo produto/abordagem, basta alterar product, persona e conversation.
 */

import dotenv from 'dotenv';
dotenv.config();

import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';

// ============================================================================
// TIPOS
// ============================================================================

export type ExecutionMode = 'local' | 'telnyx';

// Fase da conversa (configurável)
interface ConversationPhase {
  id: string;
  name: string;
  // Condição para ativar esta fase
  condition: 'no_name' | 'has_name' | 'turn_range' | 'keyword';
  // Configuração da condição
  conditionConfig?: {
    minTurn?: number;
    maxTurn?: number;
    keywords?: string[];
  };
  // Instrução para o LLM nesta fase
  instruction: string;
}

// ============================================================================
// CONFIGURAÇÃO DO PRODUTO
// ============================================================================

const product = {
  // Nome do produto/empresa
  name: 'ZapVoice',
  
  // Descrição curta (1 frase)
  shortDescription: 'automação para WhatsApp Business',
  
  // Proposta de valor (o que o produto faz)
  valueProposition: 'ajuda empresas a automatizar o atendimento e vendas pelo WhatsApp',
  
  // Benefícios principais (usar em pitch)
  benefits: [
    'automatizar o WhatsApp',
    'aumentar vendas',
    'melhorar atendimento',
  ],
  
  // Exemplos de perguntas de qualificação
  qualificationQuestions: [
    'Você já usa alguma ferramenta de automação?',
    'Qual é o tamanho da sua equipe de vendas?',
    'Quantos atendimentos vocês fazem por dia?',
  ],
  
  // CTA (Call-to-Action) principal
  cta: 'agendar uma demonstração gratuita',
  
  // Restrições de informação
  restrictions: [
    'Nunca invente informações sobre preços específicos',
    'Diga que precisa verificar ou agendar uma conversa para detalhes de preço',
  ],
};

// ============================================================================
// CONFIGURAÇÃO DA PERSONA
// ============================================================================

const persona = {
  // Cargo/função do agente
  role: 'vendedora',
  
  // Nomes possíveis para o agente (será escolhido aleatoriamente pelo LLM)
  possibleNames: ['Ana', 'Maria', 'Taís', 'Carla', 'Julia'],
  
  // Tom de voz
  tone: 'profissional mas amigável',
  
  // Tipo de interação
  interactionType: 'ligação de prospecção',
  
  // Estilo de comunicação
  communicationStyle: {
    maxSentences: 3,           // Máximo de frases por resposta
    maxWordsPerSentence: 15,   // Máximo de palavras por frase
    alwaysEndWithQuestion: true, // Sempre terminar com pergunta
    avoidStartingWith: ['Entendi', 'Certo', 'Então', 'Perfeito', 'Ok'],
  },
};

// ============================================================================
// FASES DA CONVERSA (CONFIGURÁVEIS)
// ============================================================================

const conversationPhases: ConversationPhase[] = [
  {
    id: 'collect_name',
    name: 'Coletar nome',
    condition: 'no_name',
    instruction: `FASE: Coletar nome do cliente - você acabou de se apresentar e precisa descobrir o nome da pessoa. Pergunte educadamente: "Com quem eu estou falando?" ou "Qual seu nome?".`,
  },
  {
    id: 'introduction',
    name: 'Apresentação do produto',
    condition: 'turn_range',
    conditionConfig: { minTurn: 0, maxTurn: 2 },
    instruction: `FASE: Apresentação do produto - você já sabe o nome do cliente ({prospectName}). Agora apresente brevemente a ${product.name} e o que fazemos (${product.shortDescription}). Seja concisa (2-3 frases).`,
  },
  {
    id: 'qualification',
    name: 'Qualificação',
    condition: 'turn_range',
    conditionConfig: { minTurn: 3, maxTurn: 6 },
    instruction: `FASE: Qualificação - descubra se o cliente tem interesse, entenda as necessidades dele e responda perguntas. Use perguntas como: ${product.qualificationQuestions.slice(0, 2).join(' ou ')}`,
  },
  {
    id: 'closing',
    name: 'Fechamento',
    condition: 'turn_range',
    conditionConfig: { minTurn: 7 },
    instruction: `FASE: Fechamento - próximo passo (${product.cta}, enviar material, etc.) ou encerrar educadamente se não houver interesse.`,
  },
];

// ============================================================================
// REGRAS GERAIS DA CONVERSA
// ============================================================================

const conversationRules = {
  // Regras de resposta
  responseRules: [
    `CRÍTICO: Suas respostas devem ter NO MÁXIMO ${persona.communicationStyle.maxSentences} frases curtas. Respostas longas são proibidas.`,
    `CRÍTICO: SEMPRE termine sua resposta com uma PERGUNTA para manter a conversa fluindo.`,
    `Seja natural e conversacional, como uma ${persona.role} real fazendo ${persona.interactionType}.`,
    `Fale de forma MUITO concisa - cada frase deve ter no máximo ${persona.communicationStyle.maxWordsPerSentence} palavras.`,
    `Use o nome do cliente quando souber.`,
    `Se não souber o nome ainda, pergunte educadamente.`,
  ],
  
  // Regras de nome
  nameRules: [
    `Se o cliente mencionar um nome próprio na resposta (mesmo que não seja uma apresentação formal), reconheça e use esse nome.`,
    `Exemplos: "Seu fogo com o Oscar" → o nome é Oscar; "Fala com João" → o nome é João.`,
    `SEMPRE use um nome real para você (${persona.possibleNames.join(', ')}) - NUNCA use placeholders como [seu nome] ou [nome].`,
  ],
  
  // Regras de comportamento
  behaviorRules: [
    `Se não entender algo, peça para repetir educadamente APENAS se realmente não entender.`,
    ...product.restrictions,
    `Se a pessoa não tiver interesse, agradeça e encerre educadamente.`,
    `NÃO comece suas respostas com palavras como: ${persona.communicationStyle.avoidStartingWith.join(', ')} - vá direto ao ponto.`,
    `Mantenha o tom ${persona.tone} de uma ${persona.role}.`,
  ],
  
  // Exemplos de respostas (para few-shot learning)
  responseExamples: [
    `"Prazer, Oscar! A ${product.name} ${product.valueProposition}. ${product.qualificationQuestions[0]}"`,
    `"Ótimo! Nossa solução pode ${product.benefits[1]}. Posso te contar mais sobre como funciona?"`,
    `"Que bom! Temos planos flexíveis. ${product.qualificationQuestions[1]}"`,
  ],
};

// ============================================================================
// GERAÇÃO DINÂMICA DE PROMPTS
// ============================================================================

/**
 * Gera o system prompt baseado nas configurações
 */
function generateSystemPrompt(): string {
  const allRules = [
    ...conversationRules.responseRules,
    ...conversationRules.nameRules,
    ...conversationRules.behaviorRules,
  ];

  return `Você é uma ${persona.role} da ${product.name} fazendo uma ${persona.interactionType}. Você está ligando para apresentar ${product.shortDescription}.

FASE ATUAL DA CONVERSA:
{context}

NOME DO CLIENTE: {prospectName}
EMPRESA: {companyName}

FLUXO DA LIGAÇÃO:
1. PRIMEIRO: Coletar o nome do cliente (se ainda não souber)
2. SEGUNDO: Se apresentar brevemente como ${persona.role} da ${product.name}
3. TERCEIRO: Apresentar o produto de forma concisa (máximo 2-3 frases)
4. DEPOIS: Qualificar interesse, responder perguntas e ${product.cta} se houver interesse

REGRAS IMPORTANTES:
${allRules.map(r => `- ${r}`).join('\n')}

EXEMPLOS DE BOAS RESPOSTAS:
${conversationRules.responseExamples.map(e => `  * ${e}`).join('\n')}
`;
}

/**
 * Gera o greeting prompt baseado nas configurações
 */
function generateGreetingPrompt(): string {
  return `Você é uma ${persona.role} da ${product.name} fazendo uma ${persona.interactionType}.

FASE ATUAL: Abertura da ligação - você acabou de ligar e precisa:
1. Se apresentar brevemente como ${persona.role} da ${product.name}
2. Pedir o nome do cliente de forma educada

IMPORTANTE:
- Seja breve (máximo 2 frases)
- Não fale do produto ainda, apenas se apresente e peça o nome
- Use um tom ${persona.tone}
- SEMPRE use um nome real para você (exemplos: ${persona.possibleNames.slice(0, 3).map(n => `"Sou a ${n} da ${product.name}"`).join(' ou ')})
- NUNCA use placeholders como [seu nome] ou [nome] - sempre use um nome real
- Exemplo correto: "Olá, boa tarde! Sou a ${persona.possibleNames[0]} da ${product.name}. Com quem eu estou falando?"
- Exemplo ERRADO: "Olá, sou a [seu nome] da ${product.name}" - NÃO faça isso!

NOME DO CLIENTE: {prospectName}
EMPRESA: {companyName}`;
}

// ============================================================================
// CONFIGURAÇÃO PRINCIPAL
// ============================================================================

export const config = {
  // Modo de execução
  mode: (process.env.MODE || 'local') as ExecutionMode,

  // ========== CONFIGURAÇÕES MODULARES (EDITE AQUI PARA NOVOS PRODUTOS) ==========
  
  // Produto/Serviço
  product,
  
  // Persona do agente
  persona,
  
  // Fases da conversa
  conversationPhases,
  
  // Regras da conversa
  conversationRules,

  // ========== CONFIGURAÇÕES TÉCNICAS ==========

  // Telnyx - Telefonia (só necessário se mode === 'telnyx')
  telnyx: {
    apiKey: process.env.TELNYX_API_KEY || '',
    connectionId: process.env.TELNYX_CONNECTION_ID || '',
    phoneNumber: process.env.TELNYX_PHONE_NUMBER || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
  },

  // OpenAI - Transcrição + LLM
  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    transcriptionModel: 'whisper-1',
    llmModel: 'gpt-4o-mini' as ChatCompletionCreateParamsBase["model"],
    useRealtimeApi: false,
  },

  // STT - Speech-to-Text
  stt: {
    provider: (process.env.STT_PROVIDER || 'elevenlabs') as 'openai' | 'elevenlabs',
    elevenlabs: {
      modelId: 'scribe_v2_realtime',
      sampleRate: 16000,
      language: 'pt',
      vadSilenceThresholdMs: 300,
    },
  },

  // ElevenLabs - TTS
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY!,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pFZP5JQG7iQjIQuC4Bku',
    model: 'eleven_flash_v2_5',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.5,
    outputFormat: 'pcm_16000',
  },

  // Servidor
  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0',
  },

  // Agente - Prompts gerados dinamicamente
  agent: {
    systemPrompt: generateSystemPrompt(),
    greetingPrompt: generateGreetingPrompt(),
    maxSilenceMs: 5000,
    maxCallDurationMs: 5 * 60 * 1000,
  },

  // Fillers
  fillers: {
    generic: ['Uhum', 'Hmm', 'Ah', 'Tá', 'Aham'],
    withName: ['Tá, {name}...', 'Hmm, {name}...', '{name}...'],
    transition: ['Então', 'Bom', 'Olha'],
    clarification: ['Hmm', 'Ah'],
    contextual: {
      price: ['Sobre os valores...', 'Em relação ao preço...', 'Quanto a isso...'],
      features: ['É bem simples...', 'Funciona assim...', 'Vou te explicar...'],
      support: ['Temos uma equipe...', 'Nosso suporte...', 'Sobre atendimento...'],
      time: ['Quanto ao prazo...', 'Em relação ao tempo...', 'Geralmente leva...'],
      generic: ['Entendi...', 'Sobre isso...', 'Bom, vou explicar...', 'Deixa eu te contar...'],
    },
    llmSystemPrompt: 'Você é um assistente que gera fillers conversacionais curtos.',
    llmUserPromptTemplate: `O usuário começou a falar: "{partialText}"

Gere uma frase curta (máximo 5 palavras) que:
1. Demonstre que você entendeu a pergunta
2. Indique que você vai responder
3. Seja natural e conversacional
4. NÃO seja uma resposta completa, apenas uma introdução

Exemplos:
- Se perguntou sobre preço: "Sobre os valores..."
- Se perguntou como funciona: "É bem simples..."
- Se perguntou sobre suporte: "Temos uma equipe..."

Gere APENAS a frase, sem aspas, sem explicações:`,
  },

  // Música de fundo
  backgroundMusic: {
    enabled: true,
    volume: 0.25,
    filePath: 'src/audio/fundo.mp3',
  },

  // Métricas
  metrics: {
    alertThresholds: {
      stt: 300,
      llm: 1000,
      tts: 200,
      total: 1500,
      timeToFirstAudio: 1500,
    },
    saveDetailedMetrics: true,
    metricsPath: './metrics',
  },

  // Debug
  debug: {
    logLevel: process.env.LOG_LEVEL || 'debug',
    saveAudioChunks: false,
    audioChunksPath: './debug/audio',
  },

  // Gravação
  recording: {
    enabled: true,
    savePath: './recordings',
    saveTranscript: true,
  },
};

// ============================================================================
// FUNÇÕES HELPER
// ============================================================================

/**
 * Determina a fase atual da conversa baseado nas condições configuradas
 */
export function getCurrentPhase(turnCount: number, hasName: boolean): ConversationPhase | null {
  for (const phase of config.conversationPhases) {
    let matches = false;

    switch (phase.condition) {
      case 'no_name':
        matches = !hasName;
        break;
      case 'has_name':
        matches = hasName;
        break;
      case 'turn_range':
        const minTurn = phase.conditionConfig?.minTurn ?? 0;
        const maxTurn = phase.conditionConfig?.maxTurn ?? Infinity;
        matches = hasName && turnCount >= minTurn && turnCount <= maxTurn;
        break;
      case 'keyword':
        // Implementar detecção de keywords se necessário
        break;
    }

    if (matches) {
      return phase;
    }
  }

  // Fallback para última fase
  return config.conversationPhases[config.conversationPhases.length - 1];
}

/**
 * Gera o contexto da fase atual com placeholders substituídos
 */
export function generatePhaseContext(turnCount: number, hasName: boolean, prospectName: string): string {
  const phase = getCurrentPhase(turnCount, hasName);
  if (!phase) return '';

  return phase.instruction.replace('{prospectName}', prospectName);
}

// Validação
export function validateConfig(): void {
  const alwaysRequired = ['OPENAI_API_KEY', 'ELEVENLABS_API_KEY'];
  const telnyxRequired = ['TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'];

  let required = [...alwaysRequired];
  if (config.mode === 'telnyx') {
    required = [...required, ...telnyxRequired];
  }

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Streaming config
export const streamingConfig = {
  minCharsForTTS: 15,
  maxBufferChars: 50,
  sentenceDelimiters: ['.', '!', '?', ':', ';', ','],
};

// VAD config
export const vadConfig = {
  energyThreshold: 0.01,
  silenceDurationMs: 800,
  minSpeechDurationMs: 300,
};

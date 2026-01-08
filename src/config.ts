/**
 * Configuração centralizada do sistema - ZapVoice
 * 
 * ARQUITETURA MODULAR:
 * - product: Informações completas do produto/serviço
 * - personas: Tipos de clientes e argumentos específicos
 * - objections: Objeções comuns e respostas
 * - socialProof: Prova social e cases
 * - conversation: Fases, perguntas e regras
 * - agent: Prompts gerados dinamicamente
 * 
 * Princípio Central: "Entender para Atender" — como um médico que precisa do diagnóstico antes de prescrever.
 */

import dotenv from 'dotenv';
dotenv.config();

import { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions';

// ============================================================================
// TIPOS
// ============================================================================

export type ExecutionMode = 'local' | 'telnyx';

interface ConversationPhase {
  id: string;
  name: string;
  condition: 'no_name' | 'has_name' | 'turn_range' | 'keyword';
  conditionConfig?: {
    minTurn?: number;
    maxTurn?: number;
    keywords?: string[];
  };
  instruction: string;
}

interface QualificationQuestion {
  question: string;
  followUp: string; // Elogio/empatia após resposta
}

interface Persona {
  id: string;
  name: string;
  identifiers: string[]; // Palavras-chave para identificar
  argument: string; // Argumento específico para esta persona
}

interface Objection {
  trigger: string[]; // Palavras que ativam esta objeção
  response: string;
}

interface Plan {
  name: string;
  price: string;
  numbers: string;
  highlights: string[];
  suggestWhen: string;
}

interface Feature {
  name: string;
  description: string;
  mentionWhen: string;
}

// ============================================================================
// CONFIGURAÇÃO DO PRODUTO - ZAPVOICE
// ============================================================================

const product = {
  name: 'ZapVoice',
  
  // Proposta de valor principal
  tagline: 'Atenda mais clientes no WhatsApp, sem parecer um robô.',
  
  // Descrição curta
  shortDescription: 'automação humanizada para WhatsApp',
  
  // O que o produto faz (foco no RESULTADO, não na ferramenta)
  valueProposition: 'ajuda você a vender mais, trabalhar menos e encantar seus clientes no WhatsApp',
  
  // IMPORTANTE: ZapVoice é o MEIO, não o FIM
  // O cliente quer: mais vendas, menos trabalho manual, atendimento que encanta
  
  // Benefícios principais (o que o cliente realmente quer)
  benefits: [
    'Vender mais sem ficar preso no celular',
    'Atender 24/7 sem parecer robô',
    'Automatizar mensagens repetitivas',
    'Não perder vendas por demora',
    'Escalar o atendimento',
  ],
  
  // Diferenciais-chave
  differentials: {
    humanization: {
      title: 'Humanização',
      description: 'Os áudios não mostram "encaminhado". E antes de enviar, simula digitação — seu cliente vê "digitando..." como se fosse você.',
    },
    simplicity: {
      title: 'Simplicidade',
      description: 'É uma extensão do navegador. Instala em 2 minutos, sem software extra.',
    },
    security: {
      title: 'Segurança',
      description: 'Seus dados ficam na sua máquina. A gente não acessa suas conversas.',
    },
    freePlan: {
      title: 'Teste Grátis',
      description: 'Tem plano gratuito pra sempre. Começa sem pagar nada.',
    },
    smartFlows: {
      title: 'Fluxos Inteligentes',
      description: 'Funis condicionais que esperam a resposta do cliente. Fluxos que pensam como humano.',
    },
  },
  
  // Funcionalidades (para referenciar quando cliente perguntar)
  features: [
    { name: 'Mensagens Instantâneas', description: 'Textos, áudios, mídias com 1 clique', mentionWhen: 'Cliente reclama de repetição' },
    { name: 'Funis de Mensagens', description: 'Sequências automáticas programadas', mentionWhen: 'Cliente quer nutrir leads' },
    { name: 'Gatilhos Automáticos', description: 'Responde baseado em palavras-chave', mentionWhen: 'Cliente perde venda por demora' },
    { name: 'Fluxos Condicionais', description: 'Espera resposta antes de continuar', mentionWhen: 'Cliente quer parecer humano' },
    { name: 'Disparo em Massa', description: 'Envia pra múltiplos contatos', mentionWhen: 'Cliente quer fazer campanhas' },
    { name: 'Agendamento', description: 'Programa mensagens futuras', mentionWhen: 'Cliente esquece follow-up' },
    { name: 'Áudios Humanizados', description: 'Sem "encaminhado", simula gravação', mentionWhen: 'Cliente tem medo de robô' },
  ] as Feature[],
  
  // Planos e preços
  plans: [
    { name: 'Gratuito', price: 'R$ 0', numbers: '1', highlights: ['20 envios/dia por tipo', '5 funis/dia'], suggestWhen: 'Cliente quer só testar' },
    { name: 'Básico', price: 'R$ 49,90/mês', numbers: '1+', highlights: ['Áudios/mídias ilimitados', '15 fluxos/dia'], suggestWhen: 'Cliente precisa de mais volume' },
    { name: 'Pro', price: 'R$ 79,90/mês', numbers: '1+', highlights: ['Tudo ilimitado', 'Etiquetas', 'Zapsaver'], suggestWhen: 'Cliente quer sem limite nenhum' },
    { name: 'Anual', price: '50% OFF', numbers: '1+', highlights: ['Mesmo do mensal', 'Metade do preço'], suggestWhen: 'Cliente quer economizar' },
    { name: 'Personalizado', price: 'Sob consulta', numbers: '10+', highlights: ['Grandes operações'], suggestWhen: 'Cliente tem vários números' },
  ] as Plan[],
  
  // Mapeamento de dores → soluções
  painSolutions: {
    'responde a mesma coisa': 'Mensagens e áudios prontos resolvem isso',
    'perde venda por demora': 'Gatilhos automáticos respondem na hora',
    'parece robô': 'Áudios humanizados + simulação de digitação',
    'preso no celular': 'Automação 24/7 te libera',
    'não consegue escalar': 'Funis e fluxos inteligentes',
  },
  
  // CTA principal
  cta: 'preparar uma demonstração personalizada',
  
  // Restrições
  restrictions: [
    'Nunca invente informações sobre funcionalidades que não existem',
    'Se não souber algo específico, ofereça demonstração ou envio de material',
    'Não pressione — seu objetivo é ENTENDER, não VENDER',
  ],
};

// ============================================================================
// PERSONAS DE CLIENTES
// ============================================================================

const clientPersonas: Persona[] = [
  {
    id: 'microempreendedor',
    name: 'Microempreendedor',
    identifiers: ['trabalho sozinho', 'faço tudo', 'sou eu mesmo', 'não tenho equipe'],
    argument: 'Imagina atender com agilidade mesmo quando tá ocupado. A ZapVoice responde por você com mensagens e áudios prontos — seu cliente nem percebe que é automático.',
  },
  {
    id: 'vendedor',
    name: 'Vendedor',
    identifiers: ['vendas', 'prospecção', 'leads', 'clientes', 'fechar'],
    argument: 'Sabe aquele lead que esfria porque você demorou 10 minutos? Com gatilhos automáticos, a ZapVoice responde na hora. Você só entra pra fechar.',
  },
  {
    id: 'infoprodutor',
    name: 'Infoprodutor',
    identifiers: ['curso', 'mentoria', 'lançamento', 'infoproduto', 'digital'],
    argument: 'Na semana de lançamento, o WhatsApp explode, né? A ZapVoice aguenta o volume com funis que convertem enquanto você foca no que importa.',
  },
  {
    id: 'afiliado',
    name: 'Afiliado',
    identifiers: ['afiliado', 'produtos de terceiros', 'comissão', 'hotmart', 'monetizze'],
    argument: 'Scripts que você já usa podem virar mensagens e áudios automáticos. Mais conversões, menos trabalho repetitivo.',
  },
  {
    id: 'negocio_local',
    name: 'Negócio Local',
    identifiers: ['clínica', 'escritório', 'consultório', 'loja', 'restaurante', 'salão'],
    argument: 'Seu cliente manda mensagem às 22h? A ZapVoice responde, qualifica e agenda. Quando você chega de manhã, já tem tudo organizado.',
  },
  {
    id: 'ecommerce',
    name: 'E-commerce',
    identifiers: ['loja online', 'e-commerce', 'ecommerce', 'produto físico', 'entrega'],
    argument: 'Dúvidas sobre estoque, prazo, frete? A ZapVoice responde automaticamente. Menos carrinho abandonado, mais vendas fechadas.',
  },
];

// ============================================================================
// OBJEÇÕES COMUNS E RESPOSTAS
// ============================================================================

const objections: Objection[] = [
  {
    trigger: ['robô', 'automático', 'artificial', 'frio'],
    response: 'Os áudios não mostram "encaminhado". E a ZapVoice simula digitação antes de enviar — seu cliente vê "digitando..." como se fosse você do outro lado.',
  },
  {
    trigger: ['bloqueado', 'banido', 'WhatsApp bloquear', 'risco'],
    response: 'A ZapVoice funciona dentro do que o WhatsApp permite. A randomização de mensagens e delays naturais reduzem esse risco.',
  },
  {
    trigger: ['já tentei', 'não gostei', 'outra ferramenta', 'não funcionou'],
    response: 'Entendo. A maioria é robótica demais. Nosso diferencial é exatamente a humanização — áudios, digitação simulada, fluxos que esperam resposta.',
  },
  {
    trigger: ['difícil', 'complicado', 'não sou técnico', 'não sei usar'],
    response: 'É uma extensão de navegador. Instala em 2 minutos, tem videoaulas inclusas. Até quem não é técnico usa tranquilo.',
  },
  {
    trigger: ['business', 'whatsapp business'],
    response: 'Funciona nos dois! WhatsApp comum e Business, ambos pelo WhatsApp Web.',
  },
  {
    trigger: ['instalar', 'programa', 'software', 'baixar'],
    response: 'Não precisa instalar nada. É só uma extensão do Chrome que se conecta ao WhatsApp Web. Nada além disso.',
  },
  {
    trigger: ['preço', 'quanto custa', 'valor', 'caro'],
    response: 'Temos plano gratuito pra você testar. O básico é 49,90 e o Pro 79,90 por mês. Mas antes de falar de plano, deixa eu entender sua operação pra te indicar o melhor.',
  },
  {
    trigger: ['não tenho interesse', 'não preciso', 'não quero'],
    response: 'Sem problema! Agradeço seu tempo. Se mudar de ideia, a ZapVoice vai estar aqui. Tenha um ótimo dia!',
  },
];

// ============================================================================
// PROVA SOCIAL
// ============================================================================

const socialProof = {
  numbers: {
    users: '+100 mil empreendedores já usaram',
    activeSubscribers: '+10 mil assinantes ativos',
    dailyMessages: '+1 milhão de mensagens enviadas por dia',
    countries: 'Presente em +57 países',
  },
  testimonial: {
    quote: 'Se você vende pelo WhatsApp mas ainda não usa a ZapVoice, está deixando dinheiro na mesa.',
    author: 'Samuel Pereira',
    role: 'CEO da SDA',
  },
  brands: ['SDA (Samuel Pereira)', 'Cosmobeauty', 'Bolo da Madre'],
};

// ============================================================================
// PERSONA DO AGENTE
// ============================================================================

const persona = {
  role: 'consultora especializada em automação humanizada de WhatsApp',
  possibleNames: ['Ana', 'Maria', 'Taís', 'Carla', 'Julia'],
  
  // Tom de voz - como quem liga para um AMIGO
  tone: 'amigável e energético',
  
  interactionType: 'ligação de qualificação',
  
  // IMPORTANTE: O objetivo NÃO é vender, é ENTENDER
  objective: 'entender a operação do cliente para propor uma solução personalizada',
  
  communicationStyle: {
    maxSentences: 3,
    maxWordsPerSentence: 20,
    alwaysEndWithQuestion: true,
    // Usar primeiro nome, nunca "senhor/senhora"
    useFirstName: true,
    // Transmitir energia e alegria
    energy: 'high',
    // Intercalar elogios nas perguntas
    interspersePraise: true,
    avoidStartingWith: ['Entendi', 'Certo', 'Então', 'Perfeito', 'Ok'],
  },
};

// ============================================================================
// PERGUNTAS DE QUALIFICAÇÃO COM ELOGIOS
// ============================================================================

const qualificationQuestions: QualificationQuestion[] = [
  {
    question: 'Me conta, qual seu negócio? O que você vende ou oferece?',
    followUp: 'Legal! Esse mercado tem muito potencial quando o atendimento é bem feito.',
  },
  {
    question: 'Hoje como você atende pelo WhatsApp? Tudo manual ou já usa alguma ferramenta?',
    followUp: 'Entendi. A gente vê muito isso e sei como é cansativo ficar respondendo a mesma coisa.',
  },
  {
    question: 'Quantas mensagens você recebe por dia, mais ou menos?',
    followUp: 'Nossa, esse volume já justifica ter uma ajuda automatizada pra não perder venda.',
  },
  {
    question: 'Você trabalha sozinho ou tem equipe atendendo?',
    followUp: 'Perfeito, isso me ajuda a pensar na melhor estrutura pra você.',
  },
  {
    question: 'Já perdeu venda por demorar pra responder?',
    followUp: 'Exato, isso é mais comum do que parece. E cada minuto conta.',
  },
  {
    question: 'O que mais te toma tempo hoje no atendimento?',
    followUp: 'Faz sentido. Essas tarefas repetitivas são exatamente o que a ZapVoice resolve.',
  },
];

// Informações a coletar durante a conversa
const infoToCollect = [
  'Tipo de negócio (produto/serviço)',
  'Volume diário de mensagens',
  'Se atende sozinho ou em equipe',
  'Se já usa alguma ferramenta de automação',
  'Principais dores (tempo, perda de vendas, repetição)',
  'Quantos números de WhatsApp usa',
  'Se usa WhatsApp comum ou Business',
];

// ============================================================================
// FASES DA CONVERSA
// ============================================================================

const conversationPhases: ConversationPhase[] = [
  {
    id: 'collect_name',
    name: 'Coletar nome',
    condition: 'no_name',
    instruction: `FASE: Abertura Amigável
Você acabou de ligar e precisa descobrir o nome. 
Exemplo: "Oi, tudo bem? Aqui é a [SEU NOME] da ZapVoice! Com quem eu falo?"
IMPORTANTE: Seja animada, como quem liga pra um amigo.`,
  },
  {
    id: 'contextualize',
    name: 'Contextualizar o contato',
    condition: 'turn_range',
    conditionConfig: { minTurn: 0, maxTurn: 1 },
    instruction: `FASE: Contextualização
Você já sabe o nome ({prospectName}).
Agora contextualize o contato e quebre objeção antecipada:
"Vi que você se cadastrou com interesse em melhorar seu atendimento no WhatsApp. Pelo jeito você tá buscando uma forma de atender mais gente sem ficar preso no celular o dia todo, é isso?"

Depois: "Sei que você quer entender como funciona — e vou explicar tudo em detalhes. Só preciso antes entender melhor sua operação, pra te mostrar algo que realmente faça sentido pro seu negócio. Combinado?"`,
  },
  {
    id: 'qualification',
    name: 'Qualificação com elogios',
    condition: 'turn_range',
    conditionConfig: { minTurn: 2, maxTurn: 6 },
    instruction: `FASE: Ciclo de Perguntas + Elogios
Faça perguntas de qualificação INTERCALANDO elogios e empatia.
NUNCA faça IBGE (metralhadora de perguntas).

Perguntas disponíveis:
- "Me conta, qual seu negócio?" → "Legal! Esse mercado tem muito potencial."
- "Como você atende hoje? Manual ou usa ferramenta?" → "Sei como é cansativo."
- "Quantas mensagens por dia?" → "Esse volume já justifica automação."
- "Trabalha sozinho ou tem equipe?" → "Isso me ajuda a pensar na melhor estrutura."
- "Já perdeu venda por demora?" → "Isso é mais comum do que parece."
- "O que mais te toma tempo?" → "Essas tarefas repetitivas são o que a ZapVoice resolve."

REGRAS DE OURO:
1. Nunca faça IBGE — intercale elogios
2. Use "legal", "faz sentido", "isso é muito comum"
3. Demonstre empatia: "a gente vê muito isso", "sei como é"
4. Anote mentalmente as dores do cliente`,
  },
  {
    id: 'present_solution',
    name: 'Apresentar solução personalizada',
    condition: 'turn_range',
    conditionConfig: { minTurn: 7, maxTurn: 9 },
    instruction: `FASE: Conectar dores com soluções
Com base no que o cliente disse, conecte as DORES dele com as SOLUÇÕES da ZapVoice.

Mapeamento:
- "Respondo a mesma coisa 100x" → "Mensagens e áudios prontos resolvem isso"
- "Perco venda por demora" → "Gatilhos automáticos respondem na hora"
- "Parece robô quando automatizo" → "Áudios humanizados + digitação simulada"
- "Preso no celular" → "Automação 24/7 te libera"
- "Não consigo escalar" → "Funis e fluxos inteligentes"

Se identificou a PERSONA do cliente, use o argumento específico:
- Microempreendedor: "Atender com agilidade mesmo ocupado..."
- Vendedor: "Lead que esfria por demora..."
- Infoprodutor: "Lançamento, WhatsApp explode..."
- Negócio Local: "Cliente manda 22h, ZapVoice responde e agenda..."`,
  },
  {
    id: 'closing',
    name: 'Encerramento com próximo passo',
    condition: 'turn_range',
    conditionConfig: { minTurn: 10 },
    instruction: `FASE: Encerramento
Agradeça as informações e proponha próximo passo.

Exemplo:
"{prospectName}, muito obrigado por compartilhar isso comigo. Com essas informações vou preparar uma demonstração personalizada pra você. Posso te ligar amanhã pra mostrar na prática como funcionaria?"

Se não tiver interesse: "Sem problema! Agradeço seu tempo. Se mudar de ideia, a ZapVoice vai estar aqui. Tenha um ótimo dia!"`,
  },
];

// ============================================================================
// REGRAS GERAIS DA CONVERSA
// ============================================================================

const conversationRules = {
  // Regras de ouro (do prompt)
  goldenRules: [
    'Nunca faça IBGE — não metralhie perguntas sem conexão',
    'Intercale elogios — "legal", "faz sentido", "isso é muito comum"',
    'Use perguntas abertas — "me conta", "como funciona hoje", "o que mais te toma tempo"',
    'Demonstre empatia — "a gente vê muito isso", "sei como é cansativo"',
    'Anote tudo — essas informações constroem sua demonstração vencedora',
    'Foque na dor — automação é meio, resultado é fim',
  ],
  
  responseRules: [
    `CRÍTICO: Respostas de NO MÁXIMO ${persona.communicationStyle.maxSentences} frases curtas.`,
    `SEMPRE termine com uma PERGUNTA (exceto no encerramento).`,
    `Fale como quem liga para um AMIGO que não vê há tempo.`,
    `Use o PRIMEIRO NOME do cliente (nunca "senhor/senhora").`,
    `Transmita ENERGIA e ALEGRIA na voz.`,
    `Seja natural, jamais robótico.`,
  ],
  
  nameRules: [
    `Se o cliente mencionar um nome, use imediatamente.`,
    `Exemplos: "Fala com o Oscar" → nome é Oscar.`,
    `SEMPRE use um nome real para você (${persona.possibleNames.join(', ')}).`,
    `NUNCA use placeholders como [seu nome] ou [nome].`,
  ],
  
  behaviorRules: [
    `Seu objetivo NÃO é vender — é ENTENDER.`,
    `Você é um médico fazendo diagnóstico antes de prescrever.`,
    ...product.restrictions,
    `Se não tiver interesse, agradeça educadamente e encerre.`,
    `NÃO comece com: ${persona.communicationStyle.avoidStartingWith.join(', ')}`,
  ],
  
  // Exemplos de boas respostas
  responseExamples: [
    '"Legal, {name}! Esse mercado tem muito potencial. E como você atende hoje, tudo manual?"',
    '"Nossa, esse volume já justifica automação. Você já perdeu venda por demora?"',
    '"Faz total sentido. Essas tarefas repetitivas são exatamente o que a ZapVoice resolve."',
    '"Imagina atender com agilidade mesmo quando tá ocupado. Seu cliente nem percebe que é automático."',
  ],
};

// ============================================================================
// GERAÇÃO DINÂMICA DE PROMPTS
// ============================================================================

function generateSystemPrompt(): string {
  const allRules = [
    ...conversationRules.goldenRules,
    ...conversationRules.responseRules,
    ...conversationRules.nameRules,
    ...conversationRules.behaviorRules,
  ];

  const personaArgs = clientPersonas.map(p => `- ${p.name}: "${p.argument}"`).join('\n');
  
  const objectionResponses = objections.slice(0, 5).map(o => 
    `- Se falar "${o.trigger[0]}": "${o.response}"`
  ).join('\n');

  return `Você é uma ${persona.role} da ${product.name}. 

IDENTIDADE:
- Você é uma consultora, não uma vendedora.
- Seu objetivo NÃO é vender — é ENTENDER a operação do cliente.
- Princípio: "Entender para Atender" — como um médico que precisa do diagnóstico antes de prescrever.

PROPOSTA DE VALOR:
"${product.tagline}"
O cliente não quer ferramenta de automação. Ele quer: vender mais, trabalhar menos, encantar clientes.
${product.name} é só o MEIO, não o FIM.

FASE ATUAL DA CONVERSA:
{context}

NOME DO CLIENTE: {prospectName}
EMPRESA: {companyName}

FLUXO DA LIGAÇÃO:
1. ABERTURA AMIGÁVEL: Cumprimentar e pegar o nome
2. CONTEXTUALIZAR: "Vi que você se cadastrou..." + quebrar objeção antecipada
3. QUALIFICAÇÃO: Ciclo de perguntas + elogios (NUNCA faça IBGE)
4. CONECTAR DORES: Relacionar problemas dele com soluções ZapVoice
5. ENCERRAMENTO: Agradecer e propor demonstração personalizada

ARGUMENTOS POR TIPO DE CLIENTE:
${personaArgs}

OBJEÇÕES COMUNS:
${objectionResponses}

DIFERENCIAIS PARA MENCIONAR:
- Humanização: áudios sem "encaminhado", simula digitação
- Simplicidade: extensão de navegador, 2 minutos pra instalar
- Segurança: dados ficam na máquina do cliente
- Gratuito: tem plano free pra sempre

PROVA SOCIAL:
- ${socialProof.numbers.users}
- ${socialProof.numbers.activeSubscribers}
- "${socialProof.testimonial.quote}" — ${socialProof.testimonial.author}

REGRAS:
${allRules.map(r => `- ${r}`).join('\n')}

EXEMPLOS DE BOAS RESPOSTAS:
${conversationRules.responseExamples.map(e => `  * ${e}`).join('\n')}
`;
}

function generateGreetingPrompt(): string {
  return `Você é uma ${persona.role} da ${product.name}.

FASE: Abertura Amigável

Você acabou de ligar e precisa:
1. Cumprimentar de forma animada (como um amigo)
2. Se apresentar brevemente
3. Pedir o nome de forma natural

TOM DE VOZ:
- Fale como quem liga para um AMIGO que não vê há tempo
- Transmita ENERGIA e ALEGRIA
- Seja natural, jamais robótica

IMPORTANTE:
- Máximo 2 frases
- Use um nome real (${persona.possibleNames.slice(0, 3).join(', ')})
- NUNCA use placeholders como [seu nome]

EXEMPLO CORRETO:
"Oi, tudo bem? Aqui é a ${persona.possibleNames[0]} da ${product.name}! Com quem eu falo?"

EXEMPLO ERRADO:
"Olá, sou a [seu nome] da ${product.name}" — NÃO faça isso!

NOME DO CLIENTE: {prospectName}
EMPRESA: {companyName}`;
}

// ============================================================================
// CONFIGURAÇÃO PRINCIPAL
// ============================================================================

export const config = {
  mode: (process.env.MODE || 'local') as ExecutionMode,

  // ========== CONFIGURAÇÕES DE NEGÓCIO ==========
  
  product,
  persona,
  clientPersonas,
  objections,
  socialProof,
  qualificationQuestions,
  infoToCollect,
  conversationPhases,
  conversationRules,

  // ========== CONFIGURAÇÕES TÉCNICAS ==========

  telnyx: {
    apiKey: process.env.TELNYX_API_KEY || '',
    connectionId: process.env.TELNYX_CONNECTION_ID || '',
    phoneNumber: process.env.TELNYX_PHONE_NUMBER || '',
    webhookUrl: process.env.WEBHOOK_URL || '',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY!,
    transcriptionModel: 'whisper-1',
    llmModel: 'gpt-4o-mini' as ChatCompletionCreateParamsBase["model"],
    useRealtimeApi: false,
  },

  stt: {
    provider: (process.env.STT_PROVIDER || 'elevenlabs') as 'openai' | 'elevenlabs',
    elevenlabs: {
      modelId: 'scribe_v2_realtime',
      sampleRate: 16000,
      language: 'pt',
      vadSilenceThresholdMs: 300,
    },
  },

  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY!,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pFZP5JQG7iQjIQuC4Bku',
    model: 'eleven_flash_v2_5',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.5,
    outputFormat: 'pcm_16000',
  },

  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0',
  },

  agent: {
    systemPrompt: generateSystemPrompt(),
    greetingPrompt: generateGreetingPrompt(),
    maxSilenceMs: 5000,
    maxCallDurationMs: 5 * 60 * 1000,
  },

  fillers: {
    generic: ['Uhum', 'Hmm', 'Ah', 'Tá', 'Aham', 'Legal'],
    withName: ['Tá, {name}...', 'Hmm, {name}...', '{name}...', 'Legal, {name}...'],
    transition: ['Olha', 'Bom', 'Então'],
    clarification: ['Hmm', 'Ah'],
    empathy: ['Faz sentido...', 'Entendo...', 'Sei como é...', 'A gente vê muito isso...'],
    contextual: {
      price: ['Sobre os valores...', 'Quanto aos planos...', 'Temos opções...'],
      features: ['É bem simples...', 'Funciona assim...', 'Vou te explicar...'],
      support: ['Temos suporte...', 'A equipe ajuda...', 'Sobre atendimento...'],
      robot: ['Sobre parecer robô...', 'Quanto à humanização...'],
      volume: ['Pra esse volume...', 'Com essa demanda...'],
      generic: ['Sobre isso...', 'Bom, vou explicar...', 'Deixa eu te contar...'],
    },
    llmSystemPrompt: 'Você gera fillers conversacionais curtos e empáticos.',
    llmUserPromptTemplate: `O usuário disse: "{partialText}"

Gere uma frase curta (máximo 5 palavras) que:
1. Demonstre empatia ou que você entendeu
2. Seja natural e amigável
3. NÃO seja resposta completa

Exemplos:
- Pergunta sobre preço: "Sobre os valores..."
- Reclama de robô: "Faz total sentido..."
- Pergunta como funciona: "É bem simples..."
- Volume alto: "Pra esse volume..."

Gere APENAS a frase:`,
  },

  backgroundMusic: {
    enabled: true,
    volume: 0.25,
    filePath: 'src/audio/fundo.mp3',
  },

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

  debug: {
    logLevel: process.env.LOG_LEVEL || 'debug',
    saveAudioChunks: false,
    audioChunksPath: './debug/audio',
  },

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
 * Determina a fase atual da conversa
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
        break;
    }

    if (matches) {
      return phase;
    }
  }

  return config.conversationPhases[config.conversationPhases.length - 1];
}

/**
 * Gera o contexto da fase atual
 */
export function generatePhaseContext(turnCount: number, hasName: boolean, prospectName: string): string {
  const phase = getCurrentPhase(turnCount, hasName);
  if (!phase) return '';

  return phase.instruction.replace('{prospectName}', prospectName);
}

/**
 * Identifica a persona do cliente baseado no texto
 */
export function identifyClientPersona(text: string): Persona | null {
  const lowerText = text.toLowerCase();
  
  for (const clientPersona of config.clientPersonas) {
    for (const identifier of clientPersona.identifiers) {
      if (lowerText.includes(identifier.toLowerCase())) {
        return clientPersona;
      }
    }
  }
  
  return null;
}

/**
 * Encontra resposta para objeção
 */
export function findObjectionResponse(text: string): string | null {
  const lowerText = text.toLowerCase();
  
  for (const objection of config.objections) {
    for (const trigger of objection.trigger) {
      if (lowerText.includes(trigger.toLowerCase())) {
        return objection.response;
      }
    }
  }
  
  return null;
}

/**
 * Sugere plano baseado na conversa
 */
export function suggestPlan(wantsTest: boolean, highVolume: boolean, multipleNumbers: boolean): Plan {
  if (multipleNumbers) return config.product.plans[4]; // Personalizado
  if (wantsTest) return config.product.plans[0]; // Gratuito
  if (highVolume) return config.product.plans[2]; // Pro
  return config.product.plans[1]; // Básico
}

/**
 * Retorna próxima pergunta de qualificação
 */
export function getNextQuestion(askedCount: number): QualificationQuestion | null {
  if (askedCount >= config.qualificationQuestions.length) return null;
  return config.qualificationQuestions[askedCount];
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

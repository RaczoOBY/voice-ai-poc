/**
 * Configuração centralizada do sistema
 */

import dotenv from 'dotenv';
dotenv.config();

// Modo de execução: 'local' (microfone/speaker) ou 'telnyx' (telefonia)
export type ExecutionMode = 'local' | 'telnyx';

export const config = {
  // Modo de execução
  mode: (process.env.MODE || 'local') as ExecutionMode,

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
    // Modelo de transcrição
    transcriptionModel: 'whisper-1', // ou 'gpt-4o-transcribe' para maior precisão
    // Modelo LLM - gpt-4o-mini é mais rápido (~500-800ms vs ~1000-1500ms do gpt-4o)
    llmModel: 'gpt-4o-mini', // Menor latência, adequado para conversas simples
    useRealtimeApi: false, // Toggle para testar Realtime vs Chat Completions
  },

  // STT - Speech-to-Text
  stt: {
    // Provider: 'openai' (Whisper) ou 'elevenlabs' (Scribe - mais rápido)
    provider: (process.env.STT_PROVIDER || 'elevenlabs') as 'openai' | 'elevenlabs',
    // Configuração específica do ElevenLabs Scribe
    elevenlabs: {
      modelId: 'scribe_v2_realtime',
      sampleRate: 16000,
      language: 'pt',
      vadSilenceThresholdMs: 300, // Tempo de silêncio para detectar fim da fala (300ms = 0.3s - balance entre latência e precisão)
    },
  },

  // ElevenLabs - TTS
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY!,
    voiceId: process.env.ELEVENLABS_VOICE_ID || 'pFZP5JQG7iQjIQuC4Bku', // Voz brasileira
    model: 'eleven_flash_v2_5', // Modelo de baixa latência
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0.5,
    // Configurações de streaming
    outputFormat: 'pcm_16000', // Compatível com telefonia
  },

  // Servidor
  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0',
  },

  // Agente
  agent: {
    systemPrompt: `Você é uma vendedora da ZapVoice fazendo uma ligação de prospecção. Você está ligando para apresentar soluções de automação para WhatsApp Business.

FASE ATUAL DA CONVERSA:
{context}

NOME DO CLIENTE: {prospectName}
EMPRESA: {companyName}

FLUXO DA LIGAÇÃO:
1. PRIMEIRO: Coletar o nome do cliente (se ainda não souber)
2. SEGUNDO: Se apresentar brevemente como vendedora da ZapVoice
3. TERCEIRO: Apresentar o produto de forma concisa (máximo 2-3 frases)
4. DEPOIS: Qualificar interesse, responder perguntas e agendar demonstração se houver interesse

REGRAS IMPORTANTES:
- Seja natural e conversacional, como uma vendedora real fazendo ligação
- Fale de forma concisa (máximo 2-3 frases por vez)
- Use o nome do cliente quando souber
- Se não souber o nome ainda, pergunte educadamente: "Com quem eu estou falando?" ou "Qual seu nome?"
- IMPORTANTE: Se o cliente mencionar um nome próprio na resposta (mesmo que não seja uma apresentação formal), reconheça e use esse nome. Exemplos: "Seu fogo com o Oscar" → o nome é Oscar; "Fala com João" → o nome é João
- SEMPRE use um nome real para você (Ana, Maria, Taís, etc.) - NUNCA use placeholders como [seu nome] ou [nome]
- Se não entender algo, peça para repetir educadamente APENAS se realmente não entender - se conseguir identificar um nome, use-o e continue a conversa
- Nunca invente informações sobre preços específicos - diga que precisa verificar ou agendar uma conversa
- Se a pessoa não tiver interesse, agradeça e encerre educadamente
- NÃO comece suas respostas com palavras como "Entendi", "Certo", "Então", "Perfeito" - vá direto ao ponto
- Mantenha o tom profissional mas amigável de uma vendedora
`,
    // Tempo máximo de silêncio antes de prompt de acompanhamento (ms)
    maxSilenceMs: 5000,
    // Tempo máximo de chamada (ms)
    maxCallDurationMs: 5 * 60 * 1000, // 5 minutos
  },

  // Fillers (frases de preenchimento) - Curtos e naturais como onomatopeias
  fillers: {
    // Fillers genéricos - sons curtos e naturais (~0.2-0.5s)
    generic: [
      'Uhum',          // ~0.2s - sem reticências para soar mais natural
      'Hmm',           // ~0.2s
      'Ah',            // ~0.1s - muito curto
      'Tá',            // ~0.1s
      'Aham',          // ~0.2s
    ],
    // Templates com nome (usar {name} como placeholder)
    withName: [
      'Tá, {name}...',
      'Hmm, {name}...',
      '{name}...',
    ],
    // Fillers para transição - curtos
    transition: [
      'Então',         // ~0.3s
      'Bom',           // ~0.2s
      'Olha',          // ~0.2s
    ],
    // Fillers para clarificação - simples
    clarification: [
      'Hmm',
      'Ah',
    ],
  },

  // Métricas
  metrics: {
    // Thresholds de alerta (ms) - ajustados para latência REAL
    alertThresholds: {
      stt: 300,      // STT REAL deveria ser < 300ms (tempo até primeira parcial, não total)
      llm: 1000,     // LLM deveria ser < 1000ms
      tts: 200,      // TTS deveria ser < 200ms
      total: 1500,   // Total voice-to-voice < 1500ms (STT real + LLM + TTS)
      timeToFirstAudio: 1500, // Tempo até primeiro áudio < 1500ms
    },
    // Salvar métricas detalhadas
    saveDetailedMetrics: true,
    metricsPath: './metrics',
  },

  // Debug
  debug: {
    logLevel: process.env.LOG_LEVEL || 'info', // 'debug' | 'info' | 'warn' | 'error'
    saveAudioChunks: false, // Salvar chunks de áudio para debug
    audioChunksPath: './debug/audio',
  },
};

// Validação de configuração
export function validateConfig(): void {
  // Variáveis sempre necessárias
  const alwaysRequired = [
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
  ];

  // Variáveis necessárias apenas no modo Telnyx
  const telnyxRequired = [
    'TELNYX_API_KEY',
    'TELNYX_CONNECTION_ID',
  ];

  let required = [...alwaysRequired];
  
  // Se estiver no modo Telnyx, adiciona as variáveis de telefonia
  if (config.mode === 'telnyx') {
    required = [...required, ...telnyxRequired];
  }

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Configuração de streaming
export const streamingConfig = {
  // Mínimo de caracteres antes de enviar para TTS
  minCharsForTTS: 15,
  // Máximo de caracteres no buffer antes de forçar flush
  maxBufferChars: 50,
  // Delimitadores que forçam flush para TTS
  sentenceDelimiters: ['.', '!', '?', ':', ';', ','],
};

// Configuração de VAD (Voice Activity Detection)
export const vadConfig = {
  // Threshold de energia para detectar fala (0-1)
  energyThreshold: 0.01,
  // Duração de silêncio para considerar fim de fala (ms)
  silenceDurationMs: 800,
  // Duração mínima de fala para processar (ms)
  minSpeechDurationMs: 300,
};

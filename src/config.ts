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
    // Modelo LLM
    llmModel: 'gpt-4o', // ou usar Realtime API
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
      vadSilenceThresholdMs: 500, // Tempo de silêncio para detectar fim da fala
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
    systemPrompt: `Você é um assistente de vendas da ZapVoice, uma empresa que oferece soluções de automação para WhatsApp Business.

Seu objetivo é:
1. Apresentar-se brevemente
2. Identificar se a pessoa tem interesse em automação de atendimento
3. Qualificar o lead (tamanho da empresa, volume de mensagens, pain points)
4. Agendar uma demonstração se houver interesse

Regras:
- Seja natural e conversacional, como uma pessoa real
- Fale de forma concisa (máximo 2-3 frases por vez)
- Use o nome da pessoa quando apropriado
- Se não entender algo, peça para repetir educadamente
- Nunca invente informações sobre preços específicos
- Se a pessoa não tiver interesse, agradeça e encerre educadamente
- NÃO comece suas respostas com palavras como "Entendi", "Certo", "Então", "Perfeito" - vá direto ao ponto

Contexto atual: {context}
Nome do prospect: {prospectName}
Empresa: {companyName}
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
      'Uhum...',       // ~0.3s
      'Hmm...',        // ~0.3s
      'Ah sim...',     // ~0.5s
      'Tá...',         // ~0.2s
      'Aham...',       // ~0.3s
      'Sei...',        // ~0.3s
    ],
    // Templates com nome (usar {name} como placeholder)
    withName: [
      'Tá, {name}...',
      'Hmm, {name}...',
      '{name}...',
    ],
    // Fillers para transição - curtos
    transition: [
      'Então...',      // ~0.4s
      'Bom...',        // ~0.3s
      'Olha...',       // ~0.3s
    ],
    // Fillers para clarificação - simples
    clarification: [
      'Hmm...',
      'Ah...',
    ],
  },

  // Métricas
  metrics: {
    // Thresholds de alerta (ms)
    alertThresholds: {
      stt: 500,      // STT deveria ser < 500ms
      llm: 1000,     // LLM deveria ser < 1000ms
      tts: 200,      // TTS deveria ser < 200ms
      total: 1500,   // Total voice-to-voice < 1500ms
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

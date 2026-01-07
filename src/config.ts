/**
 * Configuração centralizada do sistema
 */

import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Telnyx - Telefonia
  telnyx: {
    apiKey: process.env.TELNYX_API_KEY!,
    connectionId: process.env.TELNYX_CONNECTION_ID!,
    phoneNumber: process.env.TELNYX_PHONE_NUMBER!, // Número brasileiro
    webhookUrl: process.env.WEBHOOK_URL!,
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

Contexto atual: {context}
Nome do prospect: {prospectName}
Empresa: {companyName}
`,
    // Tempo máximo de silêncio antes de prompt de acompanhamento (ms)
    maxSilenceMs: 5000,
    // Tempo máximo de chamada (ms)
    maxCallDurationMs: 5 * 60 * 1000, // 5 minutos
  },

  // Fillers (frases de preenchimento)
  fillers: {
    // Fillers genéricos (sem nome)
    generic: [
      'Entendi...',
      'Certo...',
      'Perfeito...',
      'Deixa eu ver...',
      'Um momento...',
      'Interessante...',
    ],
    // Templates com nome (usar {name} como placeholder)
    withName: [
      'Então {name}...',
      'Perfeito {name}, deixa eu te explicar...',
      'Entendi {name}...',
      '{name}, boa pergunta...',
    ],
    // Fillers para transição
    transition: [
      'Bom, sobre isso...',
      'Olha, na verdade...',
      'Então, basicamente...',
    ],
    // Fillers para quando não entendeu
    clarification: [
      'Desculpa, não entendi bem...',
      'Pode repetir por favor?',
      'Como assim?',
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
  const required = [
    'TELNYX_API_KEY',
    'TELNYX_CONNECTION_ID',
    'OPENAI_API_KEY',
    'ELEVENLABS_API_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

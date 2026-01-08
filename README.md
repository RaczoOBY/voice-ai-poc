# 🎙️ Voice AI Prospecting System - POC

Sistema modular de prospecção por voz com IA para automatizar ligações de vendas.

## 📋 Stack

| Componente | Provider | Função |
|------------|----------|--------|
| **Telefonia** | Telnyx | Chamadas VoIP, streaming de áudio |
| **STT** | OpenAI Whisper | Transcrição de voz para texto |
| **LLM** | OpenAI GPT-4o | Geração de respostas |
| **TTS** | ElevenLabs Flash | Síntese de voz em português BR |

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VOICE AI POC                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐                                                           │
│  │   PROSPECT   │◄──── Ligação telefônica                                   │
│  │   (Telefone) │                                                           │
│  └──────┬───────┘                                                           │
│         │                                                                   │
│         ▼                                                                   │
│  ┌──────────────┐     ┌──────────────────────────────────────────────────┐ │
│  │    TELNYX    │     │              NODE.JS SERVER                       │ │
│  │  (Telefonia) │◄───►│                                                   │ │
│  │              │     │  ┌─────────────────────────────────────────────┐ │ │
│  │ • SIP Trunk  │     │  │            VOICE AGENT                      │ │ │
│  │ • WebSocket  │     │  │                                             │ │ │
│  │ • Streaming  │     │  │  Audio In ──► STT ──► LLM ──► TTS ──► Audio │ │ │
│  └──────────────┘     │  │              │       │       │        Out   │ │ │
│                       │  │              │       │       │              │ │ │
│                       │  │              ▼       ▼       ▼              │ │ │
│                       │  │         ┌────────────────────────┐         │ │ │
│                       │  │         │   METRICS COLLECTOR    │         │ │ │
│                       │  │         │   (Latência por etapa) │         │ │ │
│                       │  │         └────────────────────────┘         │ │ │
│                       │  │                                             │ │ │
│                       │  │         ┌────────────────────────┐         │ │ │
│                       │  │         │    FILLER MANAGER      │         │ │ │
│                       │  │         │  (Áudios pré-gerados)  │         │ │ │
│                       │  │         └────────────────────────┘         │ │ │
│                       │  └─────────────────────────────────────────────┘ │ │
│                       └──────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                         EXTERNAL PROVIDERS                            │  │
│  │                                                                       │  │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           │  │
│  │  │   OPENAI     │    │   OPENAI     │    │  ELEVENLABS  │           │  │
│  │  │   Whisper    │    │   GPT-4o     │    │   Flash v2.5 │           │  │
│  │  │              │    │              │    │              │           │  │
│  │  │  ~300-500ms  │    │  ~500-800ms  │    │   ~75-150ms  │           │  │
│  │  │    (STT)     │    │    (LLM)     │    │    (TTS)     │           │  │
│  │  └──────────────┘    └──────────────┘    └──────────────┘           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## ⏱️ Pipeline de Latência

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        LATENCY PIPELINE (Target: <1500ms)                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User speaks                                                                │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────┐ Silence      ┌─────────┐         ┌─────────┐      ┌─────────┐│
│  │  Audio  │ Detection    │   STT   │         │   LLM   │      │   TTS   ││
│  │ Buffer  │──────────────►│ Whisper │─────────►│  GPT-4o │──────►│ Eleven  ││
│  └─────────┘   ~500ms     └─────────┘         └─────────┘      └─────────┘│
│                            ~300-500ms          ~500-800ms       ~75-150ms  │
│                                                                             │
│  ════════════════════════════════════════════════════════════════════════  │
│                                                                             │
│  COM FILLERS (Latência Percebida):                                         │
│                                                                             │
│  User speaks                                                                │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────┐              ┌─────────┐                                      │
│  │  Audio  │              │ FILLER  │◄─── "Entendi..." / "Então João..."   │
│  │ Buffer  │──────────────►│  AUDIO  │     (Pré-gerado, ~50ms)              │
│  └─────────┘   ~500ms     └─────────┘                                      │
│       │                        │                                           │
│       │                        ▼ (Usuário ouve filler enquanto processa)   │
│       │                                                                     │
│       ▼                                                                     │
│  ┌─────────┐         ┌─────────┐      ┌─────────┐                          │
│  │   STT   │─────────►│   LLM   │──────►│   TTS   │──► Resposta real        │
│  └─────────┘         └─────────┘      └─────────┘                          │
│                                                                             │
│  Time to First Audio: ~550ms (vs ~1300ms sem filler)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 🎯 Sistema de Fillers

Frases de preenchimento pré-geradas para mascarar latência:

### Fillers Genéricos
```
• "Entendi..."
• "Certo..."
• "Perfeito..."
• "Deixa eu ver..."
• "Um momento..."
```

### Fillers Personalizados (com nome)
```
• "Então {name}..."
• "Perfeito {name}, deixa eu te explicar..."
• "Entendi {name}..."
• "{name}, boa pergunta..."
```

### Fillers de Transição
```
• "Bom, sobre isso..."
• "Olha, na verdade..."
• "Então, basicamente..."
```

### Quando usar fillers:
1. **Sempre** após detectar fim da fala do usuário
2. Fillers com nome têm **70%** de prioridade quando nome é conhecido
3. Seleção baseada no **estágio da conversa** (intro, qualifying, presenting, closing)

## 📊 Métricas Coletadas

```javascript
{
  "latency": {
    "stt": 342,              // Tempo de transcrição
    "llm": 687,              // Tempo de geração de resposta
    "tts": 98,               // Tempo de síntese de voz
    "total": 1127,           // Tempo total voice-to-voice
    "timeToFirstAudio": 543  // Tempo até primeiro áudio (pode ser filler)
  },
  "thresholds": {
    "stt": 500,              // Alerta se > 500ms
    "llm": 1000,             // Alerta se > 1000ms
    "tts": 200,              // Alerta se > 200ms
    "total": 1500            // Alerta se > 1500ms
  }
}
```

## 🚀 Quick Start

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Editar .env com suas credenciais
```

### 3. Pré-carregar fillers
```bash
npm run preload-fillers
```

### 4. Iniciar em desenvolvimento
```bash
npm run dev
```

### 5. Fazer uma chamada de teste
```typescript
import { VoiceAgent } from './core/VoiceAgent';

const agent = new VoiceAgent(config);
await agent.start(3000);

// Iniciar chamada
const callId = await agent.makeCall('+5511999999999', {
  name: 'João',
  company: 'Empresa X'
});
```

## 📁 Estrutura do Projeto

```
voice-ai-poc/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configurações centralizadas
│   ├── types.ts              # TypeScript types
│   │
│   ├── core/
│   │   ├── VoiceAgent.ts     # Orquestrador principal
│   │   ├── FillerManager.ts  # Gerenciador de fillers
│   │   └── MetricsCollector.ts # Coletor de métricas
│   │
│   ├── providers/
│   │   ├── TelnyxProvider.ts     # Telefonia
│   │   ├── OpenAITranscriber.ts  # STT
│   │   ├── OpenAILLM.ts          # LLM
│   │   └── ElevenLabsTTS.ts      # TTS
│   │
│   └── utils/
│       └── Logger.ts         # Logging utilitário
│
├── metrics/                  # Métricas exportadas (JSON)
├── package.json
├── tsconfig.json
└── .env.example
```

## 🔄 Modularidade

O sistema foi desenhado para trocar qualquer componente facilmente:

### Trocar STT (ex: para Deepgram)
```typescript
// 1. Criar novo provider implementando ITranscriber
class DeepgramTranscriber implements ITranscriber {
  async transcribe(audio: Buffer): Promise<TranscriptionResult> {
    // Implementação Deepgram
  }
}

// 2. Usar no VoiceAgent
const agent = new VoiceAgent({
  transcriber: new DeepgramTranscriber(config),
  // ... outros providers
});
```

### Trocar LLM (ex: para Claude)
```typescript
class ClaudeLLM implements ILLM {
  async generate(messages, options): Promise<LLMResponse> {
    // Implementação Anthropic
  }
}
```

### Trocar TTS (ex: para outro provider)
```typescript
class CustomTTS implements ITTS {
  async synthesize(text: string): Promise<TTSResult> {
    // Implementação do provider
  }
}
```

## 📈 Benchmark de Latência

```bash
npm run test:latency
```

Saída esperada:
```
╔══════════════════════════════════════════════════════════════╗
║                    RELATÓRIO DE MÉTRICAS                      ║
╠══════════════════════════════════════════════════════════════╣
║ Call ID: abc123                                               ║
║ Duração: 45s | Turnos: 8                                      ║
╠══════════════════════════════════════════════════════════════╣
║                    LATÊNCIA MÉDIA                             ║
╠──────────────────────────────────────────────────────────────╣
║ STT:              342   ms ✅ OK                              ║
║ LLM:              687   ms ✅ OK                              ║
║ TTS:              98    ms ✅ Excelente                       ║
║ Total:            1127  ms ✅ OK                              ║
║ Time to Audio:    543   ms                                    ║
╠══════════════════════════════════════════════════════════════╣
║ Fillers usados:   6                                           ║
║ Rating:           GOOD                                        ║
║ Gargalo:          llm                                         ║
╠══════════════════════════════════════════════════════════════╣
║ RECOMENDAÇÕES:                                                ║
║ • Considere usar GPT-4o-mini para menor latência              ║
╚══════════════════════════════════════════════════════════════╝
```

## 🛣️ Roadmap

### Fase 1 - POC (Atual)
- [x] Arquitetura modular
- [x] Integração Telnyx + OpenAI + ElevenLabs
- [x] Sistema de fillers
- [x] Métricas de latência
- [ ] Testes end-to-end

### Fase 2 - Otimização
- [ ] Streaming STT (Realtime API)
- [ ] Streaming TTS (chunk por chunk)
- [ ] Cache de respostas comuns
- [ ] A/B testing de vozes

### Fase 3 - Produção
- [ ] Webhook seguro com verificação de assinatura
- [ ] Rate limiting e circuit breaker
- [ ] Dashboard de métricas
- [ ] Integração com CRM

## 📞 Custos Estimados

| Componente | Custo por minuto |
|------------|------------------|
| Telnyx (outbound BR) | ~$0.015 |
| OpenAI Whisper | ~$0.006 |
| OpenAI GPT-4o | ~$0.015* |
| ElevenLabs Flash | ~$0.018 |
| **Total** | **~$0.054/min** |

*Estimativa baseada em ~500 tokens por turno, 6 turnos por minuto.

## 📝 Licença

MIT

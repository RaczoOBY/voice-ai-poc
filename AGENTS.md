# Voice AI POC - Guia para Agentes

## O que é este projeto?

POC de agente de voz para prospecção automatizada via telefone. O sistema recebe/faz chamadas, transcreve a fala do usuário, gera respostas com IA e sintetiza voz para responder.

## Stack

| Componente | Provider | Função |
|------------|----------|--------|
| Telefonia | Telnyx | Chamadas VoIP, streaming de áudio |
| STT | OpenAI Whisper | Transcrição de voz para texto |
| LLM | OpenAI GPT-4o | Geração de respostas |
| TTS | ElevenLabs Flash | Síntese de voz em português BR |

## Arquitetura

```
Audio Usuario → STT → LLM → TTS → Audio Agente
                 ↓
           FillerManager (mascara latência)
                 ↓
           MetricsCollector (métricas)
```

## Arquivos Principais

| Arquivo | Descrição |
|---------|-----------|
| `src/index.ts` | Entry point, inicializa providers e agente |
| `src/core/VoiceAgent.ts` | Orquestrador principal do pipeline |
| `src/core/FillerManager.ts` | Gerencia fillers pré-gerados |
| `src/core/MetricsCollector.ts` | Coleta e analisa métricas de latência |
| `src/config.ts` | Configurações centralizadas |
| `src/types.ts` | Interfaces e tipos TypeScript |

## Providers (Modulares)

| Provider | Interface | Pode trocar por |
|----------|-----------|-----------------|
| `OpenAITranscriber` | `ITranscriber` | Deepgram, AssemblyAI |
| `OpenAILLM` | `ILLM` | Anthropic Claude, Groq |
| `ElevenLabsTTS` | `ITTS` | Cartesia, PlayHT |
| `TelnyxProvider` | `ITelephonyProvider` | Twilio, Vonage |

## Para Rodar

```bash
# 1. Configurar ambiente
cp .env.example .env
# Editar .env com suas API keys

# 2. Instalar dependências
npm install

# 3. Instalar SoX (necessário para modo local)
brew install sox portaudio  # macOS

# 4. Modo LOCAL (microfone/speaker) - Recomendado para testar
npm run local

# 5. Modo TELNYX (telefonia real)
npm run dev
```

## Variáveis de Ambiente Necessárias

- `TELNYX_API_KEY` - API key do Telnyx
- `TELNYX_CONNECTION_ID` - ID da conexão SIP
- `OPENAI_API_KEY` - API key da OpenAI
- `ELEVENLABS_API_KEY` - API key do ElevenLabs
- `WEBHOOK_URL` - URL pública para webhooks do Telnyx

## TODOs Conhecidos

- [ ] Pipeline de áudio não está totalmente integrado
- [ ] Falta verificação de assinatura do webhook
- [ ] Testes unitários não implementados
- [ ] Circuit breaker para providers externos

## Métricas de Latência (Target)

| Etapa | Threshold | Descrição |
|-------|-----------|-----------|
| STT | < 500ms | Transcrição |
| LLM | < 1000ms | Geração de resposta |
| TTS | < 200ms | Síntese de voz |
| Total | < 1500ms | Voice-to-voice |

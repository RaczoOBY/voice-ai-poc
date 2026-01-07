# Voice AI POC - Guia para Agentes

## O que é este projeto?

POC de agente de voz para prospecção automatizada via telefone. O sistema recebe/faz chamadas, transcreve a fala do usuário, gera respostas com IA e sintetiza voz para responder.

## Stack

| Componente | Provider | Função |
|------------|----------|--------|
| Telefonia | Telnyx / Local | Chamadas VoIP ou microfone/speaker |
| STT | ElevenLabs Scribe / OpenAI Whisper | Transcrição de voz (streaming ou batch) |
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

### Modo Streaming (ElevenLabs Scribe)
```
Mic → Chunks → Scribe (WebSocket) → partial_transcript
                                  → committed_transcript → LLM → TTS → Speaker
```

### Modo Batch (OpenAI Whisper)
```
Mic → VAD (energia) → Audio completo → Whisper → LLM → TTS → Speaker
```

## Arquivos Principais

| Arquivo | Descrição |
|---------|-----------|
| `src/index.ts` | Entry point modo Telnyx |
| `src/scripts/local-test.ts` | Entry point modo local (microfone) |
| `src/core/StreamingVoiceAgent.ts` | Orquestrador com suporte a streaming |
| `src/core/FillerManager.ts` | Gerencia fillers pré-gerados |
| `src/config.ts` | Configurações centralizadas |
| `src/types.ts` | Interfaces e tipos TypeScript |

## Providers (Modulares)

| Provider | Interface | Descrição |
|----------|-----------|-----------|
| `ElevenLabsScribe` | `ITranscriber` | STT streaming via WebSocket (recomendado) |
| `OpenAITranscriber` | `ITranscriber` | STT batch via Whisper API |
| `OpenAILLM` | `ILLM` | GPT-4o para respostas |
| `ElevenLabsTTS` | `ITTS` | Síntese de voz |
| `LocalAudioProvider` | `ITelephonyProvider` | Microfone/speaker local |
| `TelnyxProvider` | `ITelephonyProvider` | Telefonia VoIP |

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

## Variáveis de Ambiente

| Variável | Descrição |
|----------|-----------|
| `STT_PROVIDER` | `elevenlabs` (Scribe) ou `openai` (Whisper) |
| `OPENAI_API_KEY` | API key da OpenAI (LLM) |
| `ELEVENLABS_API_KEY` | API key do ElevenLabs (TTS + STT) |
| `TELNYX_API_KEY` | API key do Telnyx (modo telefonia) |
| `MODE` | `local` ou `telnyx` |

## Comparação STT

| Métrica | ElevenLabs Scribe | OpenAI Whisper |
|---------|-------------------|----------------|
| Latência | ~100-300ms | ~800-2000ms |
| Modo | Streaming (WebSocket) | Batch (HTTP) |
| Parciais | Sim | Não |
| VAD | Integrado | Manual |

## Métricas de Latência (Target)

| Etapa | Threshold | Descrição |
|-------|-----------|-----------|
| STT | < 300ms | Transcrição (Scribe) |
| LLM | < 1000ms | Geração de resposta |
| TTS | < 200ms | Síntese de voz |
| Total | < 1500ms | Voice-to-voice |

## TODOs

- [x] ElevenLabs Scribe para STT streaming
- [x] LocalAudioProvider com barge-in
- [x] Sistema de fillers
- [ ] Verificação de assinatura do webhook
- [ ] Testes unitários
- [ ] Circuit breaker para providers externos

#!/usr/bin/env npx tsx
/**
 * Script de teste para validar a conexão com ElevenLabs
 */

import dotenv from 'dotenv';
dotenv.config();

import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const COLORS = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

async function testElevenLabs(): Promise<void> {
  console.log(`\n${COLORS.cyan}🔊 Testando conexão com ElevenLabs...${COLORS.reset}\n`);

  // Verificar se a API key está configurada
  const apiKey = process.env.ELEVENLABS_API_KEY;
  
  console.log(`${COLORS.dim}ELEVENLABS_API_KEY: ${apiKey ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '❌ NÃO DEFINIDA'}${COLORS.reset}`);
  
  if (!apiKey) {
    console.log(`\n${COLORS.red}❌ ELEVENLABS_API_KEY não está definida no .env${COLORS.reset}`);
    console.log(`\n${COLORS.yellow}Adicione ao seu .env:${COLORS.reset}`);
    console.log(`${COLORS.cyan}ELEVENLABS_API_KEY=sua_api_key_aqui${COLORS.reset}`);
    console.log(`\nObtenha sua key em: https://elevenlabs.io/app/settings/api-keys\n`);
    process.exit(1);
  }

  try {
    // Criar cliente
    const client = new ElevenLabsClient({ apiKey });

    // Teste 1: Listar vozes
    console.log(`\n${COLORS.yellow}Teste 1: Listando vozes disponíveis...${COLORS.reset}`);
    const voices = await client.voices.getAll();
    
    console.log(`${COLORS.green}✅ Conexão OK! ${voices.voices.length} vozes encontradas${COLORS.reset}`);
    
    // Mostrar algumas vozes
    console.log(`\n${COLORS.dim}Vozes disponíveis:${COLORS.reset}`);
    voices.voices.slice(0, 50).forEach((voice, i) => {
      console.log(`  ${i + 1}. ${voice.name} (${voice.voiceId})`);
    });
    if (voices.voices.length > 5) {
      console.log(`  ... e mais ${voices.voices.length - 5} vozes`);
    }

    // Teste 2: Verificar quota
    console.log(`\n${COLORS.yellow}Teste 2: Verificando quota...${COLORS.reset}`);
    const user = await client.user.subscription.get();
    
    console.log(`${COLORS.green}✅ Quota OK!${COLORS.reset}`);
    console.log(`${COLORS.dim}  Caracteres usados: ${user.characterCount} / ${user.characterLimit}${COLORS.reset}`);
    console.log(`${COLORS.dim}  Restante: ${(user.characterLimit || 0) - (user.characterCount || 0)} caracteres${COLORS.reset}`);

    // Teste 3: Gerar um pequeno áudio (testando diferentes abordagens)
    console.log(`\n${COLORS.yellow}Teste 3: Gerando áudio de teste...${COLORS.reset}`);
    
    // Usar voz padrão da lista
    const testVoice = voices.voices[0];
    console.log(`${COLORS.dim}  Voz: ${testVoice?.name} (${testVoice?.voiceId})${COLORS.reset}`);
    
    // Tentar com fetch direto para ver o erro real
    console.log(`${COLORS.dim}  Tentando gerar áudio via fetch direto...${COLORS.reset}`);
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${testVoice?.voiceId}`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text: 'Teste.',
        model_id: 'eleven_flash_v2_5',
      }),
    });
    
    console.log(`${COLORS.dim}  Status: ${response.status} ${response.statusText}${COLORS.reset}`);
    
    if (!response.ok) {
      const errorBody = await response.text();
      console.log(`${COLORS.dim}  Erro body: ${errorBody}${COLORS.reset}`);
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }
    
    const audioBuffer = await response.arrayBuffer();
    const totalBytes = audioBuffer.byteLength;

    console.log(`${COLORS.green}✅ Áudio gerado! (${totalBytes} bytes)${COLORS.reset}`);

    // Resultado final
    console.log(`\n${COLORS.green}════════════════════════════════════════${COLORS.reset}`);
    console.log(`${COLORS.green}✅ TODOS OS TESTES PASSARAM!${COLORS.reset}`);
    console.log(`${COLORS.green}════════════════════════════════════════${COLORS.reset}`);
    console.log(`\n${COLORS.cyan}Sua configuração do ElevenLabs está correta.${COLORS.reset}`);
    console.log(`${COLORS.cyan}Rode: npm run local${COLORS.reset}\n`);

  } catch (error: any) {
    console.log(`\n${COLORS.red}❌ ERRO: ${error.message}${COLORS.reset}`);
    
    if (error.statusCode === 401) {
      console.log(`\n${COLORS.yellow}Problema: API Key inválida ou expirada${COLORS.reset}`);
      console.log(`\nSoluções:`);
      console.log(`  1. Verifique se a key está correta no .env`);
      console.log(`  2. Gere uma nova key em: https://elevenlabs.io/app/settings/api-keys`);
      console.log(`  3. Certifique-se que não há espaços extras na key`);
    } else if (error.statusCode === 429) {
      console.log(`\n${COLORS.yellow}Problema: Quota excedida${COLORS.reset}`);
      console.log(`\nSua quota mensal de caracteres foi esgotada.`);
      console.log(`Aguarde o reset ou faça upgrade do plano.`);
    } else {
      console.log(`\n${COLORS.dim}Detalhes do erro:${COLORS.reset}`);
      console.log(error);
    }
    
    process.exit(1);
  }
}

testElevenLabs();

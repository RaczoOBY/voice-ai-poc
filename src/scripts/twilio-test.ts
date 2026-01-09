#!/usr/bin/env npx tsx
/**
 * Script de teste para Twilio Voice AI
 * 
 * Faz uma chamada de teste para verificar se a integração está funcionando.
 * 
 * Uso: 
 *   npm run twilio:test              # Usa TWILIO_TEST_NUMBER do .env
 *   npm run twilio:test +5511999999999  # Número específico
 * 
 * Variáveis necessárias no .env:
 *   - TWILIO_ACCOUNT_SID
 *   - TWILIO_AUTH_TOKEN
 *   - TWILIO_PHONE_NUMBER
 */

import { config, validateConfig } from '../config';
import { TwilioProvider } from '../providers/TwilioProvider';
import { Logger } from '../utils/Logger';

const logger = new Logger('TwilioTest');

// Cores para o terminal
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function printBanner(): void {
  console.clear();
  console.log(`
${COLORS.cyan}╔══════════════════════════════════════════════════════════════╗
║${COLORS.bright}              VOICE AI POC - TESTE TWILIO                      ${COLORS.reset}${COLORS.cyan}║
╠══════════════════════════════════════════════════════════════╣
║${COLORS.reset} Este script faz uma chamada de teste via Twilio             ${COLORS.cyan}║
║${COLORS.reset} Pressione ${COLORS.yellow}CTRL+C${COLORS.reset} para cancelar                               ${COLORS.cyan}║
╚══════════════════════════════════════════════════════════════╝${COLORS.reset}
`);
}

function printConfig(): void {
  console.log(`${COLORS.blue}📋 Configuração:${COLORS.reset}`);
  console.log(`   Account SID: ${config.twilio.accountSid.substring(0, 10)}...`);
  console.log(`   Phone From:  ${config.twilio.phoneNumber}`);
  console.log(`   Webhook URL: ${config.twilio.webhookUrl || '(não configurado)'}`);
  console.log('');
}

async function testConnection(): Promise<boolean> {
  console.log(`${COLORS.yellow}🔍 Testando conexão com a API Twilio...${COLORS.reset}`);
  
  try {
    // Fazer uma requisição simples para verificar credenciais
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}.json`;
    const credentials = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${credentials}`,
      },
    });

    if (response.ok) {
      const data = await response.json() as { friendly_name: string; status: string };
      console.log(`${COLORS.green}✅ Conexão OK!${COLORS.reset}`);
      console.log(`   Account Name: ${data.friendly_name}`);
      console.log(`   Status: ${data.status}`);
      console.log('');
      return true;
    } else {
      const error = await response.text();
      console.log(`${COLORS.red}❌ Erro de autenticação: ${response.status}${COLORS.reset}`);
      console.log(`   ${error}`);
      return false;
    }
  } catch (error) {
    console.log(`${COLORS.red}❌ Erro de conexão: ${error}${COLORS.reset}`);
    return false;
  }
}

async function makeTestCall(toNumber: string): Promise<void> {
  console.log(`${COLORS.yellow}📞 Iniciando chamada para ${toNumber}...${COLORS.reset}`);
  
  const provider = new TwilioProvider(config.twilio);
  
  try {
    const callSid = await provider.makeCall(toNumber);
    console.log(`${COLORS.green}✅ Chamada iniciada!${COLORS.reset}`);
    console.log(`   Call SID: ${callSid}`);
    console.log('');
    console.log(`${COLORS.cyan}ℹ️  A chamada foi iniciada. Verifique seu telefone!${COLORS.reset}`);
    console.log(`${COLORS.dim}   Para ver os logs em tempo real, configure o WEBHOOK_URL${COLORS.reset}`);
    console.log(`${COLORS.dim}   e execute o servidor: npm run dev${COLORS.reset}`);
    
    // Aguardar um pouco para mostrar status
    console.log('');
    console.log(`${COLORS.yellow}⏳ Aguardando 10 segundos para verificar status...${COLORS.reset}`);
    
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Verificar status da chamada
    try {
      const callInfo = await provider.getCallInfo(callSid);
      console.log(`${COLORS.blue}📊 Status da chamada:${COLORS.reset}`);
      console.log(`   Status: ${callInfo.status}`);
      console.log(`   Direction: ${callInfo.direction}`);
      if (callInfo.duration) {
        console.log(`   Duração: ${callInfo.duration}s`);
      }
    } catch (error) {
      console.log(`${COLORS.dim}   (não foi possível obter status)${COLORS.reset}`);
    }
    
  } catch (error) {
    console.log(`${COLORS.red}❌ Erro ao fazer chamada:${COLORS.reset}`);
    console.log(`   ${error}`);
  }
}

async function simpleApiTest(toNumber: string): Promise<void> {
  console.log(`${COLORS.yellow}📞 Fazendo chamada de teste simples (TwiML de voz)...${COLORS.reset}`);
  
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Calls.json`;
    const credentials = Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
    
    // TwiML simples que fala uma mensagem
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="pt-BR" voice="Polly.Camila">
    Olá! Este é um teste do sistema Voice AI. Se você está ouvindo esta mensagem, a integração com a Twilio está funcionando corretamente. Obrigado!
  </Say>
  <Pause length="2"/>
  <Say language="pt-BR" voice="Polly.Camila">
    Encerrando a chamada de teste. Até logo!
  </Say>
</Response>`;

    const params = new URLSearchParams({
      To: toNumber,
      From: config.twilio.phoneNumber,
      Twiml: twiml,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (response.ok) {
      const data = await response.json() as { sid: string; status: string };
      console.log(`${COLORS.green}✅ Chamada iniciada!${COLORS.reset}`);
      console.log(`   Call SID: ${data.sid}`);
      console.log(`   Status: ${data.status}`);
      console.log('');
      console.log(`${COLORS.cyan}📱 Verifique seu telefone! Você receberá uma chamada em breve.${COLORS.reset}`);
    } else {
      const error = await response.text();
      console.log(`${COLORS.red}❌ Erro ao fazer chamada: ${response.status}${COLORS.reset}`);
      console.log(`   ${error}`);
    }
  } catch (error) {
    console.log(`${COLORS.red}❌ Erro: ${error}${COLORS.reset}`);
  }
}

async function main(): Promise<void> {
  printBanner();
  
  // Validar configuração
  try {
    validateConfig();
  } catch (error) {
    console.log(`${COLORS.red}❌ Erro de configuração: ${error}${COLORS.reset}`);
    console.log(`${COLORS.yellow}   Verifique se as variáveis TWILIO_* estão no .env${COLORS.reset}`);
    process.exit(1);
  }

  // Verificar se modo é twilio
  if (config.mode !== 'twilio') {
    console.log(`${COLORS.yellow}⚠️  MODE não está configurado como 'twilio'${COLORS.reset}`);
    console.log(`   Atual: MODE=${config.mode}`);
    console.log(`   Continuando mesmo assim...`);
    console.log('');
  }

  printConfig();
  
  // Testar conexão
  const connected = await testConnection();
  if (!connected) {
    console.log(`${COLORS.red}❌ Não foi possível conectar à API Twilio${COLORS.reset}`);
    process.exit(1);
  }

  // Obter número de destino
  const toNumber = process.argv[2] || process.env.TWILIO_TEST_NUMBER;
  
  if (!toNumber) {
    console.log(`${COLORS.yellow}⚠️  Nenhum número de destino fornecido${COLORS.reset}`);
    console.log('');
    console.log(`   Uso: npm run twilio:test +5511999999999`);
    console.log(`   Ou defina TWILIO_TEST_NUMBER no .env`);
    console.log('');
    console.log(`${COLORS.green}✅ Teste de conexão concluído com sucesso!${COLORS.reset}`);
    console.log(`   A API Twilio está funcionando corretamente.`);
    process.exit(0);
  }

  console.log(`${COLORS.blue}📱 Número de destino: ${toNumber}${COLORS.reset}`);
  console.log('');

  // Perguntar qual tipo de teste
  console.log(`${COLORS.cyan}Escolha o tipo de teste:${COLORS.reset}`);
  console.log(`   1. Chamada simples (TwiML com voz Polly) - Recomendado para primeiro teste`);
  console.log(`   2. Chamada com Media Stream (integração completa)`);
  console.log('');
  
  // Fazer chamada com Media Stream (conecta com a IA)
  console.log(`${COLORS.green}Executando chamada com Media Stream (IA completa)...${COLORS.reset}`);
  console.log('');
  
  await makeTestCall(toNumber);
}

main().catch((error) => {
  console.error(`${COLORS.red}Erro fatal:${COLORS.reset}`, error);
  process.exit(1);
});

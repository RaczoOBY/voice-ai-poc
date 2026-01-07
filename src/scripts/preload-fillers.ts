#!/usr/bin/env npx tsx
/**
 * Script para pré-carregar fillers de áudio
 * 
 * Gera todos os áudios de fillers usando ElevenLabs TTS
 * e salva em cache para uso durante as chamadas.
 * 
 * Uso: npm run preload-fillers
 */

import { config, validateConfig } from '../config';
import { ElevenLabsTTS } from '../providers/ElevenLabsTTS';
import { FillerManager } from '../core/FillerManager';
import { Logger } from '../utils/Logger';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const logger = new Logger('PreloadFillers');

async function main() {
  logger.info('🚀 Iniciando pré-carregamento de fillers...');
  
  try {
    // Validar configuração
    validateConfig();
    logger.info('✅ Configuração validada');

    // Inicializar TTS
    const tts = new ElevenLabsTTS(config.elevenlabs);
    logger.info('✅ ElevenLabs TTS inicializado');

    // Warmup da conexão
    logger.info('🔥 Aquecendo conexão com ElevenLabs...');
    await tts.warmup();

    // Criar FillerManager e carregar fillers
    const fillerManager = new FillerManager(tts);
    
    const startTime = Date.now();
    await fillerManager.preloadFillers();
    const duration = Date.now() - startTime;

    // Obter estatísticas
    const stats = fillerManager.getStats();
    
    logger.info('');
    logger.info('╔══════════════════════════════════════════════════════════════╗');
    logger.info('║              FILLERS PRÉ-CARREGADOS COM SUCESSO              ║');
    logger.info('╠══════════════════════════════════════════════════════════════╣');
    logger.info(`║ Genéricos:        ${stats.generic.toString().padEnd(42)} ║`);
    logger.info(`║ Transição:        ${stats.transition.toString().padEnd(42)} ║`);
    logger.info(`║ Clarificação:     ${stats.clarification.toString().padEnd(42)} ║`);
    logger.info(`║ Duração total:    ${(stats.totalAudioDuration).toFixed(1)}s de áudio`.padEnd(61) + ' ║');
    logger.info(`║ Tempo de geração: ${duration}ms`.padEnd(61) + ' ║');
    logger.info('╚══════════════════════════════════════════════════════════════╝');
    logger.info('');

    // Opcionalmente, pré-gerar para nomes comuns
    const commonNames = ['João', 'Maria', 'Pedro', 'Ana', 'Carlos'];
    
    logger.info('🔄 Gerando fillers para nomes comuns...');
    for (const name of commonNames) {
      await fillerManager.preloadFillersForName(name);
    }
    
    logger.info(`✅ Fillers personalizados gerados para ${commonNames.length} nomes`);
    logger.info('');
    logger.info('🎉 Pré-carregamento concluído! O sistema está pronto para uso.');

  } catch (error) {
    logger.error('❌ Erro durante pré-carregamento:', error);
    process.exit(1);
  }
}

main();

/**
 * Logger - Utilitário de logging com cores e níveis
 */

import { config } from '../config';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  
  // Foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

export class Logger {
  private context: string;
  private minLevel: number;

  constructor(context: string) {
    this.context = context;
    this.minLevel = LOG_LEVELS[config.debug.logLevel as LogLevel] || LOG_LEVELS.info;
  }

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString().substring(11, 23); // HH:mm:ss.SSS
  }

  private log(level: LogLevel, message: string, ...args: any[]): void {
    if (LOG_LEVELS[level] < this.minLevel) {
      return;
    }

    const timestamp = this.formatTimestamp();
    const levelColors: Record<LogLevel, string> = {
      debug: COLORS.gray,
      info: COLORS.cyan,
      warn: COLORS.yellow,
      error: COLORS.red,
    };

    const levelStr = level.toUpperCase().padEnd(5);
    const prefix = `${COLORS.dim}${timestamp}${COLORS.reset} ${levelColors[level]}${levelStr}${COLORS.reset} ${COLORS.magenta}[${this.context}]${COLORS.reset}`;

    if (args.length > 0) {
      console.log(prefix, message, ...args);
    } else {
      console.log(prefix, message);
    }
  }

  debug(message: string, ...args: any[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: any[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: any[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: any[]): void {
    this.log('error', message, ...args);
  }

  /**
   * Log com medição de tempo
   */
  time(label: string): () => void {
    const start = Date.now();
    this.debug(`⏱️ ${label} - iniciado`);
    
    return () => {
      const duration = Date.now() - start;
      this.info(`⏱️ ${label} - ${duration}ms`);
    };
  }

  /**
   * Log de métricas de latência formatado
   */
  latency(stage: string, durationMs: number, threshold?: number): void {
    const status = threshold 
      ? (durationMs <= threshold ? '✅' : '⚠️')
      : '📊';
    
    const color = threshold && durationMs > threshold ? COLORS.yellow : COLORS.green;
    
    this.info(`${status} ${stage}: ${color}${durationMs}ms${COLORS.reset}`);
  }
}

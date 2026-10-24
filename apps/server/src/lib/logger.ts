import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import type { AppConfig } from '../config/schema.js';

/** 日志配置：level 控制安静程度，pretty 仅在开发期打开（生产用 JSON 便于采集）。 */
export interface LoggerConfig {
  level: string;
  pretty: boolean;
}

/**
 * 日志里绝不能出现的东西。
 *
 * 酒馆类应用的核心资产是用户的 API Key 与大量私密对话，
 * 这些字段一旦进日志就等于泄露，所以在 pino 层做统一遮罩，
 * 而不是指望每个调用点记得脱敏。
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.password',
  '*.token',
];

/** 创建 pino 实例。全进程只应创建一次，然后通过 Fastify 的 loggerInstance 复用。 */
export function createLogger(config: LoggerConfig = { level: 'info', pretty: false }): Logger {
  const base: LoggerOptions = {
    level: config.level,
    base: { name: 'tavern' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };

  if (!config.pretty) {
    return pino(base);
  }

  return pino({
    ...base,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname,name',
        singleLine: false,
      },
    },
  });
}

/** 供扩展点/测试使用的最小日志接口，避免各处直接依赖 pino 类型。 */
export type AppLogger = Logger;

/**
 * 从应用配置推导日志配置。
 *
 * pretty 留空时按环境推导：development 开彩色，production 走纯 JSON
 * （容器日志采集需要单行结构化，彩色控制符是纯噪音）。
 */
export function loggerConfigFromApp(config: AppConfig): LoggerConfig {
  return {
    level: config.logging.level,
    pretty: config.logging.pretty ?? config.app.env !== 'production',
  };
}

import { createLogger, format, transports, Logger as WinstonLogger } from 'winston';
import 'winston-daily-rotate-file';
import { join } from 'path';

// Define custom log format
const { combine, timestamp, printf, json, colorize, errors } = format;

// Custom format for development
const devFormat = printf(({ level, message, timestamp, stack, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;

  // If there's an error stack, print it
  if (stack) {
    msg += `\n${stack}`;
  }

  // If there are other metadata properties, print them
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata, null, 2)}`;
  }

  return msg;
});

// Create logs directory path
const logsDir = join(process.cwd(), 'logs');

/**
 * File logging is opt-in via LOG_TO_FILE=true.
 *
 * On a container platform the filesystem is ephemeral, so rotated log files
 * are lost on every deploy and cost disk in the meantime. Only enable this
 * when running somewhere with persistent storage, such as a VPS.
 */
const logToFile = process.env.LOG_TO_FILE === 'true';

const isProduction = process.env.NODE_ENV === 'production';

const activeTransports: NonNullable<Parameters<typeof createLogger>[0]>['transports'] = [
  // stdout is always attached. Hosting platforms capture stdout and show it in
  // their log viewer; without this a production deploy produces no visible
  // logs at all.
  new transports.Console({
    format: isProduction ? json() : combine(colorize(), devFormat),
  }),
];

if (logToFile) {
  activeTransports.push(
    new transports.DailyRotateFile({
      filename: join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: json(), // Always store JSON in files
    })
  );
}

// Create the logger instance
const winstonInstance = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    errors({ stack: true }) // Handle errors gracefully
  ),
  defaultMeta: { service: 'tldreply-bot' },
  transports: activeTransports,
});

// Wrapper class to maintain compatibility with existing code
class LoggerWrapper {
  private logger: WinstonLogger;

  constructor() {
    this.logger = winstonInstance;
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.logger.info(message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.logger.warn(message, metadata);
  }

  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void {
    const meta = { ...metadata };

    if (error instanceof Error) {
      this.logger.error(message, { ...meta, error, stack: error.stack });
    } else if (error) {
      this.logger.error(message, { ...meta, error: String(error) });
    } else {
      this.logger.error(message, meta);
    }
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.logger.debug(message, metadata);
  }
}

export const logger = new LoggerWrapper();

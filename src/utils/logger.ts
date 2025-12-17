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

// Create the logger instance
const winstonInstance = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    errors({ stack: true }), // Handle errors gracefully
    process.env.NODE_ENV !== 'production' ? format.simple() : json()
  ),
  defaultMeta: { service: 'tldreply-bot' },
  transports: [
    // File transport - Daily rotation
    new transports.DailyRotateFile({
      filename: join(logsDir, 'app-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: json(), // Always store JSON in files
    }),
  ],
});

// Add console transport if not in production
if (process.env.NODE_ENV !== 'production') {
  winstonInstance.add(
    new transports.Console({
      format: combine(colorize(), devFormat),
    })
  );
}

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

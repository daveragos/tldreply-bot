import http from 'http';
import { Database } from '../db/database';
import { config } from '../config';
import { logger } from './logger';
import { geminiPoolSize } from '../services/geminiPool';

/**
 * Optional HTTP health endpoint.
 *
 * A long-polling Telegram bot serves no HTTP, so on a platform that classifies
 * it as a "web service" the health check never passes and the container is
 * killed. Deploying as a background worker is the correct answer, but binding
 * a port when one is offered costs nothing and makes either deployment mode
 * work.
 *
 * Starts only when PORT is set, so local runs and worker deployments are
 * unaffected.
 *
 * Endpoints:
 *   GET /        liveness - the process is up
 *   GET /health  readiness - includes a database round trip
 */
export class HealthServer {
  private server: http.Server | null = null;
  private db: Database;
  private startedAt = Date.now();

  constructor(db: Database) {
    this.db = db;
  }

  start(): void {
    const port = process.env.PORT;
    if (!port) {
      logger.info('No PORT set; running without an HTTP health endpoint');
      return;
    }

    const portNumber = Number.parseInt(port, 10);
    if (Number.isNaN(portNumber)) {
      logger.warn(`PORT is not a number ("${port}"); skipping the health endpoint`);
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });

    this.server.on('error', error => {
      logger.error('Health server error:', error);
    });

    // 0.0.0.0, not localhost: a health check arrives from outside the container
    // and would never reach a loopback-only listener.
    this.server.listen(portNumber, '0.0.0.0', () => {
      logger.info(`🩺 Health endpoint listening on 0.0.0.0:${portNumber}`);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);

    // Liveness: cheap, no dependencies. Answers "is the process alive".
    if (req.url === '/' || req.url === '/healthz') {
      send(200, { status: 'ok', uptimeSeconds });
      return;
    }

    // Readiness: touches the database, so it can legitimately fail.
    if (req.url === '/health') {
      try {
        const connected = await this.db.testConnection();
        if (!connected) {
          send(503, { status: 'degraded', database: 'unreachable', uptimeSeconds });
          return;
        }

        const bytes = await this.db.getDatabaseSizeBytes();
        const usedMb = Math.round(bytes / (1024 * 1024));

        send(200, {
          status: 'ok',
          uptimeSeconds,
          database: {
            connected: true,
            usedMb,
            limitMb: config.databaseSoftLimitMb,
            percentUsed: Math.round((usedMb / config.databaseSoftLimitMb) * 100),
          },
          geminiClientsPooled: geminiPoolSize(),
          retentionHours: config.messageRetentionHours,
        });
      } catch (error) {
        logger.error('Health check failed:', error);
        send(503, { status: 'error', uptimeSeconds });
      }
      return;
    }

    send(404, { error: 'not found' });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    await new Promise<void>(resolve => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }
}

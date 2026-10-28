/**
 * The platform's own health, in one place.
 *
 * The containers restart on their own, so a crash is not what breaks a
 * platform — a crash nobody notices is. This is what answers "is the
 * platform working, and is the WhatsApp session up?" so that a watchdog
 * — or an external uptime monitor — can ask without knowing anything
 * about the platform's internals.
 *
 * The endpoint is public on purpose: a monitor has no credential, and
 * nothing in the answer is secret.
 */

import fs from 'node:fs';
import path from 'node:path';

import { platformRepository } from '../repository/platform.repository';

export type HealthState = 'ok' | 'degraded' | 'down';

export interface PlatformStatus {
  /** The overall answer. */
  state: HealthState;
  /** What is wrong, when something is. */
  problems: string[];
  checkedAt: string;
  checks: {
    database: { state: HealthState; detail: string };
    redis: { state: HealthState; detail: string };
    whatsapp: {
      state: HealthState;
      /** The instance public id, when one is connected. */
      instancePublicId: string | null;
      /** The number it is signed in as, when it is. */
      phoneNumber: string | null;
      connectedInstances: number;
      totalInstances: number;
    };
    queue: { state: HealthState; queued: number; processing: number; failed: number };
    disk: { state: HealthState; freeGb: number; usedPercent: number };
    backup: { state: HealthState; ageHours: number | null; path: string | null };
  };
}

/** Where the daily database backup lands. */
const BACKUP_DIR = '/home/whatsapp/backups';

export class PlatformStatusService {
  /**
   * Everything, in one call.
   *
   * Each check is independent: one that fails does not stop the others,
   * because the point is to say WHICH thing is wrong.
   */
  public async check(): Promise<PlatformStatus> {
    const problems: string[] = [];

    const database = await this.checkDatabase(problems);
    const redis = await this.checkRedis(problems);
    const whatsapp = await this.checkWhatsApp(problems);
    const queue = await this.checkQueue(problems);
    const disk = this.checkDisk(problems);
    const backup = this.checkBackup(problems);

    const worst: HealthState =
      database.state === 'down' || redis.state === 'down' ? 'down' : problems.length ? 'degraded' : 'ok';

    return {
      state: worst,
      problems,
      checkedAt: new Date().toISOString(),
      checks: { database, redis, whatsapp, queue, disk, backup },
    };
  }

  private async checkDatabase(problems: string[]): Promise<PlatformStatus['checks']['database']> {
    try {
      const started = Date.now();
      await platformRepository.$queryRaw`SELECT 1`;
      return { state: 'ok', detail: `answered in ${Date.now() - started}ms` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`The database is not answering: ${detail}`);
      return { state: 'down', detail };
    }
  }

  private async checkRedis(problems: string[]): Promise<PlatformStatus['checks']['redis']> {
    try {
      const started = Date.now();
      // The session store lives in Redis; if it is down, nobody can sign
      // in and every session cookie is dead. A socket check is enough —
      // the point is that it accepts a connection.
      const net = await import('node:net');
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: 'platform-redis', port: 6379 });
        socket.on('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.setTimeout(3000, () => {
          socket.destroy();
          reject(new Error('timed out'));
        });
      });

      return { state: 'ok', detail: `answered in ${Date.now() - started}ms` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`Redis is not answering: ${detail}`);
      return { state: 'down', detail };
    }
  }

  private async checkWhatsApp(problems: string[]): Promise<PlatformStatus['checks']['whatsapp']> {
    const empty = {
      state: 'down' as HealthState,
      instancePublicId: null,
      phoneNumber: null,
      connectedInstances: 0,
      totalInstances: 0,
    };

    try {
      const instances = await platformRepository.platformInstance.findMany({
        select: { publicId: true, status: true, phoneNumber: true },
      });
      const connected = instances.filter((i) => i.status === 'CONNECTED');
      const first = connected[0];

      if (instances.length === 0) {
        return { ...empty, state: 'degraded' };
      }
      if (connected.length === 0) {
        problems.push(`No WhatsApp session is connected — ${instances.length} instance(s) exist and none is up.`);
        return {
          ...empty,
          state: 'degraded',
          totalInstances: instances.length,
        };
      }

      return {
        state: 'ok',
        instancePublicId: first?.publicId ?? null,
        phoneNumber: first?.phoneNumber ?? null,
        connectedInstances: connected.length,
        totalInstances: instances.length,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`Could not read the WhatsApp sessions: ${detail}`);
      return { ...empty };
    }
  }

  private async checkQueue(problems: string[]): Promise<PlatformStatus['checks']['queue']> {
    try {
      // Only the recent past counts. A message that failed last week does
      // not make the platform degraded today, and a check that stays
      // degraded forever is a check nobody reads.
      const since = new Date(Date.now() - 60 * 60 * 1000);
      const grouped = await platformRepository.platformMessageCommand.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      });
      const counts: Record<string, number> = {};
      for (const row of grouped) {
        counts[row.status] = row._count._all;
      }

      const queued = counts.queued ?? 0;
      const processing = counts.processing ?? 0;
      const failed = counts.failed ?? 0;

      // A big backlog is worth knowing about, but it is not a fault on
      // its own — a broadcast queues thousands on purpose.
      const state: HealthState = failed > 0 ? 'degraded' : 'ok';
      if (failed > 0) {
        problems.push(`${failed} message(s) failed permanently.`);
      }

      return { state, queued, processing, failed };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`Could not read the message queue: ${detail}`);
      return { state: 'down', queued: 0, processing: 0, failed: 0 };
    }
  }

  private checkDisk(problems: string[]): PlatformStatus['checks']['disk'] {
    try {
      const stats = fs.statfsSync('/');
      const totalGb = stats.blocks * stats.bsize;
      const freeGb = stats.bavail * stats.bsize;
      const usedPercent = Math.round(((totalGb - stats.bfree * stats.bsize) / totalGb) * 100);

      if (usedPercent > 90) {
        problems.push(`The disk is ${usedPercent}% full.`);
        return { state: 'degraded', freeGb: round(freeGb), usedPercent };
      }
      return { state: 'ok', freeGb: round(freeGb), usedPercent };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`Could not read the disk: ${detail}`);
      return { state: 'degraded', freeGb: 0, usedPercent: 0 };
    }
  }

  /**
   * When the last database backup was taken.
   *
   * A backup that silently stopped running is worse than no backup: it
   * looks like there is one.
   */
  private checkBackup(problems: string[]): PlatformStatus['checks']['backup'] {
    try {
      if (!fs.existsSync(BACKUP_DIR)) {
        return { state: 'degraded', ageHours: null, path: null };
      }
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.endsWith('.sql.gz'))
        .map((f) => {
          const full = path.join(BACKUP_DIR, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const newest = files[0];
      if (!newest) {
        problems.push('There is no database backup.');
        return { state: 'degraded', ageHours: null, path: null };
      }

      const ageHours = (Date.now() - newest.mtime) / 3_600_000;
      if (ageHours > 26) {
        problems.push(`The last database backup is ${Math.round(ageHours)} hours old.`);
        return { state: 'degraded', ageHours: round(ageHours), path: newest.full };
      }
      return { state: 'ok', ageHours: round(ageHours), path: newest.full };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      problems.push(`Could not read the backup directory: ${detail}`);
      return { state: 'degraded', ageHours: null, path: null };
    }
  }
}

function round(bytes: number): number {
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
}

export const platformStatusService = new PlatformStatusService();

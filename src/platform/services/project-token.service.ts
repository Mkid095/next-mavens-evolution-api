import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';
import { getPlatformCrypto } from './crypto';
import { PlatformAuthService } from './platform-auth.service';

/**
 * The default API token of a project.
 *
 * Every project owns exactly one "default token": a wildcard-scoped
 * (`['*']`) API key that the MCP install page and the CLI can embed
 * without asking the user to copy a secret by hand.
 *
 * The token is stored TWICE:
 *
 *   - as a `PlatformApiKey` row — this is what actually enforces it
 *     (the auth middleware validates the incoming `X-API-Key` against
 *     this row), and it is what makes the token revocable;
 *   - as `PlatformProject.defaultTokenEncrypted` — the PLAINTEXT, so the
 *     platform can show the token again later. It is encrypted with
 *     AES-256-GCM using the same `PLATFORM_ENCRYPTION_KEY` as the
 *     webhook secrets (see `crypto.ts`).
 *
 * The pointer `PlatformProject.defaultApiKeyId` ties the two together.
 * It is kept consistent with the key row: if the key row disappears the
 * pointer is cleared (the FK does `ON DELETE SET NULL`) and a fresh
 * token is generated on the next read.
 */

export interface ProjectDefaultToken {
  /** The public id of the API key row (key_xxx). */
  id: string;
  /** The key's name — always "Default token". */
  name: string;
  /** The first 16 characters of the key — safe to display. */
  keyPrefix: string;
  /** The PLAINTEXT token. */
  key: string;
  /** The granted scopes — always `['*']`. */
  scopes: string[];
  /** When the current token was issued. */
  createdAt: string;
}

const DEFAULT_TOKEN_NAME = 'Default token';
const DEFAULT_TOKEN_SCOPES = ['*'];

export class ProjectTokenService {
  private readonly logger = new Logger('ProjectTokenService');
  private readonly authService = new PlatformAuthService();

  /**
   * Read the project's default token, generating it on first use.
   *
   * The plaintext is recovered from `defaultTokenEncrypted`; when it is
   * missing, unreadable, or points at a key that no longer exists, a
   * brand new token is issued.
   */
  public async get(projectId: string): Promise<ProjectDefaultToken | null> {
    const project = await platformRepository.platformProject.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        accountId: true,
        defaultApiKeyId: true,
        defaultTokenEncrypted: true,
        defaultTokenPrefix: true,
        defaultTokenCreatedAt: true,
      },
    });

    if (!project) return null;

    if (project.defaultApiKeyId && project.defaultTokenEncrypted) {
      const key = await platformRepository.platformApiKey.findUnique({
        where: { id: project.defaultApiKeyId },
        select: {
          id: true,
          publicId: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          createdAt: true,
          revokedAt: true,
        },
      });

      // The key row is gone (deleted) or was revoked — the stored
      // plaintext no longer authenticates anything, so a new token is
      // issued instead of handing back a dead one.
      if (key && !key.revokedAt) {
        try {
          const plaintext = getPlatformCrypto().decrypt(project.defaultTokenEncrypted);
          return {
            id: key.publicId,
            name: key.name ?? DEFAULT_TOKEN_NAME,
            keyPrefix: key.keyPrefix ?? project.defaultTokenPrefix ?? '',
            key: plaintext,
            scopes: (key.scopes as string[]) ?? DEFAULT_TOKEN_SCOPES,
            createdAt: key.createdAt.toISOString(),
          };
        } catch (error) {
          this.logger.warn(`Could not decrypt the default token of project ${projectId}: ${error}`);
        }
      }

      // Fall through — issue a fresh token below.
      await this.clearDefault(project.id);
    }

    return this.issue(project.id, project.accountId);
  }

  /**
   * Rotate the project's default token.
   *
   * The previous key row is revoked first, so the old token stops
   * authenticating immediately.
   */
  public async rotate(projectId: string): Promise<ProjectDefaultToken | null> {
    const project = await platformRepository.platformProject.findUnique({
      where: { id: projectId },
      select: { id: true, accountId: true, defaultApiKeyId: true },
    });

    if (!project) return null;

    if (project.defaultApiKeyId) {
      await platformRepository.platformApiKey.updateMany({
        where: { id: project.defaultApiKeyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.info(`Default token of project ${projectId} revoked during rotation`);
    }

    return this.issue(project.id, project.accountId);
  }

  /**
   * Forget the current default token without issuing a new one.
   * Used when the key row disappeared underneath us.
   */
  private async clearDefault(projectId: string): Promise<void> {
    await platformRepository.platformProject.update({
      where: { id: projectId },
      data: {
        defaultApiKeyId: null,
        defaultTokenEncrypted: null,
        defaultTokenPrefix: null,
        defaultTokenCreatedAt: null,
      },
    });
  }

  /**
   * Issue a new default token and store it (encrypted) on the project.
   */
  private async issue(projectId: string, accountId: string): Promise<ProjectDefaultToken> {
    const created = await this.authService.createApiKey(
      accountId,
      projectId,
      DEFAULT_TOKEN_NAME,
      DEFAULT_TOKEN_SCOPES,
      undefined,
    );

    const encrypted = getPlatformCrypto().encrypt(created.plaintextKey);
    const createdAt = new Date();

    await platformRepository.platformProject.update({
      where: { id: projectId },
      data: {
        defaultApiKeyId: created.id,
        defaultTokenEncrypted: encrypted,
        defaultTokenPrefix: created.keyPrefix,
        defaultTokenCreatedAt: createdAt,
      },
    });

    this.logger.info(`Default token issued for project ${projectId} (key ${created.publicId})`);

    return {
      id: created.publicId,
      name: DEFAULT_TOKEN_NAME,
      keyPrefix: created.keyPrefix,
      key: created.plaintextKey,
      scopes: DEFAULT_TOKEN_SCOPES,
      createdAt: createdAt.toISOString(),
    };
  }
}

export const projectTokenService = new ProjectTokenService();

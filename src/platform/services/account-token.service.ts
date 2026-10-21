import { Logger } from '@config/logger.config';

import { platformRepository } from '../repository/platform.repository';
import { getPlatformCrypto } from './crypto';
import { PlatformAuthService } from './platform-auth.service';

/**
 * The account's personal access token.
 *
 * A project has a default token (see `project-token.service.ts`) that is
 * scoped to that project. This is its counterpart: ONE token for the
 * whole account, able to manage every project it holds. It is the token
 * an operator uses to drive the platform from the CLI or an MCP client
 * without having to switch credential per project.
 *
 * It is stored TWICE, exactly like the project default token:
 *
 *   - as a `PlatformApiKey` row with a NULL `projectId` — this is what
 *     the auth middleware validates against, and what makes the token
 *     revocable;
 *   - as `PlatformAccount.defaultTokenEncrypted` — the PLAINTEXT, so
 *     the Settings page can show the token again later. It is encrypted
 *     with AES-256-GCM using `PLATFORM_ENCRYPTION_KEY` (see `crypto.ts`).
 */

export interface AccountDefaultToken {
  /** The public id of the API key row (key_xxx). */
  id: string;
  /** The key's name — always "Personal access token". */
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

const DEFAULT_TOKEN_NAME = 'Personal access token';
const DEFAULT_TOKEN_SCOPES = ['*'];

export class AccountTokenService {
  private readonly logger = new Logger('AccountTokenService');
  private readonly authService = new PlatformAuthService();

  /**
   * Read the account's personal access token, generating it on first use.
   *
   * The plaintext is recovered from `defaultTokenEncrypted`; when it is
   * missing, unreadable, or points at a key that no longer exists, a
   * brand new token is issued.
   */
  public async get(accountId: string): Promise<AccountDefaultToken | null> {
    const account = await platformRepository.platformAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        defaultApiKeyId: true,
        defaultTokenEncrypted: true,
        defaultTokenPrefix: true,
        defaultTokenCreatedAt: true,
      },
    });

    if (!account) return null;

    if (account.defaultApiKeyId && account.defaultTokenEncrypted) {
      const key = await platformRepository.platformApiKey.findUnique({
        where: { id: account.defaultApiKeyId },
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
          const plaintext = getPlatformCrypto().decrypt(account.defaultTokenEncrypted);
          return {
            id: key.publicId,
            name: key.name ?? DEFAULT_TOKEN_NAME,
            keyPrefix: key.keyPrefix ?? account.defaultTokenPrefix ?? '',
            key: plaintext,
            scopes: (key.scopes as string[]) ?? DEFAULT_TOKEN_SCOPES,
            createdAt: key.createdAt.toISOString(),
          };
        } catch (error) {
          this.logger.warn(`Could not decrypt the personal access token of account ${accountId}: ${error}`);
        }
      }

      // Fall through — issue a fresh token below.
      await this.clearDefault(account.id);
    }

    return this.issue(account.id);
  }

  /**
   * Rotate the account's personal access token.
   *
   * The previous key row is revoked first, so the old token stops
   * authenticating immediately.
   */
  public async rotate(accountId: string): Promise<AccountDefaultToken | null> {
    const account = await platformRepository.platformAccount.findUnique({
      where: { id: accountId },
      select: { id: true, defaultApiKeyId: true },
    });

    if (!account) return null;

    if (account.defaultApiKeyId) {
      await platformRepository.platformApiKey.updateMany({
        where: { id: account.defaultApiKeyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.info(`Personal access token of account ${accountId} revoked during rotation`);
    }

    return this.issue(account.id);
  }

  /**
   * Forget the current token without issuing a new one.
   * Used when the key row disappeared underneath us.
   */
  private async clearDefault(accountId: string): Promise<void> {
    await platformRepository.platformAccount.update({
      where: { id: accountId },
      data: {
        defaultApiKeyId: null,
        defaultTokenEncrypted: null,
        defaultTokenPrefix: null,
        defaultTokenCreatedAt: null,
      },
    });
  }

  /**
   * Issue a new personal access token and store it (encrypted) on the account.
   */
  private async issue(accountId: string): Promise<AccountDefaultToken> {
    // A null project is what makes this token account-wide.
    const created = await this.authService.createApiKey(
      accountId,
      null,
      DEFAULT_TOKEN_NAME,
      DEFAULT_TOKEN_SCOPES,
      undefined,
    );

    const encrypted = getPlatformCrypto().encrypt(created.plaintextKey);
    const createdAt = new Date();

    await platformRepository.platformAccount.update({
      where: { id: accountId },
      data: {
        defaultApiKeyId: created.id,
        defaultTokenEncrypted: encrypted,
        defaultTokenPrefix: created.keyPrefix,
        defaultTokenCreatedAt: createdAt,
      },
    });

    this.logger.info(`Personal access token issued for account ${accountId} (key ${created.publicId})`);

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

export const accountTokenService = new AccountTokenService();

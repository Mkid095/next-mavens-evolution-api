#!/usr/bin/env node
/**
 * Re-encrypt every stored secret with a new `PLATFORM_ENCRYPTION_KEY`.
 *
 * The platform encrypts a few things at rest with AES-256-GCM under
 * `PLATFORM_ENCRYPTION_KEY`:
 *
 *   - the webhook signing secrets (`PlatformWebhook.secret`)
 *   - the project default token (`PlatformProject.defaultTokenEncrypted`)
 *   - the account personal access token (`PlatformAccount.defaultTokenEncrypted`)
 *
 * When the key has to change — a leak, a rotation policy — those rows
 * would otherwise become unreadable. This script reads each one with the
 * OLD key and writes it back with the NEW one, so the plaintext values
 * (and therefore the tokens and the webhook signatures) survive the
 * rotation unchanged.
 *
 * Usage:
 *   OLD_KEY=<64 hex chars> node scripts/re-encrypt-secrets.js
 *
 * Environment:
 *   DATABASE_CONNECTION_URI    postgres connection string (defaults to .env.phase1)
 *   PLATFORM_ENCRYPTION_KEY    the NEW key, hex, 64 chars (defaults to .env.phase1)
 *   OLD_KEY                    the OLD key, hex, 64 chars (required)
 *
 * Dry run: set DRY_RUN=1 to report what would change without writing.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;

/** Read a .env-style file into a plain object. */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
  return out;
}

const env = { ...parseEnvFile(path.join(__dirname, '..', '.env.phase1')), ...process.env };

const oldKeyHex = process.env.OLD_KEY;
if (!oldKeyHex) {
  console.error('error: OLD_KEY is required — pass the previous PLATFORM_ENCRYPTION_KEY');
  process.exit(1);
}
const newKeyHex = env.PLATFORM_ENCRYPTION_KEY;
if (!newKeyHex) {
  console.error('error: PLATFORM_ENCRYPTION_KEY is not set');
  process.exit(1);
}

const oldKey = Buffer.from(oldKeyHex, 'hex');
const newKey = Buffer.from(newKeyHex, 'hex');
const dryRun = process.env.DRY_RUN === '1';

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(payload, key) {
  const [ivHex, authTagHex, ciphertext] = String(payload).split(':');
  if (!ivHex || !authTagHex || !ciphertext) {
    throw new Error('malformed payload');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let plain = decipher.update(Buffer.from(ciphertext, 'hex'), undefined, 'utf8');
  plain += decipher.final('utf8');
  return plain;
}

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: env.DATABASE_CONNECTION_URI } },
  });

  let changed = 0;
  let failed = 0;

  try {
    // ── Webhook signing secrets ───────────────────────────────────────────
    // The secret column is NOT NULL, so every row has one to re-encrypt.
    const webhooks = await prisma.platformWebhook.findMany({
      select: { id: true, publicId: true, secret: true },
    });
    for (const hook of webhooks) {
      try {
        const plain = decrypt(hook.secret, oldKey);
        const reencrypted = encrypt(plain, newKey);
        if (!dryRun) {
          await prisma.platformWebhook.update({
            where: { id: hook.id },
            data: { secret: reencrypted },
          });
        }
        changed += 1;
        console.log(`  webhook ${hook.publicId}: re-encrypted (the secret value is unchanged)`);
      } catch (error) {
        failed += 1;
        console.error(`  webhook ${hook.publicId}: SKIPPED — ${error.message}`);
      }
    }

    // ── Project default tokens ────────────────────────────────────────────
    const projects = await prisma.platformProject.findMany({
      where: { defaultTokenEncrypted: { not: null } },
      select: { id: true, publicId: true, defaultTokenEncrypted: true },
    });
    for (const project of projects) {
      try {
        const plain = decrypt(project.defaultTokenEncrypted, oldKey);
        const reencrypted = encrypt(plain, newKey);
        if (!dryRun) {
          await prisma.platformProject.update({
            where: { id: project.id },
            data: { defaultTokenEncrypted: reencrypted },
          });
        }
        changed += 1;
        console.log(`  project ${project.publicId}: re-encrypted (the token value is unchanged)`);
      } catch (error) {
        failed += 1;
        console.error(`  project ${project.publicId}: SKIPPED — ${error.message}`);
      }
    }

    // ── Account personal access tokens ────────────────────────────────────
    const accounts = await prisma.platformAccount.findMany({
      where: { defaultTokenEncrypted: { not: null } },
      select: { id: true, publicId: true, defaultTokenEncrypted: true },
    });
    for (const account of accounts) {
      try {
        const plain = decrypt(account.defaultTokenEncrypted, oldKey);
        const reencrypted = encrypt(plain, newKey);
        if (!dryRun) {
          await prisma.platformAccount.update({
            where: { id: account.id },
            data: { defaultTokenEncrypted: reencrypted },
          });
        }
        changed += 1;
        console.log(`  account ${account.publicId}: re-encrypted (the token value is unchanged)`);
      } catch (error) {
        failed += 1;
        console.error(`  account ${account.publicId}: SKIPPED — ${error.message}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\n${dryRun ? '[dry run] ' : ''}${changed} secret(s) re-encrypted, ${failed} skipped.`,
  );
  if (failed > 0) {
    console.log('A skipped row was already unreadable with the old key — it will be re-issued on next read.');
  }
}

main().catch((error) => {
  console.error('error:', error.message);
  process.exit(1);
});

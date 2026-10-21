#!/usr/bin/env node
/**
 * Set the company gate password in the `PlatformSetting` table.
 *
 * The gate password that protects account creation (POST /platform/auth/signup
 * and POST /platform/onboard) lives in the database, encrypted with
 * AES-256-GCM using PLATFORM_ENCRYPTION_KEY. This script is how you change
 * it without editing a file or redeploying.
 *
 * Usage:
 *   node scripts/set-company-gate-password.js 'the-new-password'
 *
 * Environment:
 *   DATABASE_CONNECTION_URI   postgres connection string (defaults to .env.phase1)
 *   PLATFORM_ENCRYPTION_KEY   hex, 64 chars (defaults to .env.phase1)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const KEY = 'company_gate_password';
const DESCRIPTION = 'Password required to create an account (signup / onboarding)';

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

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

async function main() {
  const plaintext = process.argv[2];
  if (!plaintext) {
    console.error('Usage: node scripts/set-company-gate-password.js <password>');
    process.exit(1);
  }
  if (plaintext.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const envFile = parseEnvFile(path.resolve(__dirname, '..', '.env.phase1'));
  const connectionUri =
    process.env.DATABASE_CONNECTION_URI || envFile.DATABASE_CONNECTION_URI;
  const encryptionKeyHex =
    process.env.PLATFORM_ENCRYPTION_KEY || envFile.PLATFORM_ENCRYPTION_KEY;

  if (!connectionUri) {
    console.error('DATABASE_CONNECTION_URI is not set (env var or .env.phase1).');
    process.exit(1);
  }
  if (!encryptionKeyHex) {
    console.error('PLATFORM_ENCRYPTION_KEY is not set (env var or .env.phase1).');
    process.exit(1);
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const value = encrypt(plaintext, Buffer.from(encryptionKeyHex, 'hex'));
    await prisma.platformSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, description: DESCRIPTION },
      update: { value, description: DESCRIPTION },
    });
    console.log(`Company gate password updated (${KEY}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

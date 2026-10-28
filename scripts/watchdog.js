#!/usr/bin/env node
/**
 * The platform watchdog.
 *
 * The containers restart on their own, so a crash is not what breaks a
 * platform — a crash nobody notices is. This runs every minute, asks
 * the platform how it is, and tells somebody when the answer changes.
 *
 * It alerts on a CHANGE, not on every failing minute: an alert that
 * fires every minute gets ignored, which is the same as no alert.
 *
 * Where it alerts:
 *   - a webhook, if VIVENTURE_ALERT_WEBHOOK is set (Slack, Discord,
 *     Teams — anything that takes a JSON POST)
 *   - by email, if VIVENTURE_SMTP_HOST is set
 *   - always, to the log and to a status file the dashboard reads
 *
 * It lives in the repository, next to the other operational scripts, so
 * that it is reviewed and versioned with the rest of the platform.
 *
 * Usage: node scripts/watchdog.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * The alert settings live in a file, not in the repository.
 *
 * A webhook URL is a secret — it lets anybody post to your channel —
 * and the repository is public. So the file sits outside it, and this
 * script reads it if it is there.
 *
 * The file is plain KEY=VALUE lines, one per line, `#` for comments.
 */
const SETTINGS_FILE = process.env.VIVENTURE_WATCHDOG_ENV || '/home/whatsapp/.viventure-watchdog.env';

function loadSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip the quotes people put around a URL.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // The environment wins over the file: an operator can override for
    // one run without editing anything.
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

const settingsLoaded = loadSettings(SETTINGS_FILE);

const STATUS_URL = process.env.VIVENTURE_STATUS_URL || 'https://whatsapp.nextmavens.com/api/v1/platform/status';
const WEBHOOK = process.env.VIVENTURE_ALERT_WEBHOOK || '';
const SMTP_HOST = process.env.VIVENTURE_SMTP_HOST || '';
const SMTP_PORT = Number(process.env.VIVENTURE_SMTP_PORT || 587);
const SMTP_USER = process.env.VIVENTURE_SMTP_USER || '';
const SMTP_PASSWORD = process.env.VIVENTURE_SMTP_PASSWORD || '';
const ALERT_TO = process.env.VIVENTURE_ALERT_TO || '';

const LOG_FILE = process.env.VIVENTURE_WATCHDOG_LOG || '/home/whatsapp/backups/watchdog.log';
const STATE_FILE = process.env.VIVENTURE_WATCHDOG_STATE || '/home/whatsapp/backups/watchdog-state.json';

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    /* a log that cannot be written is not worth crashing over */
  }
}

/**
 * Say, once, where the alerts would go — and say it when they would
 * go NOWHERE, because a watchdog with no channel is a watchdog that
 * tells nobody.
 */
function reportChannel() {
  if (WEBHOOK) {
    log(`alerts go to the webhook (${new URL(WEBHOOK).host})`);
    return;
  }
  if (SMTP_HOST && ALERT_TO) {
    log(`alerts go by email to ${ALERT_TO} via ${SMTP_HOST}`);
    return;
  }

  log(
    `NO ALERT CHANNEL — the watchdog can only write to the log. ` +
      `Put VIVENTURE_ALERT_WEBHOOK (or the SMTP_* variables) in ${SETTINGS_FILE}.`,
  );
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    log(`could not write the state file: ${error.message}`);
  }
}

/** Fetch the platform's status. */
function fetchStatus() {
  return new Promise((resolve, reject) => {
    const client = STATUS_URL.startsWith('https') ? https : http;
    const request = client.get(STATUS_URL, { timeout: 15000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`the status endpoint did not answer with JSON: ${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

/** A one-line summary of what is wrong. */
function describe(status) {
  if (!status) return 'The platform did not answer.';
  if (status.state === 'ok') return 'The platform is healthy.';
  const problems = status.problems ?? [];
  if (!problems.length) return `The platform is ${status.state}.`;
  return `The platform is ${status.state}: ${problems.join('; ')}`;
}

/** POST the status to a webhook. */
async function postWebhook(summary, status) {
  if (!WEBHOOK) return false;
  const payload = JSON.stringify({
    text: `Viventure: ${summary}`,
    content: summary,
    state: status?.state ?? 'unknown',
    problems: status?.problems ?? [],
    url: STATUS_URL,
  });

  return new Promise((resolve) => {
    const url = new URL(WEBHOOK);
    const client = url.protocol === 'https' ? https : http;
    const request = client.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 15000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 300);
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', (error) => {
      log(`the webhook could not be reached: ${error.message}`);
      resolve(false);
    });
    request.write(payload);
    request.end();
  });
}

/** Send the alert by email, over SMTP. */
async function sendEmail(summary, status) {
  if (!SMTP_HOST || !ALERT_TO) return false;

  const net = require('net');
  const tls = require('tls');

  return new Promise((resolve) => {
    const socket = net.connect(SMTP_PORT, SMTP_HOST, () => {
      socket.write('EHLO viventure-watchdog\r\n');
    });

    let buffer = '';
    let step = 0;
    let failed = false;

    const fail = (reason) => {
      if (failed) return;
      failed = true;
      log(`the alert could not be sent by email: ${reason}`);
      socket.destroy();
      resolve(false);
    };

    socket.setTimeout(15000, () => fail('timed out'));
    socket.on('error', fail);

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith('\r\n')) return;

      const lines = buffer.trim().split('\r\n');
      buffer = '';
      const last = lines[lines.length - 1];

      // Skip the multi-line greeting.
      if (step === 0 && last.startsWith('220')) {
        step = 1;
        socket.write('EHLO viventure-watchdog\r\n');
        return;
      }
      if (step === 1 && last.startsWith('250')) {
        step = 2;
        if (SMTP_USER) {
          socket.write(`AUTH LOGIN\r\n`);
        } else {
          socket.write(`MAIL FROM:<${SMTP_USER || 'watchdog@localhost'}>\r\n`);
        }
        return;
      }
      if (step === 2 && last.startsWith('334') && SMTP_USER) {
        step = 3;
        socket.write(Buffer.from(SMTP_USER).toString('base64') + '\r\n');
        return;
      }
      if (step === 3 && last.startsWith('334')) {
        step = 4;
        socket.write(Buffer.from(SMTP_PASSWORD).toString('base64') + '\r\n');
        return;
      }
      if ((step === 2 && last.startsWith('250')) || (step === 4 && last.startsWith('235'))) {
        step = 5;
        socket.write(`MAIL FROM:<${SMTP_USER || 'watchdog@localhost'}>\r\n`);
        return;
      }
      if (step === 5 && last.startsWith('250')) {
        step = 6;
        socket.write(`RCPT TO:<${ALERT_TO}>\r\n`);
        return;
      }
      if (step === 6 && last.startsWith('250')) {
        step = 7;
        socket.write('DATA\r\n');
        return;
      }
      if (step === 7 && last.startsWith('354')) {
        step = 8;
        const body = [
          `Subject: Viventure: ${summary}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          summary,
          '',
          `Status: ${STATUS_URL}`,
          JSON.stringify(status ?? {}, null, 2),
          '.',
        ].join('\r\n');
        socket.write(`${body}\r\n`);
        return;
      }
      if (step === 8 && last.startsWith('250')) {
        socket.write('QUIT\r\n');
        socket.end();
        resolve(true);
        return;
      }
      if (last.startsWith('4') || last.startsWith('5')) {
        fail(last);
      }
    });
  });
}

async function main() {
  let status = null;
  let reachable = true;

  try {
    const response = await fetchStatus();
    status = response.body;
    reachable = true;
  } catch (error) {
    reachable = false;
    status = { state: 'down', problems: [`The platform did not answer: ${error.message}`] };
  }

  const summary = describe(status);
  const previous = readState();
  const state = status?.state ?? 'down';
  const hasChannel = Boolean(WEBHOOK || (SMTP_HOST && ALERT_TO));

  /*
   * A watchdog with nowhere to send its alerts is a watchdog that tells
   * nobody, and it looks exactly like a watchdog that has nothing to
   * report. Say so — once an hour, so it is visible without drowning
   * the log.
   */
  const lastComplaint = previous?.channelReportedAt ? Date.parse(previous.channelReportedAt) : 0;
  if (!hasChannel && Date.now() - lastComplaint > 3_600_000) {
    reportChannel();
  }

  writeState({
    checkedAt: new Date().toISOString(),
    state,
    reachable,
    problems: status?.problems ?? [],
    checks: status?.checks ?? null,
    channelReportedAt: hasChannel ? null : new Date().toISOString(),
  });

  // Alert on a CHANGE, and on the first run, and whenever the platform
  // cannot be reached at all.
  const changed = !previous || previous.state !== state || previous.reachable !== reachable;

  if (!changed) {
    log(`unchanged (${state}) — no alert`);
    return;
  }

  if (state === 'ok' && reachable) {
    log(`recovered: ${summary}`);
  } else {
    log(`ALERT: ${summary}`);
  }

  const webhookOk = await postWebhook(summary, status);
  const emailOk = await sendEmail(summary, status);

  if (!webhookOk && !emailOk) {
    log('NO ALERT CHANNEL — nothing was sent. The watchdog can only write to the log.');
  } else {
    log(`alert sent (webhook: ${webhookOk ? 'yes' : 'no'}, email: ${emailOk ? 'yes' : 'no'})`);
  }
}

main().catch((error) => {
  log(`the watchdog itself failed: ${error.message}`);
  process.exit(1);
});

const dotenv = require('dotenv');
const { execSync } = require('child_process');
const { existsSync } = require('fs');

// Load .env but DO NOT override vars already set by Docker -e flags or env_file.
// Docker sets env BEFORE Node.js starts, so process.env is already correct;
// dotenv must only fill in MISSING vars (override: false).
dotenv.config({ override: false });

const { DATABASE_PROVIDER } = process.env;
const databaseProviderDefault = DATABASE_PROVIDER ?? 'postgresql';

if (!DATABASE_PROVIDER) {
  console.warn(`DATABASE_PROVIDER is not set in the .env file, using default: ${databaseProviderDefault}`);
}

// Função para determinar qual pasta de migrations usar
// Função para determinar qual pasta de migrations usar
function getMigrationsFolder(provider) {
  switch (provider) {
    case 'psql_bouncer':
      return 'postgresql-migrations'; // psql_bouncer usa as migrations do postgresql
    default:
      return `${provider}-migrations`;
  }
}

const migrationsFolder = getMigrationsFolder(databaseProviderDefault);

let command = process.argv.slice(2).join(' ');

console.error('[runWithProvider] DATABASE_PROVIDER env:', DATABASE_PROVIDER);
console.error('[runWithProvider] databaseProviderDefault:', databaseProviderDefault);
console.error('[runWithProvider] migrationsFolder:', migrationsFolder);
console.error('[runWithProvider] raw command:', command);

command = command.replace(/DATABASE_PROVIDER-migrations/g, migrationsFolder);
console.error('[runWithProvider] after migrations replace:', command);

command = command.replace(/\bDATABASE_PROVIDER\b/g, databaseProviderDefault);
console.error('[runWithProvider] after bare replace:', command);

if (command.includes('rmdir') && existsSync('prisma\\migrations')) {
  try {
    execSync('rmdir /S /Q prisma\\migrations', { stdio: 'inherit' });
  } catch (error) {
    console.error(`Error removing directory: prisma\\migrations`);
    process.exit(1);
  }
} else if (command.includes('rmdir')) {
  console.warn(`Directory 'prisma\\migrations' does not exist, skipping removal.`);
}

try {
  execSync(command, { stdio: 'inherit' });
} catch (error) {
  console.error(`Error executing command: ${command}`);
  process.exit(1);
}
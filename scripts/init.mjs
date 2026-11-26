import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const db = randomBytes(24).toString('hex'),
  redis = randomBytes(24).toString('hex');
const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
try {
  await writeFile(
    new URL('../.env', import.meta.url),
    template
      .replace('VERITY_DB_PASSWORD=\n', 'VERITY_DB_PASSWORD=' + db + '\n')
      .replace('VERITY_REDIS_PASSWORD=\n', 'VERITY_REDIS_PASSWORD=' + redis + '\n')
      .replace('REPLACE_DB_PASSWORD', db)
      .replace('REPLACE_REDIS_PASSWORD', redis),
    { mode: 0o600, flag: 'wx' },
  );
  console.log('Created .env with private local service passwords.');
} catch (e) {
  if (e.code !== 'EEXIST') throw e;
  console.log('Existing .env retained.');
}

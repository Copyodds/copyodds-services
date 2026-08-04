const fs = require('fs');
const path = process.argv[2] || require('path').join(__dirname, '..', '.env');

if (!fs.existsSync(path)) {
  console.log('file not found:', path);
  process.exit(1);
}

const text = fs.readFileSync(path, 'utf8');

function pick(name) {
  const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!m) return null;
  let v = m[1].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

function mask(key) {
  if (!key || key.length < 12) return '(too short / empty)';
  return `${key.slice(0, 8)}…${key.slice(-4)} (len=${key.length})`;
}

const key = pick('POLYMARKET_BUILDER_API_KEY');
const backup = pick('POLYMARKET_BUILDER_BACKUP_CREDENTIALS');

console.log('file:', path);
console.log('primary:', key ? mask(key) : '(not set)');

if (backup) {
  try {
    const rows = JSON.parse(backup);
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('backup: empty array');
    } else {
      rows.forEach((row, i) => {
        console.log(`backup[${i}] label=${row.label || '-'} key=${mask(String(row.key || ''))}`);
      });
    }
  } catch {
    console.log('backup: present but not valid JSON');
  }
} else {
  console.log('backup: (not set)');
}

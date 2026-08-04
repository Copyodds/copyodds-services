const { execSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const isWin = process.platform === 'win32';

const cmd = isWin
  ? 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-test.ps1'
  : 'bash scripts/deploy-test.sh';

execSync(cmd, { stdio: 'inherit', cwd: root });

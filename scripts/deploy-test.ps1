#Requires -Version 5.1
<#
 polymarket-backend → 测试服一键部署（Windows / PowerShell）

 流程:
  1. 本地 npm run build:deploy，将 deploy/ 打成 tar.gz
  2. scp 上传到远端用户主目录 ~/polymarket-backend-deploy.tar.gz
  3. ssh 解压到站点目录，仅在 package.json 变更时 npm install、可选 migrate，pm2

 用法:
   .\scripts\deploy-test.ps1
   .\scripts\deploy-test.ps1 -BuildOnly
   .\scripts\deploy-test.ps1 -IdentityFile $env:USERPROFILE\.ssh\id_ed25519

 环境变量（可选）:
   $env:DEPLOY_SSH_HOST
   $env:DEPLOY_SSH_PORT          默认 443（OpenSSH：scp -P / ssh -p）
   $env:DEPLOY_REMOTE_APP_DIR
   $env:DEPLOY_SSH_KEY
   $env:DEPLOY_RUN_MIGRATE = "0" | "1"
   $env:DEPLOY_SKIP_NPM_INSTALL = "1"   强制跳过 npm install
   $env:DEPLOY_FORCE_NPM_INSTALL = "1"  强制 npm install --omit=dev
   $env:DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS = "0" | "1"  默认 1；P3009 时 resolve 并重试
   $env:DEPLOY_REMOTE_RESTART_CMD
   $env:DEPLOY_REMOTE_USE_SUDO = "1"   站点属主为 www 时远端 mkdir/rsync 用 sudo
   $env:DEPLOY_REMOTE_CHOWN_AFTER     例 admin:www  rsync 后 chown，便于 npm/pm2
#>
[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [string]$IdentityFile = ""
)

$ErrorActionPreference = "Stop"
$BackendRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $BackendRoot "package.json"))) {
    Write-Error "package.json not found: $BackendRoot"
}
Set-Location $BackendRoot

# -------- 可配置区域 --------
# 去掉环境变量里的 CR（Windows CRLF），避免远端路径出现 ^M / \#015
function Normalize-DeployString([string]$s) {
    if ([string]::IsNullOrWhiteSpace($s)) { return $s }
    return ($s -replace "`r", "").Trim()
}
$sshHost = Normalize-DeployString $(if ($env:DEPLOY_SSH_HOST) { $env:DEPLOY_SSH_HOST } else { "root@158.247.195.229" })
$sshPort = Normalize-DeployString $(if ($env:DEPLOY_SSH_PORT) { $env:DEPLOY_SSH_PORT } else { "443" })
$remoteAppDir = Normalize-DeployString $(if ($env:DEPLOY_REMOTE_APP_DIR) { $env:DEPLOY_REMOTE_APP_DIR } else { "/root/polymarket-backend" })
$remoteAppDir = $remoteAppDir.TrimEnd('/')
$remoteArchiveName = "polymarket-backend-deploy.tar.gz"
$runMigrate = if ($null -ne $env:DEPLOY_RUN_MIGRATE) { $env:DEPLOY_RUN_MIGRATE } else { "1" }
$skipNpmInstall = if ($null -ne $env:DEPLOY_SKIP_NPM_INSTALL) { $env:DEPLOY_SKIP_NPM_INSTALL } else { "" }
$forceNpmInstall = if ($null -ne $env:DEPLOY_FORCE_NPM_INSTALL) { $env:DEPLOY_FORCE_NPM_INSTALL } else { "" }
$autoResolveFailedMigrations = if ($null -ne $env:DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS) { $env:DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS } else { "1" }
if ($env:DEPLOY_REMOTE_RESTART_CMD) {
    $remoteRestartCmd = Normalize-DeployString $env:DEPLOY_REMOTE_RESTART_CMD
} elseif ($(if ($env:DEPLOY_PROCESS_MANAGER) { $env:DEPLOY_PROCESS_MANAGER } else { 'pm2' }) -eq 'systemd') {
    $remoteRestartCmd = 'sudo systemctl restart polymarket-backend polymarket-copy-worker'
} else {
    $remoteRestartCmd = 'pm2 restart backend --update-env || pm2 start dist/src/server.js --name backend --node-args="--env-file=.env"; pm2 restart copy-worker --update-env || pm2 start dist/src/entry/copyWorker.js --name copy-worker --node-args="--env-file=.env"; pm2 save'
}

function Resolve-DeployKey {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    if ($env:DEPLOY_SSH_KEY -and (Test-Path -LiteralPath $env:DEPLOY_SSH_KEY)) { return $env:DEPLOY_SSH_KEY }
    foreach ($name in @("id_ed25519", "id_rsa", "id_ecdsa", "vultr_polycopy", "test")) {
        $p = Join-Path $env:USERPROFILE ".ssh\$name"
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

$keyFile = Resolve-DeployKey -Explicit $IdentityFile
$useSudo = ($env:DEPLOY_REMOTE_USE_SUDO -eq "1")
$sp = if ($useSudo) { "sudo " } else { "" }
$chownAfter = Normalize-DeployString $(if ($env:DEPLOY_REMOTE_CHOWN_AFTER) { $env:DEPLOY_REMOTE_CHOWN_AFTER } else { "" })
# -----------------------------------------------

$archiveDir = Join-Path $BackendRoot ".deploy"
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$localArchive = Join-Path $archiveDir "polymarket-backend-deploy-$stamp.tar.gz"
$localLatest = Join-Path $archiveDir $remoteArchiveName

Write-Host "[deploy-test] build:deploy ..."
npm run build:deploy
if (-not (Test-Path (Join-Path $BackendRoot "deploy"))) {
    Write-Error "deploy/ missing after build:deploy"
}

Write-Host "[deploy-test] pack: $localArchive"
$deployDir = Join-Path $BackendRoot "deploy"
tar -czf $localArchive -C $deployDir .
Copy-Item -Force $localArchive $localLatest
Write-Host "[deploy-test] latest copy: $localLatest"

if ($BuildOnly) {
    Write-Host "[deploy-test] BuildOnly done, no upload"
    exit 0
}

if (-not $keyFile) {
    $sshDir = Join-Path $env:USERPROFILE ".ssh"
    Write-Host ""
    Write-Host "[deploy-test] ERROR: no SSH private key (scp/ssh need OpenSSH key)." -ForegroundColor Red
    Write-Host "  Checked under $sshDir : id_ed25519, id_rsa, id_ecdsa, vultr_polycopy, test"
    Write-Host "  Fix one of:"
    Write-Host '    - Put key in .ssh as id_ed25519 or id_rsa (or test)'
    Write-Host '    - $env:DEPLOY_SSH_KEY = full path to private key file'
    Write-Host '    - .\scripts\deploy-test.ps1 -IdentityFile "<full-path-to-key>"'
    Write-Host "  If you only have PuTTY .ppk, export OpenSSH key in PuTTYgen."
    Write-Host ""
    exit 1
}

$sshOpts = @(
    "-o", "ConnectTimeout=30",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "StrictHostKeyChecking=accept-new"
)

function Invoke-DeployScp {
    param(
        [string[]]$ScpArgs
    )
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        if ($attempt -gt 1) {
            Write-Host "[deploy-test] scp retry $attempt/$maxAttempts ..."
            Start-Sleep -Seconds 3
        }
        & scp @ScpArgs
        if ($LASTEXITCODE -eq 0) { return }
    }
    exit $LASTEXITCODE
}

function Invoke-DeploySsh {
    param(
        [string]$SshExe,
        [string[]]$SshArgs,
        [string]$ScriptPath
    )
    $maxAttempts = 3
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        if ($attempt -gt 1) {
            Write-Host "[deploy-test] ssh retry $attempt/$maxAttempts ..."
            Start-Sleep -Seconds 3
        }
        $p = Start-Process -FilePath $SshExe -ArgumentList $SshArgs -RedirectStandardInput $ScriptPath -NoNewWindow -Wait -PassThru
        if ($p.ExitCode -eq 0) { return }
        if ($attempt -eq $maxAttempts) { exit $p.ExitCode }
    }
}
Write-Host "[deploy-test] scp -> ${sshHost}:~/$remoteArchiveName (port=$sshPort)"
Write-Host "[deploy-test] extract -> $remoteAppDir (sudo=$useSudo)"
if ($chownAfter) { Write-Host "[deploy-test] chown after: $chownAfter" }
Write-Host "[deploy-test] key: $keyFile"

$scpDest = "${sshHost}:~/$remoteArchiveName"
$scpArgs = @("-i", $keyFile, "-P", $sshPort) + $sshOpts + @($localLatest, $scpDest)
Invoke-DeployScp -ScpArgs $scpArgs

$appDirSlash = $remoteAppDir.TrimEnd('/') + '/'
$remoteLines = [System.Collections.Generic.List[string]]::new()
$remoteLines.Add("set -euo pipefail")
if ($skipNpmInstall) { $remoteLines.Add('export DEPLOY_SKIP_NPM_INSTALL="' + $skipNpmInstall + '"') }
if ($forceNpmInstall) { $remoteLines.Add('export DEPLOY_FORCE_NPM_INSTALL="' + $forceNpmInstall + '"') }
$remoteLines.Add('export DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS="' + $autoResolveFailedMigrations + '"')
$remoteLines.Add('# panel /www: tar to tmp then rsync')
$remoteLines.Add('STAGE=$(mktemp -d)')
$remoteLines.Add('trap ''rm -rf "$STAGE"'' EXIT')
$remoteLines.Add($sp + "mkdir -p $remoteAppDir")
$remoteLines.Add('tar -xzf $HOME/' + $remoteArchiveName + ' -C "$STAGE" -m --no-same-owner --no-same-permissions')
$remoteLines.Add('if ! command -v rsync >/dev/null 2>&1; then echo "need rsync: yum install rsync | apt install rsync" >&2; exit 1; fi')
$remoteLines.Add('PREV_PKG_HASH=""')
$remoteLines.Add('if [[ -f "' + $remoteAppDir + '/package.json" ]]; then PREV_PKG_HASH="$(sha256sum "' + $remoteAppDir + '/package.json" | awk ''{print $1}'')"; fi')
$remoteLines.Add($sp + 'rsync -a --delete --no-perms --no-owner --no-group -O --no-times --exclude=.env --exclude=node_modules/ "$STAGE/" "' + $appDirSlash + '"')
if ($chownAfter) {
    $remoteLines.Add($sp + 'chown -R ' + $chownAfter + ' "' + $remoteAppDir + '"')
}
$remoteLines.Add("cd $remoteAppDir")
$remoteLines.Add('node_modules_ok() { [[ -x node_modules/.bin/prisma ]] && [[ -d node_modules/@prisma/client ]]; }')
$remoteLines.Add('run_npm_install() {')
$remoteLines.Add('  if npm install --omit=dev; then return 0; fi')
$remoteLines.Add('  echo "[deploy-test] npm install failed, remove node_modules and retry once" >&2')
$remoteLines.Add('  rm -rf node_modules')
$remoteLines.Add('  npm install --omit=dev')
$remoteLines.Add('}')
$remoteLines.Add('ensure_npm_deps() {')
$remoteLines.Add('  if [[ "${DEPLOY_FORCE_NPM_INSTALL:-}" == "1" ]]; then')
$remoteLines.Add('    echo "[deploy-test] npm install --omit=dev (DEPLOY_FORCE_NPM_INSTALL=1)"')
$remoteLines.Add('    run_npm_install')
$remoteLines.Add('    return')
$remoteLines.Add('  fi')
$remoteLines.Add('  if [[ "${DEPLOY_SKIP_NPM_INSTALL:-}" == "1" ]]; then')
$remoteLines.Add('    echo "[deploy-test] skip npm install (DEPLOY_SKIP_NPM_INSTALL=1)"')
$remoteLines.Add('    return')
$remoteLines.Add('  fi')
$remoteLines.Add('  local new_hash')
$remoteLines.Add('  new_hash="$(sha256sum package.json | awk ''{print $1}'')"')
$remoteLines.Add('  if node_modules_ok && [[ "$PREV_PKG_HASH" == "$new_hash" ]]; then')
$remoteLines.Add('    echo "[deploy-test] skip npm install (package.json unchanged, deps ok)"')
$remoteLines.Add('    return')
$remoteLines.Add('  fi')
$remoteLines.Add('  if [[ ! -d node_modules ]]; then')
$remoteLines.Add('    echo "[deploy-test] npm install --omit=dev (node_modules missing)"')
$remoteLines.Add('  elif ! node_modules_ok; then')
$remoteLines.Add('    echo "[deploy-test] npm install --omit=dev (node_modules incomplete)"')
$remoteLines.Add('  else')
$remoteLines.Add('    echo "[deploy-test] npm install --omit=dev (package.json changed)"')
$remoteLines.Add('  fi')
$remoteLines.Add('  run_npm_install')
$remoteLines.Add('}')
$remoteLines.Add('ensure_npm_deps')
if ($runMigrate -eq "1") {
    # IMPORTANT:
    # - prisma migrate deploy needs DATABASE_URL (pm2 env > exported .env).
    # - rsync excludes .env — first deploy must create it on the server before migrate.
    $remoteLines.Add('load_dotenv_if_present() {')
    $remoteLines.Add('  if [[ -f .env ]]; then')
    $remoteLines.Add('    local db_line')
    $remoteLines.Add('    db_line="$(grep -m1 ''^DATABASE_URL='' .env | cut -d= -f2- || true)"')
    $remoteLines.Add('    db_line="${db_line%\"}"; db_line="${db_line#\"}"; db_line="${db_line%''\''}"; db_line="${db_line#''\''}"')
    $remoteLines.Add('    if [[ -n "$db_line" ]]; then export DATABASE_URL="$db_line"; echo "[deploy-test] loaded DATABASE_URL from .env"; fi')
    $remoteLines.Add('  fi')
    $remoteLines.Add('}')
    $remoteLines.Add('run_migrate_deploy() {')
    $remoteLines.Add('  if [[ -z "${DATABASE_URL:-}" ]]; then')
    $remoteLines.Add('    echo "[deploy-test] ERROR: DATABASE_URL is not set (pm2 env backend / .env)." >&2')
    $remoteLines.Add('    echo "[deploy-test] On server: cp .env.example .env && edit DATABASE_URL, then: npm run migrate:deploy" >&2')
    $remoteLines.Add('    exit 1')
    $remoteLines.Add('  fi')
    $remoteLines.Add('  if [[ ! -x node_modules/.bin/prisma ]]; then')
    $remoteLines.Add('    echo "[deploy-test] ERROR: prisma CLI missing after npm install" >&2')
    $remoteLines.Add('    exit 1')
    $remoteLines.Add('  fi')
    $remoteLines.Add('  local prisma=./node_modules/.bin/prisma fail_log attempt failed')
    $remoteLines.Add('  fail_log="$(mktemp)"')
    $remoteLines.Add('  for attempt in 1 2; do')
    $remoteLines.Add('    if "$prisma" migrate deploy 2>"$fail_log"; then')
    $remoteLines.Add('      rm -f "$fail_log"')
    $remoteLines.Add('      return 0')
    $remoteLines.Add('    fi')
    $remoteLines.Add('    cat "$fail_log" >&2')
    $remoteLines.Add('    if [[ $attempt -eq 1 && "${DEPLOY_AUTO_RESOLVE_FAILED_MIGRATIONS:-1}" == "1" ]] && grep -q P3009 "$fail_log"; then')
    $remoteLines.Add('      failed="$(sed -n ''s/.*`\([^`]*\)` migration started.*/\1/p'' "$fail_log" | head -1)"')
    $remoteLines.Add('      if [[ -n "$failed" ]]; then')
    $remoteLines.Add('        echo "[deploy-test] P3009: migrate resolve --rolled-back $failed, then retry"')
    $remoteLines.Add('        "$prisma" migrate resolve --rolled-back "$failed"')
    $remoteLines.Add('        continue')
    $remoteLines.Add('      fi')
    $remoteLines.Add('    fi')
    $remoteLines.Add('    rm -f "$fail_log"')
    $remoteLines.Add('    exit 1')
    $remoteLines.Add('  done')
    $remoteLines.Add('  rm -f "$fail_log"')
    $remoteLines.Add('  exit 1')
    $remoteLines.Add('}')
    $remoteLines.Add('PM2_DB="$(pm2 env backend 2>/dev/null | grep -m1 ''^DATABASE_URL='' | cut -d= -f2- || true)"')
    $remoteLines.Add('if [[ -n "$PM2_DB" ]]; then echo "[deploy-test] migrate using pm2 DATABASE_URL"; DATABASE_URL="$PM2_DB" run_migrate_deploy')
    $remoteLines.Add('else load_dotenv_if_present; echo "[deploy-test] migrate using .env / shell DATABASE_URL"; run_migrate_deploy; fi')
}
$remoteLines.Add($remoteRestartCmd)
$remoteLines = @($remoteLines)
$remoteBash = (($remoteLines -join "`n") -replace "`r", "")
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$tmpSh = Join-Path $env:TEMP ("deploy-backend-ssh-{0}.sh" -f [guid]::NewGuid().ToString("n"))
try {
    [System.IO.File]::WriteAllText($tmpSh, $remoteBash, $utf8NoBom)
    $sshExe = (Get-Command ssh -ErrorAction Stop).Source
    $sshArgs = @("-i", $keyFile, "-p", $sshPort) + $sshOpts + @("-T", $sshHost, "bash", "-s")
    Invoke-DeploySsh -SshExe $sshExe -SshArgs $sshArgs -ScriptPath $tmpSh
} finally {
    Remove-Item -LiteralPath $tmpSh -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "OK deploy done: $sshHost -> $remoteAppDir"

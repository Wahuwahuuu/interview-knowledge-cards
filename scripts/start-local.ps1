$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectDirectory
$env:WRANGLER_SEND_METRICS = 'false'
$env:CLOUDFLARE_CF_FETCH_ENABLED = 'false'
$previewUrl = 'http://127.0.0.1:8787'
$previewReady = $false
try { $response = Invoke-WebRequest -Uri ($previewUrl + '/api/health') -UseBasicParsing -TimeoutSec 2; $previewReady = ($response.StatusCode -eq 200) } catch {}
if ($previewReady) { Start-Process $previewUrl; exit 0 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22.13 或以上版本。' }
& node scripts/init-config.mjs
if ($LASTEXITCODE -ne 0) { throw '本机配置初始化失败。' }
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'node_modules'))) { & npm.cmd ci --cache .cache/npm --offline=false --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' } }
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'dist/sw.js'))) { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw '网页构建失败。' } }
& npm.cmd run db:local
if ($LASTEXITCODE -ne 0) { throw '本地数据库初始化失败。' }
Write-Host 'Preview: http://127.0.0.1:8787'
Write-Host 'Close this window to stop the local preview.'
$browserLauncher = Start-Job -ScriptBlock { Start-Sleep -Seconds 4; Start-Process 'http://127.0.0.1:8787' }
try { & npm.cmd run preview } finally { Remove-Job -Job $browserLauncher -Force -ErrorAction SilentlyContinue }

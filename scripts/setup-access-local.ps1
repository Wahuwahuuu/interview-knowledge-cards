$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectDirectory
$env:WRANGLER_SEND_METRICS = 'false'
$env:CLOUDFLARE_CF_FETCH_ENABLED = 'false'
$apiAddress = [Uri]'https://api.cloudflare.com'
$configuredProxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($apiAddress)
if ($configuredProxy.AbsoluteUri -ne $apiAddress.AbsoluteUri) { $env:HTTPS_PROXY = $configuredProxy.AbsoluteUri; $env:HTTP_PROXY = $configuredProxy.AbsoluteUri }
Write-Host '配置题库的邮箱验证码与独立 AI 导入入口。'
Write-Host '使用刚刚在 Cloudflare 官方页面创建的临时 Access 配置 Token；不保存该 Token。'
$setupSecureToken = Read-Host '请粘贴临时 Access API Token（输入不会显示）' -AsSecureString
$setupTokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($setupSecureToken)
try {
    $env:CLOUDFLARE_ACCESS_SETUP_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($setupTokenPointer)
    & node scripts/setup-access.mjs
    if ($LASTEXITCODE -ne 0) { throw '私人登录配置未完成，请检查 Token 的三个 Access 编辑权限及指定账户。' }
    Remove-Item Env:\CLOUDFLARE_ACCESS_SETUP_TOKEN -ErrorAction SilentlyContinue
    & node scripts/deploy.mjs
    if ($LASTEXITCODE -ne 0) { throw '登录规则已配置，但网站发布未完成。请保留当前文件并告知结果。' }
    Write-Host '私人登录配置和发布完成。可以在官方页面撤销临时配置 Token。'
    $deployment = Get-Content -LiteralPath '.cloudflare-deployment.json' -Raw | ConvertFrom-Json
    Write-Host ('Online: ' + $deployment.site_url)
} finally {
    Remove-Item Env:\CLOUDFLARE_ACCESS_SETUP_TOKEN -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($setupTokenPointer)
    $setupSecureToken.Dispose()
}

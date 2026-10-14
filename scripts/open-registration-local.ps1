$ErrorActionPreference = 'Stop'
$projectDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectDirectory
$env:WRANGLER_SEND_METRICS = 'false'
$env:CLOUDFLARE_CF_FETCH_ENABLED = 'false'
$apiAddress = [Uri]'https://api.cloudflare.com'
$configuredProxy = [Net.WebRequest]::GetSystemWebProxy().GetProxy($apiAddress)
if ($configuredProxy.AbsoluteUri -ne $apiAddress.AbsoluteUri) { $env:HTTPS_PROXY = $configuredProxy.AbsoluteUri; $env:HTTP_PROXY = $configuredProxy.AbsoluteUri }
Write-Host '先确认已在网站上设置管理员密码。'
Write-Host '本脚本只修改题库人工登录应用的保护路径，不改变题库内容或 AI 凭证。'
Write-Host '需要当前账户 Access: Apps and Policies 编辑权限的临时 Token；不保存它。'
$registrationSecureToken = Read-Host '临时 Access API Token（输入不会显示）' -AsSecureString
$registrationTokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($registrationSecureToken)
try {
    $env:CLOUDFLARE_ACCESS_SETUP_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($registrationTokenPointer)
    & node scripts/open-registration.mjs
    if ($LASTEXITCODE -ne 0) { throw '开放注册未完成，请按屏幕提示处理后重试。' }
    Write-Host '完成后可以在 Cloudflare 官方页面撤销临时 Token。'
} finally {
    Remove-Item Env:\CLOUDFLARE_ACCESS_SETUP_TOKEN -ErrorAction SilentlyContinue
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($registrationTokenPointer)
    $registrationSecureToken.Dispose()
}

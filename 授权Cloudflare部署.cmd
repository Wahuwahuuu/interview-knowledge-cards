@echo off
cd /d "%~dp0"
set WRANGLER_SEND_METRICS=false
set CLOUDFLARE_CF_FETCH_ENABLED=false
node node_modules\wrangler\bin\wrangler.js login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write d1:write
if errorlevel 1 pause

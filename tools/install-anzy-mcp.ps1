# Installs the team MCP server into anzy-renlab-ai's Claude Code config so he
# can run team:dispatch / team:status / team:today / team:ask straight from his
# CC session. Idempotent — adds (or overwrites) only the "team" entry under
# mcpServers; leaves everything else in claude.json alone.
#
# Run from any directory (uses script-relative repo path):
#   pwsh -ExecutionPolicy Bypass -File tools\install-anzy-mcp.ps1
#
# Required env when the MCP server fires inside CC:
#   - MINIMAX_API_KEY              (LLM provider)
#   - SLACK_VAULT_KEY              (vault for slack/github tokens)
#   - CC_COLLECTOR_BASE (default http://192.168.22.88:8933)
#   - TEAM_API_BASE     (default http://127.0.0.1:3000)
# This script reads them from the calling shell — set them before running, or
# edit claude.json manually after the fact.

$ErrorActionPreference = 'Stop'

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ServerPath = Join-Path $RepoRoot 'src\mcp\server.ts'
$ServerForwardSlash = $ServerPath -replace '\\','/'
$ClaudeJson = Join-Path $env:USERPROFILE '.claude.json'

if (-not (Test-Path $ServerPath)) {
    Write-Error "team MCP server not found at $ServerPath"
    exit 1
}

# Load or initialize claude.json.
if (Test-Path $ClaudeJson) {
    $configRaw = Get-Content -Raw $ClaudeJson
    try {
        $config = $configRaw | ConvertFrom-Json
    } catch {
        Write-Error "couldn't parse $ClaudeJson — fix or remove it first"
        exit 1
    }
} else {
    $config = [pscustomobject]@{}
}

if (-not $config.PSObject.Properties.Match('mcpServers').Count) {
    Add-Member -InputObject $config -MemberType NoteProperty -Name 'mcpServers' -Value ([pscustomobject]@{}) -Force
}

$existingTeamEnv = $null
if ($config.mcpServers.PSObject.Properties.Match('team').Count) {
    $existingTeamEnv = $config.mcpServers.team.env
}

function Resolve-EnvOrExisting {
    param([string]$EnvName, $Existing)
    if ($EnvName -and (Test-Path "env:$EnvName")) {
        $val = (Get-Item "env:$EnvName").Value
        if ($val -and $val.Trim().Length -gt 0) { return $val }
    }
    if ($Existing -and $Existing.PSObject.Properties.Match($EnvName).Count) {
        $val = $Existing.$EnvName
        if ($val -and $val -ne '<paste before first use>' -and $val.Trim().Length -gt 0) {
            return $val
        }
    }
    return $null
}

$minimaxKey = Resolve-EnvOrExisting 'MINIMAX_API_KEY' $existingTeamEnv
$slackVault = Resolve-EnvOrExisting 'SLACK_VAULT_KEY' $existingTeamEnv

# Hard fail rather than write placeholders. Cryptic LLM-401 errors at first
# use are worse than refusing to install.
$missing = @()
if (-not $minimaxKey) { $missing += 'MINIMAX_API_KEY' }
if (-not $slackVault) { $missing += 'SLACK_VAULT_KEY' }
if ($missing.Count -gt 0) {
    Write-Host '✗ Refusing to install — missing secrets:' -ForegroundColor Red
    foreach ($m in $missing) { Write-Host "    $m" -ForegroundColor Red }
    Write-Host ''
    Write-Host 'Set them first, then re-run the installer:'
    foreach ($m in $missing) {
        Write-Host "  `$env:$m = '<your-key>'"
    }
    Write-Host '  bun run mcp:install'
    exit 1
}

$envBlock = [pscustomobject]@{
    TEAM_API_BASE       = if ($env:TEAM_API_BASE) { $env:TEAM_API_BASE } else { 'http://127.0.0.1:3000' }
    CC_COLLECTOR_BASE   = if ($env:CC_COLLECTOR_BASE) { $env:CC_COLLECTOR_BASE } else { 'http://192.168.22.88:8933' }
    MINIMAX_API_KEY     = $minimaxKey
    SLACK_VAULT_KEY     = $slackVault
}

$teamEntry = [pscustomobject]@{
    command = 'bun'
    args    = @('run', $ServerForwardSlash)
    env     = $envBlock
}

# Overwrite (or add) the "team" entry. PS' -Force on Add-Member replaces.
Add-Member -InputObject $config.mcpServers -MemberType NoteProperty -Name 'team' -Value $teamEntry -Force

# Atomic write: tmp + rename so we never half-write claude.json.
$tmp = "$ClaudeJson.tmp"
$config | ConvertTo-Json -Depth 32 | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force -Path $tmp -Destination $ClaudeJson

Write-Host "✓ wrote team MCP entry to $ClaudeJson"
Write-Host "  command: bun run $ServerForwardSlash"
Write-Host ''
Write-Host '⚠  This file now contains your MINIMAX_API_KEY and SLACK_VAULT_KEY in' -ForegroundColor Yellow
Write-Host "   plaintext at $ClaudeJson — don't commit or share it." -ForegroundColor Yellow
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1. Make sure the team dev server is up: cd team; bun run dev'
Write-Host '  2. Restart Claude Code (so it picks up claude.json).'
Write-Host '  3. In CC, try:  team:status     team:today     team:dispatch'
Write-Host ''
Write-Host 'Smoke-test the MCP server end-to-end:'
Write-Host '  cd team'
Write-Host '  bun run mcp:smoke'

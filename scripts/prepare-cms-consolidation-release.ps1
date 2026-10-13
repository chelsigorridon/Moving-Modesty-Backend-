$ErrorActionPreference = 'Stop'
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskPrevious = Join-Path $taskWorkspace '.tmp/discounts-release-20261009'
$taskArchive = Join-Path $taskWorkspace '.tmp/discounts-baseline-20261009.zip'
$taskBundle = Join-Path $taskWorkspace '.tmp/cms-consolidation-release-20261012'
if (Test-Path -LiteralPath $taskBundle) { throw 'Release already exists. Inspect it; do not overwrite.' }
if (-not (Test-Path -LiteralPath $taskArchive -PathType Leaf)) { throw 'Verified production baseline is unavailable.' }

# Reuse the last closed, reviewed production manifest, not the dirty workspace.
$taskManifestSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'prepare-discounts-release.ps1') -Raw
$taskManifest = [regex]::Match($taskManifestSource, '(?s)\$taskOverlay = @\((.*?)\r?\n\)')
if (-not $taskManifest.Success) { throw 'Could not read the previous closed manifest.' }
$taskPaths = [regex]::Matches($taskManifest.Groups[1].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value }
$taskUpdated = @('lib/framer-catalogue-live.ts', 'lib/db/schema.ts')
foreach ($taskRelative in $taskPaths) {
    if ([IO.Path]::IsPathRooted($taskRelative) -or $taskRelative.Contains('..')) { throw 'Invalid manifest path.' }
    $taskCurrentFile = Join-Path $taskWorkspace $taskRelative
    $taskPreviousFile = Join-Path $taskPrevious $taskRelative
    if (-not (Test-Path -LiteralPath $taskPreviousFile -PathType Leaf)) { throw "Previous release file is missing: $taskRelative" }
    if ($taskRelative -notin $taskUpdated -and (Get-FileHash -LiteralPath $taskCurrentFile).Hash -ne (Get-FileHash -LiteralPath $taskPreviousFile).Hash) {
        throw "An unrelated production dependency changed: $taskRelative. Stop and review."
    }
}
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBundle
foreach ($taskRelative in $taskPaths) {
    $taskSource = if ($taskRelative -in $taskUpdated) { Join-Path $taskWorkspace $taskRelative } else { Join-Path $taskPrevious $taskRelative }
    $taskTarget = Join-Path $taskBundle $taskRelative
    New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
    Copy-Item -LiteralPath $taskSource -Destination $taskTarget
}
New-Item -ItemType Directory -Path (Join-Path $taskBundle '.vercel') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskPrevious '.vercel/project.json') -Destination (Join-Path $taskBundle '.vercel/project.json')
Write-Output "Scoped CMS release prepared: $taskBundle"
Write-Output "Only changed production files: $($taskUpdated -join ', ')"

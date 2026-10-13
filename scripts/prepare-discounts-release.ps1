$ErrorActionPreference = 'Stop'
# A closed deployment manifest: committed baseline + Discounts and its existing
# live product/stock dependencies. Never copy the dirty workspace recursively.
$taskWorkspace = Split-Path -Parent $PSScriptRoot
$taskBundle = Join-Path $taskWorkspace '.tmp/discounts-release-20261009'
if (Test-Path -LiteralPath $taskBundle) { throw 'Release folder already exists; inspect it instead of overwriting it.' }
$taskOverlay = @(
  'app/(admin)/discounts/page.tsx',
  'app/api/admin/discounts/route.ts',
  'app/api/admin/product-catalogue/route.ts',
  'app/api/admin/product-catalogue/photos/route.ts',
  'app/api/storefront/variants/route.ts',
  'app/api/checkout/discount/route.ts',
  'app/api/checkout/orders/route.ts',
  'app/api/checkout/session/route.ts',
  'components/admin-shell.tsx',
  'components/discount-manager.tsx',
  'lib/admin-data.ts', 'lib/admin-types.ts',
  'lib/checkout-input.ts', 'lib/checkout-order.ts', 'lib/checkout-safety.ts',
  'lib/db/schema.ts', 'lib/email.ts',
  'lib/integrations/payfast/checkout.ts',
  'lib/integrations/payfast/notification.ts',
  'lib/discount-input.ts', 'lib/discounts.ts',
  'lib/catalogue-input.ts', 'lib/catalogue-drafts.ts',
  'lib/catalogue-live.ts', 'lib/catalogue-storefront.ts',
  'lib/framer-catalogue-live.ts',
  'drizzle/0008_overjoyed_ezekiel_stane.sql',
  'drizzle/0009_clammy_ozymandias.sql',
  'drizzle/0010_glamorous_cargill.sql',
  'drizzle/meta/0008_snapshot.json',
  'drizzle/meta/0009_snapshot.json',
  'drizzle/meta/0010_snapshot.json',
  'drizzle/meta/_journal.json',
  'next.config.ts', 'package.json', 'package-lock.json',
  '.vercelignore'
)
foreach ($taskRelative in $taskOverlay) {
  if (-not (Test-Path -LiteralPath (Join-Path $taskWorkspace $taskRelative) -PathType Leaf)) {
    throw "Manifest source is missing: $taskRelative"
  }
}
$taskArchive = Join-Path $taskWorkspace '.tmp/discounts-baseline-20261009.zip'
New-Item -ItemType Directory -Path (Split-Path -Parent $taskArchive) -Force | Out-Null
git -C $taskWorkspace archive --format=zip HEAD -o $taskArchive
if ($LASTEXITCODE -ne 0) { throw 'Could not create the committed release baseline.' }
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskBundle
foreach ($taskRelative in $taskOverlay) {
  $taskTarget = Join-Path $taskBundle $taskRelative
  New-Item -ItemType Directory -Path (Split-Path -Parent $taskTarget) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $taskWorkspace $taskRelative) -Destination $taskTarget
  [PSCustomObject]@{ path = $taskRelative; sha256 = (Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash }
}
# Project identity only: no environment files, CLI credentials or customer data.
New-Item -ItemType Directory -Path (Join-Path $taskBundle '.vercel') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskWorkspace '.vercel/project.json') -Destination (Join-Path $taskBundle '.vercel/project.json')
Write-Output "Scoped release prepared at $taskBundle"

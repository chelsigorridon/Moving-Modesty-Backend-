param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$taskRootPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskDestination = (Resolve-Path $Destination).Path
if (-not $taskDestination.StartsWith((Join-Path $taskRootPath '.tmp') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The verification folder must be inside this workspace .tmp directory.' }
# Overlay only reviewed delivery work onto an isolated Git baseline. Never copy
# local environment files, unrelated product prototypes or generated build output.
$files = @(
  '.env.example','README.md',
  'app/api/admin/bobgo/locations/route.ts','app/api/admin/bobgo/pickup-points/route.ts',
  'app/api/admin/bobgo/packages/route.ts','app/api/admin/bobgo/weights/route.ts','app/api/admin/data/route.ts',
  'app/api/admin/orders/[orderNumber]/delivery/route.ts','app/api/admin/orders/[orderNumber]/bobgo-sync/route.ts',
  'app/api/internal/bobgo-sync/route.ts','app/delivery-review/page.tsx',
  'components/delivery-editor.tsx','components/delivery-review.tsx','components/order-sync-review.tsx','components/order-sync-status.tsx',
  'components/parcel-editor.tsx','components/shipping-weight-settings.tsx',
  'drizzle/0011_delivery_management.sql','drizzle/0012_bobgo_sync_foundation.sql','drizzle/0013_bobgo_tracking_poll.sql','drizzle/0014_shipping_weight_history.sql',
  'drizzle/meta/0011_snapshot.json','drizzle/meta/0012_snapshot.json','drizzle/meta/0013_snapshot.json','drizzle/meta/0014_snapshot.json','drizzle/meta/_journal.json',
  'framer/AdminPortal.tsx','lib/admin-data.ts','lib/admin-types.ts','lib/db/schema.ts','lib/delivery-input.ts','lib/delivery-management.ts',
  'lib/shipping-weights.ts','lib/monitoring-policy.ts','lib/integrations/bobgo/delivery.ts','lib/integrations/bobgo/packages.ts',
  'lib/integrations/bobgo/protocol.ts','lib/integrations/bobgo/shipping.ts','lib/integrations/bobgo/order-sync-policy.ts','lib/integrations/bobgo/order-sync.ts',
  'lib/integrations/bobgo/order-sync-transport.ts','lib/integrations/bobgo/order-sync-runtime.ts','lib/integrations/bobgo/order-sync-runner.ts',
  'lib/integrations/payfast/notification.ts','scripts/build-framer-delivery-editor.mjs','scripts/prepare-delivery-review.ps1',
  'tests/admin-portal-layout.test.ts','tests/bobgo-protocol.test.ts','tests/bobgo-connection.test.ts','tests/bobgo-order-sync.test.ts',
  'tests/bobgo-order-sync-database.test.ts','tests/bobgo-sync-runtime.test.ts','tests/delivery-flow.test.ts','tests/delivery-input.test.ts','tests/delivery-management-database.test.ts'
)
foreach ($file in $files) {
  $taskSource = Join-Path $taskRootPath $file
  $taskTarget = Join-Path $taskDestination $file
  New-Item -ItemType Directory -Path (Split-Path $taskTarget) -Force | Out-Null
  Copy-Item -LiteralPath $taskSource -Destination $taskTarget -Force
  if ((Get-FileHash -LiteralPath $taskSource).Hash -ne (Get-FileHash -LiteralPath $taskTarget).Hash) { throw "Verification copy mismatch: $file" }
}
[PSCustomObject]@{ Files = $files.Count; HashMismatches = 0; Destination = $taskDestination }

// Only inspect the authenticated API user's role, never every role on the account.
// A successful GET is not evidence of permission to perform a chargeable POST.
export const linkedBookingPermissions = [
  "API_/orders:GET", "API_/orders:PATCH", "API_/orders/rates:POST",
  "API_/order-fulfillments:GET", "API_/order-fulfillments:POST",
  "API_/shipments:GET", "API_/accounts/address-books:GET",
] as const;
export const linkedWaybillChangePermissions = ["API_/orders:GET", "API_/order-fulfillments:GET", "API_/shipments:GET", "API_/order-fulfillments/cancel:POST", "API_/shipments/cancel:POST"] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function inspectLinkedBookingPermissions(value: unknown, required: readonly string[] = linkedBookingPermissions) {
  const body = object(value), user = object(body.user);
  let role = object(user.role);
  if (!Object.keys(role).length && user.role_id !== undefined && Array.isArray(body.roles)) {
    const matches = body.roles.filter(value => String(object(value).id) === String(user.role_id));
    if (matches.length === 1) role = object(matches[0]);
  }
  const permissions = role.permissions;
  const known = Array.isArray(permissions) && permissions.every(value => typeof value === "string");
  return { known, allowed: known && required.every(permission => permissions.includes(permission)),
    permissions: Object.fromEntries(required.map(permission => [permission, known ? permissions.includes(permission) : null])) };
}

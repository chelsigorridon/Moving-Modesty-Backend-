// Public, server-configured sender location only. It is not a price or booking
// authorisation: saving and quoting still resolve capacity, address-book identity
// and the eligible provider before any separately approved waybill booking.
export function configuredCollectionDropOff(config: { pickupPointLocationId?: string; pickupPointProviderSlug?: string; senderLocationName: string }) {
  const id = config.pickupPointLocationId?.trim() || "", providerSlug = config.pickupPointProviderSlug?.trim() || "", name = config.senderLocationName.trim();
  if (!/^[1-9]\d{0,11}$/.test(id) || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(providerSlug) || !name || name.length > 200 || /[\u0000-\u001f]/.test(name)) return null;
  return { id, providerSlug, name };
}

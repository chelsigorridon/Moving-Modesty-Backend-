import "server-only";
import { requireDatabase } from "../../db";
import { preparedSyncCredentials } from "./order-sync-runtime";
import { createLinkedBookingService } from "./linked-booking";
import { createLinkedBookingTransport } from "./linked-booking-transport";
import { getLinkedBookingConfiguration, linkedBookingPaused, LinkedBookingConflict } from "./linked-booking-policy";

export function configuredLinkedBooking() {
  // Independent from automatic sync: existing linked orders can use manual
  // booking after acceptance, even if automatic copying is subsequently paused.
  const config = getLinkedBookingConfiguration(), credentials = preparedSyncCredentials(config);
  if (!credentials) throw new LinkedBookingConflict(linkedBookingPaused);
  if (!process.env.AUTH_SECRET) throw new LinkedBookingConflict("Courier quote signing is not configured.");
  return createLinkedBookingService(requireDatabase(), createLinkedBookingTransport(config, credentials.token), config, process.env.AUTH_SECRET);
}

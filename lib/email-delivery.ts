import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDatabase } from "./db";
import { emailEvents } from "./db/schema";
import { reportFailure, resolveFailures } from "./monitoring";
import { notificationDeliveryMessage, type ErrorCode } from "./monitoring-policy";

const deliveryEvents = ["email.sent", "email.delivered", "email.delivery_delayed", "email.bounced", "email.complained", "email.failed", "email.suppressed"] as const;
const deliveryInput = z.object({
  type: z.enum(deliveryEvents), created_at: z.iso.datetime({ offset: true }),
  data: z.object({ email_id: z.string().min(1).max(128), tags: z.record(z.string(), z.string()).optional() }),
});
const terminalFailure = (event: string | null) => ["email.bounced", "email.complained", "email.suppressed", "email.failed"].includes(event || "");
const priority = (event: string | null) => ({ "email.sent": 0, "email.delivery_delayed": 1, "email.delivered": 2, "email.failed": 3, "email.bounced": 4, "email.suppressed": 5, "email.complained": 6 })[event || "email.sent"] ?? 0;

export function shouldApplyDeliveryEvent(current: string | null, currentAt: Date | null, incoming: string, incomingAt: Date) {
  if (terminalFailure(current) && !terminalFailure(incoming)) return false;
  if (current === "email.delivered" && (incoming === "email.sent" || incoming === "email.delivery_delayed")) return false;
  if (currentAt && incomingAt.getTime() < currentAt.getTime()) return false;
  if (currentAt && incomingAt.getTime() === currentAt.getTime() && priority(incoming) <= priority(current)) return false;
  return true;
}

export async function applyEmailDeliveryEvent(value: unknown) {
  const parsed = deliveryInput.safeParse(value);
  if (!parsed.success) return { ignored: true };
  const input = parsed.data;
  const database = requireDatabase();
  const changed = await database.transaction(async transaction => {
    const query = transaction.select().from(emailEvents).where(eq(emailEvents.resendEmailId, input.data.email_id)).limit(1).for("update");
    let [event] = await query;
    // A webhook can arrive between provider acceptance and saving its response.
    // The server-generated tag links it to the already-created email event.
    const taggedId = input.data.tags?.mm_event_id;
    if (!event && taggedId && z.uuid().safeParse(taggedId).success) {
      [event] = await transaction.select().from(emailEvents).where(eq(emailEvents.id, taggedId)).limit(1).for("update");
      if (event?.resendEmailId && event.resendEmailId !== input.data.email_id) return null;
    }
    if (!event) return null; // Includes technical-alert emails: no recursive bounce alerts.
    const occurredAt = new Date(input.created_at);
    if (!shouldApplyDeliveryEvent(event.deliveryEvent, event.deliveryEventAt, input.type, occurredAt)) return null;
    const failed = terminalFailure(input.type);
    await transaction.update(emailEvents).set({ resendEmailId: input.data.email_id, status: failed ? "failed" : input.type === "email.delivered" ? "delivered" : "sent", deliveryEvent: input.type, deliveryEventAt: occurredAt, errorMessage: notificationDeliveryMessage(input.type, event.template) || null }).where(eq(emailEvents.id, event.id));
    return { orderId: event.orderId, failed, delayed: input.type === "email.delivery_delayed" };
  });
  if (changed?.failed || changed?.delayed) {
    const code = ({ "email.bounced": "email_bounced", "email.complained": "email_complained", "email.suppressed": "email_suppressed", "email.failed": "email_failed", "email.delivery_delayed": "email_delayed" } as Record<string, ErrorCode>)[input.type];
    await reportFailure(null, { operation: "email_webhook", code, orderId: changed.orderId || undefined, severity: changed.delayed ? "warning" : "error" });
  } else if (changed && input.type === "email.delivered") {
    // Clear only when this order has no remaining failed/delayed email events.
    if (changed.orderId) {
      const [remaining] = await database.select({ id: emailEvents.id }).from(emailEvents).where(and(eq(emailEvents.orderId, changed.orderId), sql`(${emailEvents.status} = 'failed' or ${emailEvents.deliveryEvent} = 'email.delivery_delayed')`)).limit(1);
      if (!remaining) await resolveFailures("email_webhook", changed.orderId);
    }
  }
  return { ignored: !changed };
}

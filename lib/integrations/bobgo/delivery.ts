import "server-only";
import { bobGoDoorAddress, courierPlanInput, planProvider, type CourierEndpoint, type CourierPlan } from "../../delivery-input";
import { bobGoRequest } from "./client";
import type { Operation } from "../../monitoring-policy";
import { contactName, parcelPayload, parseLocation, type CourierBookingSnapshot, type PackedParcel, type ResolvedCourierEndpoint } from "./protocol";
import { collectionRateSchedule, collectionShipmentSchedule } from "../../shipping/collection-schedule";

export async function resolveCourierPlan(input: CourierPlan, parcel?: PackedParcel, context?: { operation: Operation; orderId?: string }) {
  const plan = courierPlanInput.parse(input);
  async function endpoint(value: CourierEndpoint): Promise<ResolvedCourierEndpoint> {
    if (value.kind === "door") return { kind: value.kind, contact: value.contact, address: bobGoDoorAddress(value.address) };
    const query = new URLSearchParams({ location_id: value.point.id, provider_slug: value.point.providerSlug });
    if (parcel) {
      query.set("stacked_length", String(parcel.lengthCm)); query.set("stacked_width", String(parcel.widthCm));
      query.set("stacked_height", String(parcel.heightCm)); query.set("total_weight", String(parcel.weightGrams / 1000));
    }
    const location = parseLocation(await bobGoRequest(`/locations?${query}`, undefined, context), value.point.id, value.point.providerSlug, Boolean(parcel));
    value.point.name = location.name || value.point.name;
    return { kind: value.kind, contact: value.contact, address: location.address, point: { ...value.point } };
  }
  const [collection, delivery] = await Promise.all([endpoint(plan.collection), endpoint(plan.delivery)]);
  return { plan, collection, delivery, providerSlug: planProvider(plan) };
}

// Omit providers for door-to-door: Bob Go returns all eligible configured couriers.
// Pickup-point services retain the provider that actually owns the selected point.
export function deliveryRatePayload(resolved: Awaited<ReturnType<typeof resolveCourierPlan>>, parcel: PackedParcel, orderNumber: string, declaredValue: number) {
  const { collection, delivery, plan, providerSlug } = resolved;
  return {
    collection_address: collection.address, delivery_address: delivery.address,
    collection_contact_full_name: collection.contact.name, collection_contact_email: collection.contact.email,
    collection_contact_mobile_number: collection.contact.phone,
    delivery_contact_full_name: delivery.contact.name, delivery_contact_email: delivery.contact.email,
    delivery_contact_mobile_number: delivery.contact.phone,
    instructions_collection: plan.collectionInstructions, instructions_delivery: plan.deliveryInstructions,
    ...(collection.kind === "door" ? collectionRateSchedule(plan.collectionSchedule) : {}),
    parcels: parcelPayload(parcel, orderNumber), declared_value: declaredValue, timeout: 25000,
    ...(providerSlug ? { pickup_point_provider_slug: providerSlug, providers: [providerSlug] } : {}),
    ...(collection.point ? { collection_pickup_point_location_id: Number(collection.point.id) } : {}),
    ...(delivery.point ? { delivery_pickup_point_location_id: Number(delivery.point.id) } : {}),
  };
}

export function deliveryShipmentPayload(snapshot: CourierBookingSnapshot, parcel: PackedParcel, orderNumber: string, reference: string, declaredValue: number) {
  const { collection, delivery } = snapshot;
  const sender = contactName(collection.contact.name), recipient = contactName(delivery.contact.name);
  return {
    collection_address: collection.address, collection_contact_name: sender.name, collection_contact_surname: sender.surname,
    collection_contact_email: collection.contact.email, collection_contact_mobile_number: collection.contact.phone,
    delivery_address: delivery.address, delivery_contact_name: recipient.name, delivery_contact_surname: recipient.surname,
    delivery_contact_email: delivery.contact.email, delivery_contact_mobile_number: delivery.contact.phone,
    parcels: parcelPayload(parcel, orderNumber), declared_value: declaredValue, timeout: 20000,
    custom_tracking_reference: reference, custom_order_number: orderNumber,
    instructions_collection: snapshot.collectionInstructions, instructions_delivery: snapshot.deliveryInstructions,
    ...(collection.kind === "door" ? collectionShipmentSchedule(snapshot.collectionSchedule) : {}),
    provider_slug: snapshot.providerSlug, service_level_code: snapshot.serviceCode,
    ...(snapshot.rateRequestId ? { selected_rate_request_id: snapshot.rateRequestId } : {}),
    ...(collection.point ? { collection_pickup_point_location_id: Number(collection.point.id) } : {}),
    ...(delivery.point ? { delivery_pickup_point_location_id: Number(delivery.point.id) } : {}),
  };
}

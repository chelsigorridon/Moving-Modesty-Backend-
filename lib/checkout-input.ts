import { z } from "zod";

export const southAfricanProvinces = [
  "Eastern Cape", "Free State", "Gauteng", "KwaZulu-Natal", "Limpopo",
  "Mpumalanga", "North West", "Northern Cape", "Western Cape",
] as const;

export function normalizeCheckoutPhone(value: string) {
  return value.trim().replace(/[\s().-]/g, "").replace(/^0027/, "+27");
}

const addressSchema = z.object({
  line1: z.string().trim().min(2, "Please enter your street address.").max(180),
  line2: z.string().trim().max(180).optional().default(""),
  suburb: z.string().trim().min(2, "Please enter your suburb.").max(100),
  city: z.string().trim().min(2, "Please enter your city.").max(100),
  province: z.string().trim().pipe(z.enum(southAfricanProvinces, { error: "Please choose your province." })),
  postalCode: z.string().trim().regex(/^\d{4}$/, "Please enter a valid postal code."),
});

const orderSchema = z.object({
  checkoutToken: z.string().uuid(),
  stage: z.enum(["started", "fulfilment", "address", "complete"]),
  customer: z.object({
    firstName: z.string().trim().min(1, "Please enter your first name.").max(80),
    lastName: z.string().trim().min(1, "Please enter your last name.").max(80),
    email: z.string().trim().email("Please enter a valid email address.").max(180).toLowerCase(),
    phone: z.string().max(30).transform(normalizeCheckoutPhone)
      .refine(value => /^(?:0\d{9}|\+?27\d{9})$/.test(value), "Please enter a valid South African phone number."),
  }),
  fulfilmentMethod: z.enum(["delivery", "collection", "to_be_confirmed"]),
  address: addressSchema.optional(),
  items: z.array(z.object({
    sku: z.string().trim().min(3).max(80),
    quantity: z.number().int().min(1).max(10),
  })).min(1).max(20),
}).superRefine((input, context) => {
  if (input.stage === "complete" && input.fulfilmentMethod === "to_be_confirmed") {
    context.addIssue({ code: "custom", path: ["fulfilmentMethod"], message: "Choose delivery or collection before paying." });
  }
  const needsAddress = input.fulfilmentMethod === "delivery" && ["address", "complete"].includes(input.stage);
  if (needsAddress && !input.address) {
    context.addIssue({ code: "custom", path: ["address"], message: "Enter a delivery address." });
  }
});

export const checkoutOrderSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const needsAddress = input.fulfilmentMethod === "delivery" && (input.stage === "address" || input.stage === "complete");
  // Early steps and collection must never validate or persist hidden address fields.
  return needsAddress ? input : { ...input, address: undefined };
}, orderSchema);

export type CheckoutOrderInput = z.infer<typeof checkoutOrderSchema>;

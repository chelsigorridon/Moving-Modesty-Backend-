import { z } from "zod";

export const contactInputSchema = z.object({
  submissionId: z.string().uuid(),
  name: z.string().trim().min(2, "Please enter your name.").max(100),
  email: z.string().trim().toLowerCase().email("Please enter a valid email address.").max(254),
  message: z.string().trim().min(10, "Please enter a message of at least 10 characters.").max(4000),
  website: z.string().max(200).optional().default(""),
});

export type ContactInput = z.infer<typeof contactInputSchema>;

export function contactOriginAllowed(origin: string | null, requestUrl: string, storeUrl: string) {
  if (!origin) return false;
  try {
    const allowed = new Set([new URL(requestUrl).origin, new URL(storeUrl).origin]);
    return allowed.has(new URL(origin).origin) && new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

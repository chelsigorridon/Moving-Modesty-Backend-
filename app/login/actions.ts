"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { authenticateAdmin, consumeAdminLoginAttempt, createAdminSession, destroyAdminSession } from "@/lib/auth";
import { reportFailure } from "@/lib/monitoring";

export type LoginState = { error?: string };

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const credentials = loginSchema.safeParse({ email, password });
  if (!credentials.success) return { error: "Enter a valid email address and password." };
  try {
    // The legacy server form must share the API's durable throttle, not bypass it.
    const request = new Request("https://movingmodesty.vercel.app/login", { headers: await headers() });
    const limit = await consumeAdminLoginAttempt(request, credentials.data.email);
    if (!limit.allowed) return { error: "Too many sign-in attempts. Please wait a few minutes before trying again." };
    if (!(await authenticateAdmin(credentials.data.email, credentials.data.password))) return { error: "Those login details are not correct." };
    await createAdminSession(credentials.data.email);
  } catch (error) {
    const incident = await reportFailure(error, { operation: "admin_login" });
    return { error: `Sign-in is temporarily unavailable. Reference: ${incident.reference}` };
  }
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroyAdminSession();
  redirect("/login");
}

"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { authenticateAdmin, createAdminSession, destroyAdminSession } from "@/lib/auth";

export type LoginState = { error?: string };

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const credentials = loginSchema.safeParse({ email, password });
  if (!credentials.success) return { error: "Enter a valid email address and password." };
  if (!(await authenticateAdmin(credentials.data.email, credentials.data.password))) return { error: "Those login details are not correct." };
  await createAdminSession(credentials.data.email);
  redirect("/dashboard");
}

export async function logoutAction() {
  await destroyAdminSession();
  redirect("/login");
}

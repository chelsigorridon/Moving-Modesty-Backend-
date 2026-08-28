import { Sparkles } from "lucide-react";
import { redirect } from "next/navigation";
import { getCurrentAdmin, isAuthConfigured } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Admin login" };

export default async function LoginPage() {
  if (await getCurrentAdmin()) redirect("/dashboard");
  return (
    <main className="login-page">
      <section className="login-brand-panel"><div className="login-brand"><span><Sparkles size={18} /></span><strong>Moving Modesty</strong></div><div><p className="eyebrow">Admin portal</p><h1>The quiet side of running a beautiful store.</h1><p>Orders, inventory and customer care—thoughtfully organised in one place.</p></div><small>Moving Modesty · South Africa</small></section>
      <section className="login-form-panel"><div className="login-card"><p className="eyebrow">Welcome back</p><h2>Sign in to your store</h2><p>Use the administrator details configured for Moving Modesty.</p>{isAuthConfigured() ? <LoginForm /> : <div className="config-notice"><strong>Admin access needs configuring</strong><p>Add the admin and authentication values from <code>.env.example</code> to Vercel before the portal goes live.</p></div>}</div></section>
    </main>
  );
}

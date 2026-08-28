"use client";

import { useActionState } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <form className="login-form" action={action}>
      <label>Email address<input name="email" type="email" autoComplete="email" placeholder="owner@movingmodesty.co.za" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" placeholder="Your password" required /></label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="button button-primary button-full" disabled={pending} type="submit">{pending ? <><LoaderCircle className="spin" size={16} /> Signing in</> : <>Sign in <ArrowRight size={16} /></>}</button>
    </form>
  );
}

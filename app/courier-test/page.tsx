import type { Metadata } from "next";
import CourierTest from "@/components/courier-test";
import "./test.css";

export const metadata: Metadata = { title: "Private courier test", robots: { index: false, follow: false } };
export default function Page() { return <CourierTest />; }

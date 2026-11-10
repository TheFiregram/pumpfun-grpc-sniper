import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "THE HAWK | Solana Execution Terminal", description: "Launch monitoring, wallet operations and multi-route execution research for Solana." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
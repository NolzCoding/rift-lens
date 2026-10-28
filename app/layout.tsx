import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rift Lens — Replay intelligence",
  description: "Post-game League of Legends replay review for any champion",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

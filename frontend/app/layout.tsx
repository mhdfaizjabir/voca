import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://voca-ai.local"),
  title: "Voca AI — Talk it through before it counts",
  description:
    "Practice vivas and mock interviews out loud with a live AI voice partner, then get scored on exactly how you did.",
  applicationName: "Voca AI",
  openGraph: {
    title: "Voca AI — Talk it through before it counts",
    description:
      "Practice vivas and mock interviews out loud with a live AI voice partner, then get scored on exactly how you did.",
    siteName: "Voca AI",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Voca AI — Talk it through before it counts",
    description: "Practice vivas and mock interviews with a live AI voice partner, then get scored instantly.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

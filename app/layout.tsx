import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Location Studio · MotionX",
  description: "From a place in the script to a world you can build.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

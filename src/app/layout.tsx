import type { Metadata } from "next";
import "@arco-design/web-react/dist/css/arco.css";
import "./globals.css";
import { ArcoProvider } from "@/components/arco-provider";

export const metadata: Metadata = {
  title: {
    default: "Envoy",
    template: "%s · Envoy",
  },
  description: "A unified email delivery control plane for every product.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><ArcoProvider>{children}</ArcoProvider></body>
    </html>
  );
}

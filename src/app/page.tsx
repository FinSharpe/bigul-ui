import { redirect } from "next/navigation";
import { ChatApp } from "@/components/chat-app";
import { getServerSession, isEmbedded } from "@/lib/auth/session";

// Server-side gate; proxy.ts is only the first, optimistic check.
export default async function ChatPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  return (
    <ChatApp
      clientCode={session.clientCode}
      embedded={await isEmbedded()}
    />
  );
}

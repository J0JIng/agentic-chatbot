import ChatbotShell from "@/components/chatbot_components/ChatbotShell";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold text-slate-800">Agentic Chatbot</h1>
        <p className="mt-2 text-slate-500">Sign in and click the button in the bottom-right corner to start.</p>
      </div>
      <ChatbotShell />
    </main>
  );
}

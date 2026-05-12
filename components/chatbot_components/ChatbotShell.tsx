"use client";

import React, { useState, useEffect, useRef } from "react";
import Chatbot from "./Chatbot";
import ChatbotButton from "./ChatbotButton";
import { useAuth } from "@/context/authContext";
import TextSelectionHandler from "./TextSelectionHandler";

class ChatbotErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ChatbotErrorBoundary] Uncaught error:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alertdialog"
          aria-label="Chatbot error"
          className="fixed right-0 top-16 bottom-0 w-[400px] bg-white shadow-2xl border-l border-slate-200 flex flex-col items-center justify-center gap-4 z-40 p-8 text-center"
        >
          <p className="text-slate-600 text-sm">
            Something went wrong with the assistant. Please refresh the page.
          </p>
          <button
            className="px-4 py-2 rounded bg-blue-500 text-white text-sm hover:bg-blue-600"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Mounts the chatbot panel, trigger button, text selection handler and error boundary. */
export default function ChatbotShell() {
  const [isOpen, setIsOpen] = useState(false);
  const [width, setWidth] = useState(400);
  const [activeContext, setActiveContext] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen && triggerRef.current) {
      triggerRef.current.focus();
    }
  }, [isOpen]);

  const onResize = (w: number) => setWidth(w);
  const onClose = () => setIsOpen(false);
  const onToggle = () => setIsOpen((s) => !s);
  const onClearContext = () => setActiveContext(null);

  const onSelectText = (text: string) => {
    setActiveContext(text);
    setIsOpen(true);
  };

  const { user, loading } = useAuth();
  const isAuthenticated = !loading && user;

  useEffect(() => {
    const prevMargin = document.body.style.marginRight || "";
    const prevTransition = document.body.style.transition || "";
    const prevClass = document.body.className || "";
    const prevPaddingTop = document.body.style.paddingTop || "";
    const root = document.documentElement;

    const nextEl = document.getElementById("__next");
    const navbarEl = document.getElementById("global-navbar");

    if (isOpen) {
      document.body.style.transition = "margin-right 200ms ease";
      document.body.style.marginRight = `${width}px`;
      root.style.setProperty("--chat-width", `${width}px`);
      document.body.classList.add("chat-open");

      if (nextEl) nextEl.style.marginRight = `${width}px`;
      if (navbarEl) {
        const h = navbarEl.offsetHeight || 0;
        document.body.style.paddingTop = `${h}px`;
      }
    } else {
      document.body.style.marginRight = "";
      document.body.style.transition = prevTransition;
      root.style.setProperty("--chat-width", `0px`);
      document.body.classList.remove("chat-open");

      if (nextEl) nextEl.style.marginRight = "";
      document.body.style.paddingTop = prevPaddingTop;
    }

    return () => {
      document.body.style.marginRight = prevMargin;
      document.body.style.transition = prevTransition;
      root.style.removeProperty("--chat-width");
      document.body.className = prevClass;
      if (nextEl) nextEl.style.marginRight = "";
      document.body.style.paddingTop = prevPaddingTop;
    };
  }, [isOpen, width]);

  return (
    <>
      <TextSelectionHandler onSelectText={onSelectText} />
      {!isOpen && <ChatbotButton ref={triggerRef} onClick={onToggle} isOpen={isOpen} />}
      <ChatbotErrorBoundary>
        <Chatbot
          isOpen={isOpen}
          width={width}
          onResize={onResize}
          onClose={onClose}
          activeContext={activeContext}
          onClearContext={onClearContext}
        />
      </ChatbotErrorBoundary>
    </>
  );
}

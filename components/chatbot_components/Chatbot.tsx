"use client";
import React, { useState, useRef, useEffect, useMemo } from "react";
import { useAuth } from "@/context/authContext";
import { useRouter } from "@/src/i18n/navigation";
import ReactMarkdown from "react-markdown";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import Image from "next/image";
import * as Popover from "@radix-ui/react-popover";
import * as Tooltip from "@radix-ui/react-tooltip";
import { FocusScope } from "@radix-ui/react-focus-scope";
import * as AccordionPrimitive from "@radix-ui/react-accordion"; 
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"; 

import {
  Send,
  X,
  RotateCcw,
  User,
  Bot,
  Sparkles,
  Info,
  ChevronDown,
  Check,
  ExternalLink,
  PlayCircle,
  Copy,
  Brain,
  ShieldCheck,
  Search,
  Filter,
  Lock as LockIcon,
  Square,
  ShieldAlert,
  AlignLeft,
  Lightbulb,
  BookOpen,
  LayoutGrid,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  GraduationCap,
  MapPin,
  Bookmark,
  BookmarkCheck,
  ArrowLeftRight,
} from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: Date;
  feedback?: "up" | "down" | null;
  streamError?: boolean;           // marks a partially-streamed message after a network error
  // (SSE): structured fields populated from typed SSE events during streaming.
  // Absent (undefined) for messages restored from localStorage in the old tag-embedded format.
  thoughtContent?: string;
  courseCards?: any[];
  followUpQuestions?: string[];
  hallucinationWarning?: boolean;
  // populated from recommendation_meta SSE event for roadmap rendering
  intent?: string;
  skillLevel?: string;
  searchQuery?: string;
};

interface ChatbotProps {
  isOpen: boolean;
  /** Retained for parent-component compatibility; panel is now fixed 400 px. */
  width: number;
  /** Retained for parent-component compatibility; resize handle removed. */
  onResize: (width: number) => void;
  onClose: () => void;
  activeContext: string | null;
  onClearContext: () => void;
}

const CHIP_SETS = {
  default: [
    { label: "Recommend courses",  icon: BookOpen   },
    { label: "Learning tips?",     icon: Lightbulb  },
    { label: "App features",       icon: LayoutGrid },
    { label: "Summarize our talk", icon: AlignLeft  },
  ],
  recommendation: [
    { label: "Find more like these",       icon: Search    },
    { label: "Different difficulty level", icon: Filter    },
    { label: "What should I build first?", icon: Lightbulb },
    { label: "Show learning path",         icon: BookOpen  },
  ],
  faq: [
    { label: "How do I enroll?",                   icon: BookOpen   },
    { label: "What payment methods are supported?", icon: LayoutGrid },
    { label: "Can you recommend courses?",          icon: Sparkles   },
    { label: "Show me free courses",               icon: Search     },
  ],
  general: [
    { label: "Can you recommend courses on this?", icon: BookOpen  },
    { label: "What's the next step?",              icon: Sparkles  },
    { label: "Show a learning path",               icon: Filter    },
    { label: "Summarize our talk",                 icon: AlignLeft },
  ],
} as const;

/** Below this panel width the chips collapse to icon-only with tooltips. */
const CHIP_COMPACT_BREAKPOINT = 460;

function getGreeting(displayName?: string | null): string {
  const hour = new Date().getHours();
  const salutation =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = displayName?.split(" ")[0];
  return firstName ? `${salutation}, ${firstName}` : salutation;
}

const STARTER_CARDS: { icon: React.ElementType; label: string; hint: string }[] = [
  {
    icon: Search,
    label: "Find courses for me",
    hint: "Personalised to your skill level and interests",
  },
  {
    icon: Sparkles,
    label: "What should I learn next?",
    hint: "Get an AI-powered learning path recommendation",
  },
  {
    icon: Info,
    label: "How does the platform work?",
    hint: "Enrolling, features, certifications and more",
  },
];

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#10527c] focus-visible:ring-offset-2";

// parseAssistantMessage/parseAgentLogs are module-scope so React.useMemo can cache
// results across renders triggered by non-message state changes (isLoading, copiedId,
// showScrollButton, etc.), avoiding O(n×chunks) redundant regex work during streaming.

type ParsedMessage = {
  thoughtText: string;
  agentSteps: { agent: string; message: string }[];
  finalAnswer: string;
  courseCards: any[];
  followUpQuestions: string[];
};

function parseAgentLogs(text: string): { agent: string; message: string }[] {
  const agentTagRegex =
    /\[(CLASSIFIER|RESEARCHER|CURATOR|SAFETY)\]:?\s*([\s\S]*?)(?=\[(?:CLASSIFIER|RESEARCHER|CURATOR|SAFETY)\]|$)/g;
  const steps: { agent: string; message: string }[] = [];
  let lastIndex = 0;
  let match;

  while ((match = agentTagRegex.exec(text)) !== null) {
    // Capture free-form text before the first tag (previously lost)
    if (match.index > lastIndex) {
      const prolog = text.slice(lastIndex, match.index).trim();
      if (prolog) steps.push({ agent: "THINKER", message: prolog });
    }
    steps.push({ agent: match[1], message: match[2].trim() });
    lastIndex = match.index + match[0].length;
  }

  const epilog = text.slice(lastIndex).trim();
  if (epilog) steps.push({ agent: "THINKER", message: epilog });

  // No agent tags at all — treat entire thought as a single THINKER step
  if (steps.length === 0 && text.trim()) {
    steps.push({ agent: "THINKER", message: text.trim() });
  }

  return steps;
}

// Full parsing pipeline for the OLD tag-embedded wire format.
// Only called as a fallback when msg.courseCards === undefined
function parseAssistantMessage(content: string): ParsedMessage {
  let thoughtText = "";
  let finalAnswer = content;
  const courseCards: any[] = [];
  let followUpQuestions: string[] = [];

  if (content.includes("<thought>")) {
    const thoughtRegex = /<thought>([\s\S]*?)<\/thought>/g;
    let tMatch;
    let lastThoughtEnd = 0;

    while ((tMatch = thoughtRegex.exec(content)) !== null) {
      thoughtText += (thoughtText ? "\n" : "") + tMatch[1].trim();
      lastThoughtEnd = tMatch.index + tMatch[0].length;
    }

    // Handle unclosed <thought> block at stream end (active streaming)
    const lastOpenIndex = content.lastIndexOf("<thought>");
    if (
      lastOpenIndex > lastThoughtEnd - 1 &&
      !content.includes("</thought>", lastOpenIndex)
    ) {
      thoughtText +=
        (thoughtText ? "\n" : "") +
        content.substring(lastOpenIndex + "<thought>".length).trim();
      finalAnswer = ""; // Still thinking — don't show partial answer
    } else {
      finalAnswer = content.replace(/<thought>[\s\S]*?<\/thought>/g, "").trim();
    }
  }

  // Rescue agent tags that leaked outside <thought> into thoughtText
  // so the Reasoning popover shows all available agent steps.
  // Must run before parseAgentLogs() so rescued tags are included.
  if (finalAnswer) {
    const leakedTagRegex = /\n?\[(CLASSIFIER|RESEARCHER|CURATOR|SAFETY)\]:?[^\n]*/g;
    const leakedMatches = finalAnswer.match(leakedTagRegex);
    if (leakedMatches) {
      const rescued = leakedMatches.map((t) => t.trim()).join("\n");
      thoughtText = thoughtText ? thoughtText + "\n" + rescued : rescued;
    }
  }

  // Parse agent-step tags within thought text (includes any rescued tags)
  const agentSteps = parseAgentLogs(thoughtText);

  // Kept in msg.content for API conversation history; stripped from display only.
  finalAnswer = finalAnswer
    .replace(/\[RECOMMENDATION_META\][\s\S]*?\[\/RECOMMENDATION_META\]/g, "")
    .trim();

  // Handles the optional secondaryQuery field added for comparison intent —
  // without this, classifier JSON leaks verbatim into the chat bubble.
  finalAnswer = finalAnswer
    .replace(
      /^\s*\{"intent"\s*:\s*"[^"]*"\s*,\s*"searchQuery"\s*:\s*"[^"]*"(?:\s*,\s*"secondaryQuery"\s*:\s*"[^"]*")?\s*\}\s*/g,
      ""
    )
    .trim();

  // Tags are already saved to thoughtText above; strip from finalAnswer so they don't render.
  finalAnswer = finalAnswer
    .replace(
      /\n?\[(CLASSIFIER|RESEARCHER|CURATOR|SAFETY)\]:?[^\n]*/g,
      ""
    )
    .trim();

  const courseRegex = /\[COURSE_CARD\]([\s\S]*?)\[\/COURSE_CARD\]/g;
  let cardMatch;
  while ((cardMatch = courseRegex.exec(finalAnswer)) !== null) {
    try {
      courseCards.push(JSON.parse(cardMatch[1]));
    } catch (e) {
      console.error("Failed to parse course card JSON", e);
    }
  }
  finalAnswer = finalAnswer
    .replace(/\[COURSE_CARD\][\s\S]*?\[\/COURSE_CARD\]/g, "")
    .trim();

  if (finalAnswer.includes("[FOLLOW_UP]:")) {
    const parts = finalAnswer.split("[FOLLOW_UP]:");
    finalAnswer = parts[0].trim();
    const followUpRaw = parts[1]?.trim() || "";
    if (followUpRaw) {
      followUpQuestions = followUpRaw
        .split("|")
        .map((q) => q.trim().replace(/^[\d.\-\*]*\s*/, ""))
        .filter((q) => q.length > 0);
    }
  }

  return { thoughtText, agentSteps, finalAnswer, courseCards, followUpQuestions };
}

function titleCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

const TIER_STYLES: Record<string, string> = {
  beginner:     "bg-emerald-100 text-emerald-700 border-emerald-200",
  intermediate: "bg-amber-100 text-amber-700 border-amber-200",
  advanced:     "bg-rose-100 text-rose-700 border-rose-200",
};

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  const cls = TIER_STYLES[tier] ?? "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${cls}`}>
      {tier}
    </span>
  );
}

export default function Chatbot({
  isOpen,
  width,
  onResize,
  onClose,
  activeContext,
  onClearContext,
}: ChatbotProps) {
  const { user } = useAuth();
  const router = useRouter(); // U4: locale-aware navigation for platform course enrolment
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [feedbackMap, setFeedbackMap] = useState<Map<string, "up" | "down">>(new Map());
  const [msgToPathId, setMsgToPathId] = useState<Map<string, string>>(new Map()); // msgId → pathId
  const [pathProgressMap, setPathProgressMap] = useState<Map<string, { completed: Set<string>; progressPercent: number }>>(new Map());
  const [savingPathId, setSavingPathId] = useState<string | null>(null); // msgId currently being saved

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<Message[]>([]);

  const prefersReducedMotion = useReducedMotion();

  // Memoised parsing — recomputed only when messages change, not on every render
  // triggered by isLoading, copiedId, showScrollButton, etc.
  
  // Messages carry structured SSE fields (courseCards, followUpQuestions, thoughtContent).
  // parseAgentLogs() runs to build agentSteps from the buffered thought content.
  // Legacy messages restored from localStorage (courseCards === undefined) still go
  // through the full parseAssistantMessage() fallback.
  const parsedMessageMap = useMemo(() => {
    const map = new Map<string, ParsedMessage>();
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.content) {
        if (msg.courseCards !== undefined) {
          // SSE-structured message — construct ParsedMessage from typed fields directly
          const thoughtText = msg.thoughtContent ?? "";
          map.set(msg.id, {
            thoughtText,
            agentSteps: parseAgentLogs(thoughtText),
            finalAnswer: msg.content,
            courseCards: msg.courseCards,
            followUpQuestions: msg.followUpQuestions ?? [],
          });
        } else {
          // Legacy (localStorage-restored) message — use full regex parsing pipeline
          map.set(msg.id, parseAssistantMessage(msg.content));
        }
      }
    }
    return map;
  }, [messages]);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
  useEffect(() => {
    if (!user?.uid) return;
    try {
      const raw = localStorage.getItem(`journey-chat-${user.uid}`);
      if (!raw) return;
      const { messages: saved, savedAt } = JSON.parse(raw);
      if (Date.now() - savedAt > STORAGE_TTL_MS) {
        localStorage.removeItem(`journey-chat-${user.uid}`);
        return;
      }
      // Rehydrate Date objects (JSON.parse deserialises them as strings)
      setMessages(
        saved.map((m: any) => ({
          ...m,
          createdAt: m.createdAt ? new Date(m.createdAt) : undefined,
        }))
      );
    } catch {
      // Silently ignore corrupted or over-quota storage
    }
  }, [user?.uid]);

  useEffect(() => {
    if (!user?.uid || messages.length === 0) return;
    try {
      localStorage.setItem(
        `journey-chat-${user.uid}`,
        JSON.stringify({ messages, savedAt: Date.now() })
      );
    } catch {
      // Silently ignore write errors (e.g. storage quota exceeded)
    }
  }, [messages, user?.uid]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 300 && newWidth <= 720) onResize(newWidth);
    };
    const onUp = () => setIsResizing(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isResizing, onResize]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => textareaRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const adjustHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    }
  };
  useEffect(() => { adjustHeight(); }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const resetConversation = () => {
    setMessages([]);
    setFeedbackMap(new Map());
    onClearContext();
    // U2: clear persisted session so the next open starts fresh
    if (user?.uid) {
      try { localStorage.removeItem(`journey-chat-${user.uid}`); } catch {}
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  useEffect(() => { scrollToBottom(); }, [messages, isOpen]);

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    setShowScrollButton(scrollHeight - scrollTop - clientHeight > 100);
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSubmit = async (e: React.FormEvent, customInput?: string) => {
    if (e) e.preventDefault();
    const messageContent = customInput || input;
    if (!messageContent.trim() || isLoading) return;

    let displayContent = messageContent;
    if (activeContext) displayContent = `${activeContext}\n\n${messageContent}`;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: displayContent,
      createdAt: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    const ac = new AbortController();
    setAbortController(ac);
    if (activeContext) onClearContext();

    try {
      // Limit history sent to the API to prevent server-side context
      // Last 20 messages is sufficient for coherent multi-turn context while keeping payload size bounded.
      const messagesToSend = [...messages, userMessage]
        .filter((m) => m.content.trim() !== "")
        .slice(-20);

      const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (user) {
        const idToken = await user.getIdToken();
        fetchHeaders["Authorization"] = `Bearer ${idToken}`;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: fetchHeaders,
        signal: ac.signal,
        body: JSON.stringify({
          messages: messagesToSend.map((m) => ({ role: m.role, content: m.content })),
          data: { context: activeContext },
        }),
      });

      // Handle rate-limit response before starting the stream.
      // A 429 arrives before any assistant message is created, so provide an err message and return early.
      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter ? parseInt(retryAfter, 10) : 60;
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            content: `Too many requests. Please wait ${seconds} second${seconds !== 1 ? "s" : ""} before sending another message.`,
            createdAt: new Date(),
          },
        ]);
        return;
      }

      if (!response.ok) throw new Error("Failed to fetch");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No reader available");

      const assistantId = (Date.now() + 1).toString();
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: new Date(),
          // initialise structured fields so parsedMessageMap uses the fast path
          courseCards: [],
          followUpQuestions: [],
          thoughtContent: "",
          hallucinationWarning: false,
        },
      ]);

      let done = false;
      let streamComplete = false;
      let assistantContent = "";
      let sseLineBuffer = "";
      // SSE structured fields accumulated locally, synced to messages state per event
      let thoughtContent = "";
      let courseCardsList: any[] = [];
      let followUpList: string[] = [];
      let hallucinationWarningFlag = false;
      // populated from recommendation_meta SSE event for roadmap rendering
      let msgIntent = "";
      let msgSkillLevel = "";
      let msgSearchQuery = "";

      // SSE event parser reads `event: <type>\ndata: <JSON>\n\n` frames.
      while (!done && !streamComplete) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;

        if (value) {
          sseLineBuffer += decoder.decode(value, { stream: !done });

          // SSE events are separated by a blank line (\n\n).
          // Split on that boundary; keep the last (potentially incomplete) segment.
          const eventBlocks = sseLineBuffer.split("\n\n");
          sseLineBuffer = eventBlocks.pop() ?? "";

          for (const eventBlock of eventBlocks) {
            if (!eventBlock.trim()) continue;

            let eventType = "";
            let eventData = "";
            for (const line of eventBlock.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) eventData = line.slice(6).trim();
            }
            if (!eventType || !eventData) continue;

            try {
              const data = JSON.parse(eventData);

              switch (eventType) {
                case "token":
                  assistantContent += data.content;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                      msg.hallucinationWarning = hallucinationWarningFlag;
                    }
                    return updated;
                  });
                  break;

                case "thought":
                  if (data.content?.trim()) {
                    thoughtContent = data.content;
                    setMessages((prev) => {
                      const updated = [...prev];
                      const msg = updated.find((m) => m.id === assistantId);
                      if (msg) {
                        msg.thoughtContent = thoughtContent;
                        msg.courseCards = courseCardsList;
                        msg.followUpQuestions = followUpList;
                      }
                      return updated;
                    });
                  }
                  break;

                case "course_card":
                  courseCardsList = [...courseCardsList, data];
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;

                case "follow_up":
                  followUpList = data.questions ?? [];
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;

                case "recommendation_meta":
                  // capture intent/skillLevel/query for personalised roadmap rendering
                  if (data.intent) msgIntent = data.intent;
                  if (data.skillLevel) msgSkillLevel = data.skillLevel;
                  if (data.query) msgSearchQuery = data.query;
                  break;

                case "section_header":
                  // silently consumed. tier fields on cards are authoritative.
                  // this event is retained for diagnostics and future comparerNode use.
                  break;

                case "block":
                  assistantContent = `[BLOCKED]: ${data.reason ?? "Safety Violation"}`;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.courseCards = [];
                      msg.followUpQuestions = [];
                      msg.thoughtContent = "";
                    }
                    return updated;
                  });
                  streamComplete = true;
                  break;

                case "hallucination_warning":
                  hallucinationWarningFlag = true;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.hallucinationWarning = true;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;

                case "done":
                  // Final sync. All accumulated state committed in one update
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                      msg.hallucinationWarning = hallucinationWarningFlag;
                      if (msgIntent) msg.intent = msgIntent;
                      if (msgSkillLevel) msg.skillLevel = msgSkillLevel;
                      if (msgSearchQuery) msg.searchQuery = msgSearchQuery;
                    }
                    return updated;
                  });
                  streamComplete = true;
                  break;
              }
            } catch (e) {
              console.error("[Chatbot] SSE parse error:", e);
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        console.error("Chatbot streaming error:", error);
        // preserve any partial text already streamed. 
        // can mark with streamError so the retry UI renders below the message.
        setMessages((prev) => {
          const updated = [...prev];
          const lastMsg = updated[updated.length - 1];
          if (lastMsg?.role === "assistant") {
            if (!lastMsg.content) lastMsg.content = "";
            lastMsg.streamError = true;
          }
          return updated;
        });
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const handleStop = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
    }
  };

  /**
   * Streaming error recovery.
   * Removes the errored assistant message (keeping the user message visible),
   * then re-sends the same conversation history to the API.
   * Uses messagesRef to read current messages without stale-closure issues.
   */
  const handleRetry = async (errorMessageId: string) => {
    if (isLoading) return;

    const current = messagesRef.current;
    const historyWithoutError = current.filter((m) => m.id !== errorMessageId);

    const assistantId = Date.now().toString();
    setMessages([
      ...historyWithoutError,
      {
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: new Date(),
        courseCards: [],
        followUpQuestions: [],
        thoughtContent: "",
        hallucinationWarning: false,
      },
    ]);
    setIsLoading(true);

    const ac = new AbortController();
    setAbortController(ac);

    try {
      const retryHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (user) {
        const idToken = await user.getIdToken();
        retryHeaders["Authorization"] = `Bearer ${idToken}`;
      }

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: retryHeaders,
        signal: ac.signal,
        body: JSON.stringify({
          messages: historyWithoutError.slice(-20).map((m) => ({ role: m.role, content: m.content })),
          data: {},
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No reader available");

      let done = false;
      let streamComplete = false;
      let assistantContent = "";
      let sseLineBuffer = "";
      let thoughtContent = "";
      let courseCardsList: any[] = [];
      let followUpList: string[] = [];
      let hallucinationWarningFlag = false;
      // populated from recommendation_meta SSE event for roadmap rendering
      let msgIntent = "";
      let msgSkillLevel = "";
      let msgSearchQuery = "";

      while (!done && !streamComplete) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
          sseLineBuffer += decoder.decode(value, { stream: !done });
          const eventBlocks = sseLineBuffer.split("\n\n");
          sseLineBuffer = eventBlocks.pop() ?? "";

          for (const eventBlock of eventBlocks) {
            if (!eventBlock.trim()) continue;
            let eventType = "";
            let eventData = "";
            for (const line of eventBlock.split("\n")) {
              if (line.startsWith("event: ")) eventType = line.slice(7).trim();
              else if (line.startsWith("data: ")) eventData = line.slice(6).trim();
            }
            if (!eventType || !eventData) continue;
            try {
              const data = JSON.parse(eventData);
              switch (eventType) {
                case "token":
                  assistantContent += data.content;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                      msg.hallucinationWarning = hallucinationWarningFlag;
                    }
                    return updated;
                  });
                  break;
                case "thought":
                  if (data.content?.trim()) {
                    thoughtContent = data.content;
                    setMessages((prev) => {
                      const updated = [...prev];
                      const msg = updated.find((m) => m.id === assistantId);
                      if (msg) {
                        msg.thoughtContent = thoughtContent;
                        msg.courseCards = courseCardsList;
                        msg.followUpQuestions = followUpList;
                      }
                      return updated;
                    });
                  }
                  break;
                case "course_card":
                  courseCardsList = [...courseCardsList, data];
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;
                case "follow_up":
                  followUpList = data.questions ?? [];
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;
                case "recommendation_meta":
                  // capture intent/skillLevel/query for personalised roadmap rendering
                  if (data.intent) msgIntent = data.intent;
                  if (data.skillLevel) msgSkillLevel = data.skillLevel;
                  if (data.query) msgSearchQuery = data.query;
                  break;
                case "section_header":
                  // silently consumed. tier fields on cards are authoritative
                  break;
                case "block":
                  assistantContent = `[BLOCKED]: ${data.reason ?? "Safety Violation"}`;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.courseCards = [];
                      msg.followUpQuestions = [];
                      msg.thoughtContent = "";
                    }
                    return updated;
                  });
                  streamComplete = true;
                  break;
                case "hallucination_warning":
                  hallucinationWarningFlag = true;
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.hallucinationWarning = true;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                    }
                    return updated;
                  });
                  break;
                case "done":
                  setMessages((prev) => {
                    const updated = [...prev];
                    const msg = updated.find((m) => m.id === assistantId);
                    if (msg) {
                      msg.content = assistantContent;
                      msg.thoughtContent = thoughtContent;
                      msg.courseCards = courseCardsList;
                      msg.followUpQuestions = followUpList;
                      msg.hallucinationWarning = hallucinationWarningFlag;
                      if (msgIntent) msg.intent = msgIntent;
                      if (msgSkillLevel) msg.skillLevel = msgSkillLevel;
                      if (msgSearchQuery) msg.searchQuery = msgSearchQuery;
                    }
                    return updated;
                  });
                  streamComplete = true;
                  break;
              }
            } catch (e) {
              console.error("[Chatbot] SSE parse error (retry):", e);
            }
          }
        }
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          const msg = updated.find((m) => m.id === assistantId);
          if (msg) { if (!msg.content) msg.content = ""; msg.streamError = true; }
          return updated;
        });
      }
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  /**
   * Thumbs feedback.
   * Optimistic UI update + fire-and-forget POST to /api/chat/feedback.
   */
  const handleFeedback = async (messageId: string, rating: "up" | "down") => {
    setFeedbackMap((prev) => new Map(prev).set(messageId, rating));
    try {
      const msgIndex = messagesRef.current.findIndex((m) => m.id === messageId);
      const conversationalContext = messagesRef.current
        .slice(Math.max(0, msgIndex - 2), msgIndex + 1)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));

      // userId is derived server-side from the token, not the request body.
      if (!user) return;
      const idToken = await user.getIdToken();
      const feedbackHeaders = { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` };

      await fetch("/api/chat/feedback", {
        method: "POST",
        headers: feedbackHeaders,
        body: JSON.stringify({ messageId, rating, conversationalContext }),
      });
    } catch {
      // Optimistic update stays visible. Silently ignore network errors
    }
  };

  /**
   * Save a learning path to Firestore via POST /api/learning-paths.
   * Optimistic UI: button changes to "Saved ✓" immediately 
   * Reverts on error.
   */
  const handleSaveLearningPath = async (msgId: string, courseCards: any[], topic: string) => {
    if (!user || msgToPathId.has(msgId)) return;
    setSavingPathId(msgId);
    try {
      const idToken = await user.getIdToken();
      const steps = [1, 2, 3].map((step) => {
        const stepCards = courseCards.filter((c) => c.step === step);
        const first = stepCards[0];
        return {
          step,
          stepLabel: first?.stepLabel ?? `Step ${step}`,
          tier: first?.tier ?? "beginner",
          courses: stepCards.map((c) => ({
            courseId: c.courseId ?? null,
            title: c.title,
            vendor: c.vendor,
            url: c.url,
            isPaid: c.isPaid ?? false,
            completed: false,
          })),
        };
      });
      const res = await fetch("/api/learning-paths", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ steps, topic, messageId: msgId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { pathId } = await res.json();
      setMsgToPathId((prev) => new Map(prev).set(msgId, pathId));
      setPathProgressMap((prev) => new Map(prev).set(pathId, { completed: new Set(), progressPercent: 0 }));
    } catch {
      // Silently ignore — button returns to unsaved state via savingPathId reset
    } finally {
      setSavingPathId(null);
    }
  };

  /**
   * Toggle a course complete/incomplete within a saved learning path.
   * Optimistic update (local state first, PATCH on server, revert on error).
   */
  const handleToggleCourseComplete = async (pathId: string, courseId: string, completed: boolean) => {
    if (!user || !courseId) return;
    setPathProgressMap((prev) => {
      const entry = prev.get(pathId);
      if (!entry) return prev;
      const next = new Set(entry.completed);
      completed ? next.add(courseId) : next.delete(courseId);
      return new Map(prev).set(pathId, { ...entry, completed: next, progressPercent: entry.progressPercent });
    });
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/learning-paths/${pathId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ courseId, completed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { progressPercent } = await res.json();
      setPathProgressMap((prev) => {
        const entry = prev.get(pathId);
        if (!entry) return prev;
        return new Map(prev).set(pathId, { ...entry, progressPercent });
      });
    } catch {
      setPathProgressMap((prev) => {
        const entry = prev.get(pathId);
        if (!entry) return prev;
        const reverted = new Set(entry.completed);
        completed ? reverted.delete(courseId) : reverted.add(courseId);
        return new Map(prev).set(pathId, { ...entry, completed: reverted });
      });
    }
  };

  const groupedMessages = messages.reduce(
    (acc: Record<string, Message[]>, msg) => {
      const date = msg.createdAt ? msg.createdAt.toDateString() : new Date().toDateString();
      const key = date === new Date().toDateString() ? "Today" : date;
      if (!acc[key]) acc[key] = [];
      acc[key].push(msg);
      return acc;
    },
    {}
  );
  const panelInitial = prefersReducedMotion
    ? { opacity: 0 }
    : isMobile
      ? { y: "100%", opacity: 0 }
      : { x: "100%", opacity: 0 };

  const panelAnimate = prefersReducedMotion
    ? { opacity: 1 }
    : isMobile
      ? { y: 0, opacity: 1 }
      : { x: 0, opacity: 1 };

  const panelExit = prefersReducedMotion
    ? { opacity: 0 }
    : isMobile
      ? { y: "100%", opacity: 0 }
      : { x: "100%", opacity: 0 };

  const panelTransition = prefersReducedMotion
    ? { duration: 0.15 }
    : { type: "tween", duration: 0.2, ease: "easeOut" };

  const panelClass = isMobile
    ? "fixed bottom-0 left-0 right-0 h-[85vh] rounded-t-2xl"
    : "fixed right-0 top-0 bottom-0";

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {isMobile && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 bg-black/40 z-30"
              onClick={onClose}
              aria-hidden="true"
            />
          )}

          {/*
           * FocusScope — keeps Tab/Shift+Tab within the panel while open.
           * Closes on Escape via the useEffect above
           */}
          <FocusScope loop trapped>
            <motion.div
              initial={panelInitial}
              animate={panelAnimate}
              exit={panelExit}
              transition={panelTransition}
              style={!isMobile ? { width: `${width}px` } : undefined}
              className={`${panelClass} bg-white shadow-2xl border-l border-slate-200 flex flex-col z-40 overflow-hidden`}
              role="dialog"
              aria-label="Journey AI Learning Assistant"
              aria-modal="true"
            >
              {/* 
              Resize handle is desktop only
               */}
              {!isMobile && (
                <div
                  role="separator"
                  aria-label="Resize chatbot panel"
                  aria-orientation="vertical"
                  aria-valuenow={width}
                  aria-valuemin={300}
                  aria-valuemax={720}
                  tabIndex={0}
                  onMouseDown={() => setIsResizing(true)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft") {
                      e.preventDefault();
                      onResize(Math.max(300, width - 20));
                    }
                    if (e.key === "ArrowRight") {
                      e.preventDefault();
                      onResize(Math.min(720, width + 20));
                    }
                  }}
                  className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-[#10527c]/20 transition-colors z-50 group ${FOCUS_RING}`}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 bg-slate-300 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              )}

              <header className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-white flex-shrink-0">
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl bg-[#10527c] flex items-center justify-center flex-shrink-0"
                    aria-hidden="true"
                  >
                    <Bot className="w-5 h-5 text-white" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-slate-900">Journey</span>
                      <span role="status" className="flex items-center gap-1">
                        <span
                          className="w-2 h-2 rounded-full bg-emerald-500 flex-shrink-0"
                          aria-hidden="true"
                        />
                        <span className="sr-only">Online</span>
                      </span>
                    </div>
       
                    <p className="text-xs text-slate-500 mt-0.5">AI Learning Assistant</p>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    onClick={resetConversation}
                    aria-label="Start new conversation"
                    className={`p-2.5 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-[#e8f1f8] transition-colors ${FOCUS_RING}`}
                  >
                    <RotateCcw className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button
                    onClick={onClose}
                    aria-label="Close Journey chatbot"
                    className={`p-2.5 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors ${FOCUS_RING}`}
                  >
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </header>

              {/*
               * role="log" + aria-live="polite" — screen readers announce new
               * messages as they appear without re-reading the entire log.
               */}
              <div
                ref={scrollContainerRef}
                role="log"
                aria-live="polite"
                aria-atomic="false"
                aria-label="Conversation with Journey"
                aria-relevant="additions"
                onScroll={handleScroll}
                className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-5 space-y-6 bg-slate-50 custom-scrollbar relative"
              >
                {messages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center px-5 py-10">

                    <motion.div
                      animate={prefersReducedMotion ? {} : { scale: [1, 1.06, 1] }}
                      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                      className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#e8f1f8] to-[#c5d9e8] flex items-center justify-center mb-6 shadow-sm"
                      aria-hidden="true"
                    >
                      <Bot className="w-8 h-8 text-[#10527c]" aria-hidden="true" />
                    </motion.div>

                    <h3 className="text-lg font-bold text-slate-900 leading-tight">
                      {getGreeting(user?.displayName)} 👋
                    </h3>
                    <p className="text-sm text-slate-500 mt-1.5 mb-6 max-w-[230px] leading-relaxed">
                      I&apos;m Journey, your AI learning companion.<br />
                      What would you like to explore today?
                    </p>

                    <div
                      role="group"
                      aria-label="Example questions to get started"
                      className="flex flex-col gap-2.5 w-full"
                    >
                      {STARTER_CARDS.map(({ icon: Icon, label, hint }) => (
                        <button
                          key={label}
                          type="button"
                          onClick={(e) => handleSubmit(e as any, label)}
                          className={`text-left flex items-center gap-3 px-4 py-3 bg-white border border-slate-200 rounded-xl hover:border-[#10527c]/40 hover:bg-[#e8f1f8] hover:shadow-sm transition-all group/card ${FOCUS_RING}`}
                        >
                          <div
                            className="w-8 h-8 rounded-lg bg-[#e8f1f8] group-hover/card:bg-[#10527c]/10 flex items-center justify-center flex-shrink-0 transition-colors"
                            aria-hidden="true"
                          >
                            <Icon className="w-4 h-4 text-[#10527c]" aria-hidden="true" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-slate-800 group-hover/card:text-[#10527c] transition-colors truncate">
                              {label}
                            </p>
                            <p className="text-xs text-slate-400 truncate mt-0.5">{hint}</p>
                          </div>
                          <ChevronDown
                            className="w-4 h-4 -rotate-90 text-slate-300 group-hover/card:text-[#10527c] flex-shrink-0 ml-auto transition-colors"
                            aria-hidden="true"
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {Object.entries(groupedMessages).map(([date, msgs]) => (
                  <div key={date} className="space-y-5">
                    {/* Date divider */}
                    <div className="flex items-center gap-3">
                      <div className="h-px flex-1 bg-slate-200" />
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                        {date}
                      </span>
                      <div className="h-px flex-1 bg-slate-200" />
                    </div>

                    <div className="space-y-5">
                      {msgs.map((msg) => {
                        const isBlocked = msg.content.startsWith("[BLOCKED]:");
                        const blockReason = isBlocked
                          ? msg.content.replace("[BLOCKED]:", "").trim()
                          : "";

                        return (
                          <motion.div
                            layout
                            initial={
                              prefersReducedMotion
                                ? { opacity: 0 }
                                : { opacity: 0, y: 8 }
                            }
                            animate={{ opacity: 1, y: 0 }}
                            transition={
                              prefersReducedMotion
                                ? { duration: 0.15 }
                                : { duration: 0.2 }
                            }
                            key={msg.id}
                            className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}
                          >
                            {/* Avatar (role="log" conveys turn identity) */}
                            <div
                              className={`flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center ${
                                msg.role === "user" ? "bg-[#e8f1f8]" : "bg-[#10527c]"
                              }`}
                              aria-hidden="true"
                            >
                              {msg.role === "user" ? (
                                <User className="w-4 h-4 text-[#10527c]" aria-hidden="true" />
                              ) : (
                                <Bot className="w-4 h-4 text-white" aria-hidden="true" />
                              )}
                            </div>

                            <div
                              className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[82%] group`}
                            >
                              {msg.role === "user" && msg.content.startsWith("[Context from") && (
                                <div className="mb-2 bg-[#e8f1f8] border border-[#c5d9e8] p-3 rounded-2xl rounded-br-sm w-full">
                                  <div className="flex items-center gap-1.5 text-[#10527c] font-bold text-xs uppercase tracking-wider mb-1">
                                    <Info className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Attached Context</span>
                                  </div>
                                  <div className="text-xs text-[#10527c]/80 italic line-clamp-2 border-l-2 border-[#10527c]/30 pl-2">
                                    {(() => {
                                      const m = msg.content.match(/\[Context from.*?\]:\s*"([\s\S]*?)"/);
                                      return m ? `"${m[1].trim()}"` : "Selected Text Context";
                                    })()}
                                  </div>
                                </div>
                              )}

                              <div className="relative w-full">
                                {msg.role === "user" ? (
                                  /* User bubble */
                                  <div className="bg-[#10527c] rounded-2xl rounded-tr-sm px-4 py-3">
                                    <p className="text-sm text-white whitespace-pre-wrap leading-relaxed">
                                      {msg.content.startsWith("[Context from")
                                        ? msg.content.replace(/\[Context from.*?\]:\s*"[\s\S]*?"\s*/, "")
                                        : msg.content}
                                    </p>
                                  </div>
                                ) : isBlocked ? (
                                  /*
                                   * BLOCK_SIGNAL — role="alert" (assertive) so screen readers
                                   * interrupt immediately.
                                   */
                                  <div
                                    role="alert"
                                    className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-2xl rounded-tl-sm w-full"
                                  >
                                    <ShieldAlert
                                      className="w-4 h-4 text-red-700 mt-0.5 flex-shrink-0"
                                      aria-hidden="true"
                                    />
                                    <div>
                                      <p className="font-semibold text-red-700 text-sm">
                                        Message blocked
                                      </p>
                                      <p className="text-xs text-red-600 mt-0.5 leading-relaxed">
                                        {blockReason}. Please rephrase your message and try again.
                                      </p>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-slate-900 prose prose-sm max-w-none prose-p:leading-relaxed w-full">
                                    {(() => {
                                      // Map lookup — live parse fallback during streaming.
                                      // new messages use structured path (no regex);
                                      // legacy localStorage messages use parseAssistantMessage().
                                      const {
                                        thoughtText,
                                        agentSteps,
                                        finalAnswer,
                                        courseCards,
                                        followUpQuestions,
                                      } =
                                        parsedMessageMap.get(msg.id) ??
                                        parseAssistantMessage(msg.content);

                                      // hallucinationWarning is a typed SSE field.
                                      // For legacy messages the field is absent (undefined → false).
                                      const showHallucinationWarning = msg.hallucinationWarning === true;

                                      const isThinking = thoughtText && !finalAnswer;

                                      return (
                                        <>
                                          {isThinking && (
                                            <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
                                              <Brain
                                                className="w-3.5 h-3.5 text-[#10527c] animate-pulse"
                                                aria-hidden="true"
                                              />
                                              <span>Thinking…</span>
                                            </div>
                                          )}

                                          {finalAnswer && (
                                            <ReactMarkdown
                                              components={{
                                                code({
                                                  node,
                                                  inline,
                                                  className,
                                                  children,
                                                  ...props
                                                }: any) {
                                                  const match = /language-(\w+)/.exec(
                                                    className || ""
                                                  );
                                                  return !inline && match ? (
                                                    <SyntaxHighlighter
                                                      style={atomDark}
                                                      language={match[1]}
                                                      PreTag="div"
                                                      className="rounded-lg !my-2 overflow-x-auto w-full max-w-full"
                                                      {...props}
                                                    >
                                                      {String(children).replace(/\n$/, "")}
                                                    </SyntaxHighlighter>
                                                  ) : (
                                                    <code className={className} {...props}>
                                                      {children}
                                                    </code>
                                                  );
                                                },
                                              }}
                                            >
                                              {finalAnswer}
                                            </ReactMarkdown>
                                          )}

                                          {showHallucinationWarning && (
                                            <div
                                              role="note"
                                              className="flex items-center gap-1.5 mt-2 mb-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 not-prose"
                                            >
                                              <ShieldCheck
                                                className="w-3.5 h-3.5 flex-shrink-0"
                                                aria-hidden="true"
                                              />
                                              <span>Please verify this information independently.</span>
                                            </div>
                                          )}

                                          {courseCards.length > 0 && (() => {
                                            // Roadmap detection: a learning path response carries tier/step metadata on each card.
                                            if (process.env.NODE_ENV === "development") {
                                              console.log("[ChatbotDebug] courseCards[0]:", JSON.stringify(courseCards[0]));
                                            }
                                            const isComparison   = courseCards[0]?.isComparison === true;
                                            const isLearningPath = courseCards[0]?.tier !== undefined && !isComparison;

                                            const renderCourseCard = (course: any, key: React.Key, extraFooter?: React.ReactNode) => {
                                              const isPlatformCourse =
                                                course.courseType === "platform" && course.courseId;
                                              const cardContent = (
                                                <>
                                                  <div className="relative w-20 h-[68px] flex-shrink-0 bg-slate-100 rounded-lg overflow-hidden border border-slate-200">
                                                    {course.imageUrl ? (
                                                      <Image
                                                        src={course.imageUrl}
                                                        alt=""
                                                        fill
                                                        className="object-cover transition-transform duration-300 group-hover/card:scale-105"
                                                        sizes="80px"
                                                      />
                                                    ) : (
                                                      <div
                                                        className="w-full h-full flex items-center justify-center text-slate-300"
                                                        aria-hidden="true"
                                                      >
                                                        <PlayCircle className="w-6 h-6" />
                                                      </div>
                                                    )}
                                                  </div>
                                                  <div className="flex flex-col justify-between min-w-0 py-0.5 flex-1">
                                                    <div>
                                                      <p className="text-[11px] font-bold text-[#10527c] uppercase tracking-wider truncate">
                                                        {course.vendor}
                                                      </p>
                                                      <h4 className="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug mt-0.5">
                                                        {course.title}
                                                      </h4>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                                      <span className="text-[11px] font-medium text-slate-500 bg-slate-50 px-2 py-0.5 rounded-md border border-slate-200">
                                                        {course.difficulty}
                                                      </span>
                                                      {course.duration !== "N/A" && (
                                                        <span className="text-[11px] text-slate-500">
                                                          {course.duration}
                                                        </span>
                                                      )}
                                                      {course.isPaid ? (
                                                        <span className="ml-auto text-[11px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200 whitespace-nowrap">
                                                          {course.price != null ? `SGD $${course.price}` : "Paid"}
                                                        </span>
                                                      ) : (
                                                        <span className="ml-auto text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md border border-emerald-200">
                                                          Free
                                                        </span>
                                                      )}
                                                    </div>
                                                  </div>
                                                  <div
                                                    className="self-center flex-shrink-0 transition-colors"
                                                    aria-hidden="true"
                                                  >
                                                    {isPlatformCourse ? (
                                                      <GraduationCap className="w-3.5 h-3.5 text-[#10527c]" />
                                                    ) : (
                                                      <ExternalLink className="w-3.5 h-3.5 text-slate-400 group-hover/card:text-[#10527c]" />
                                                    )}
                                                  </div>
                                                </>
                                              );
                                              return (
                                                <article key={key} aria-label={course.title}>
                                                  {isPlatformCourse ? (
                                                    <div className="flex flex-col gap-1.5">
                                                      <button
                                                        type="button"
                                                        onClick={() => router.push(`/courses/${course.courseId}`)}
                                                        aria-label={`${course.title} by ${course.vendor} — SGD $${course.price ?? ""}, ${course.difficulty}. View course on platform.`}
                                                        className={`flex items-stretch gap-3 bg-white border border-slate-200 rounded-xl p-2.5 hover:border-[#10527c]/30 hover:shadow-md transition-all group/card min-h-[64px] w-full text-left ${FOCUS_RING}`}
                                                      >
                                                        {cardContent}
                                                      </button>
                                                      <button
                                                        type="button"
                                                        onClick={() => router.push(`/courses/${course.courseId}`)}
                                                        aria-label={`Enroll in ${course.title}`}
                                                        className={`w-full flex items-center justify-center gap-1.5 py-1.5 bg-[#10527c] text-white text-xs font-semibold rounded-lg hover:bg-[#10527c]/90 transition-colors ${FOCUS_RING}`}
                                                      >
                                                        <GraduationCap className="w-3.5 h-3.5" aria-hidden="true" />
                                                        Enroll Now
                                                      </button>
                                                      {extraFooter}
                                                    </div>
                                                  ) : (
                                                    <div className="flex flex-col gap-1.5">
                                                      <a
                                                        href={course.url}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        aria-label={`${course.title} by ${course.vendor} — ${course.isPaid ? (course.price != null ? `SGD $${course.price}` : "Paid") : "Free"}, ${course.difficulty}${course.duration !== "N/A" ? `, ${course.duration}` : ""}. Opens in new tab.`}
                                                        className={`flex items-stretch gap-3 bg-white border border-slate-200 rounded-xl p-2.5 hover:border-[#10527c]/30 hover:shadow-md transition-all group/card min-h-[64px] ${FOCUS_RING}`}
                                                      >
                                                        {cardContent}
                                                      </a>
                                                      {extraFooter}
                                                    </div>
                                                  )}
                                                </article>
                                              );
                                            };

                                            if (isLearningPath) {
                                              const stepGroups = courseCards.reduce((acc, card) => {
                                                const s = (card.step ?? 1) as 1 | 2 | 3;
                                                acc.set(s, [...(acc.get(s) ?? []), card]);
                                                return acc;
                                              }, new Map<1 | 2 | 3, any[]>());

                                              const stepDuration = (step: 1 | 2 | 3) =>
                                                (stepGroups.get(step) ?? []).reduce(
                                                  (sum: number, c: any) => sum + (parseFloat(c.duration) || 0), 0
                                                );
                                              const totalHours = Math.round([1, 2, 3].reduce((s, n) => s + stepDuration(n as 1|2|3), 0));

                                              const entryStep: 1 | 2 | 3 =
                                                msg.skillLevel === "advanced"     ? 3 :
                                                msg.skillLevel === "intermediate" ? 2 : 1;

                                              const pathId = msgToPathId.get(msg.id);
                                              const progress = pathId ? pathProgressMap.get(pathId) : undefined;
                                              const isSaving = savingPathId === msg.id;
                                              const isSaved  = msgToPathId.has(msg.id);

                                              return (
                                                <div className="mt-4 not-prose">
                                                  <div className="mb-3 rounded-xl border border-[#c5d9e8] bg-[#e8f1f8] px-4 py-3">
                                                    <div className="flex items-center gap-2 font-semibold text-[#10527c]">
                                                      <MapPin className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                                      <span>Your {titleCase(msg.searchQuery ?? "Learning")} Roadmap</span>
                                                    </div>
                                                    <p className="mt-0.5 text-xs text-slate-500">
                                                      3 stages · ~{totalHours}h total · Personalised for your profile
                                                      {progress !== undefined && progress.progressPercent > 0 && (
                                                        <span className="ml-2 text-emerald-600 font-medium">
                                                          · {Math.round(progress.progressPercent)}% complete
                                                        </span>
                                                      )}
                                                    </p>
                                                  </div>

                                                  <section aria-label="Your learning roadmap" className="relative">
                                                    <div
                                                      className="absolute left-3.5 top-5 bottom-5 w-0.5 bg-[#c5d9e8]"
                                                      aria-hidden="true"
                                                    />

                                                    <AccordionPrimitive.Root
                                                      type="multiple"
                                                      defaultValue={[`step-${entryStep}`]}
                                                    >
                                                      {([1, 2, 3] as const).map((step) => {
                                                        const cards = stepGroups.get(step) ?? [];
                                                        const { stepLabel, stepSummary, tier } = cards[0] ?? {};
                                                        const hours = Math.round(stepDuration(step));
                                                        const isEntry = step === entryStep;
                                                        const isPreEntry = step < entryStep;

                                                        return (
                                                          <AccordionPrimitive.Item
                                                            key={step}
                                                            value={`step-${step}`}
                                                            aria-label={`Step ${step} of 3: ${stepLabel ?? ""}`}
                                                            className="relative mb-3"
                                                          >
                                                            <AccordionPrimitive.Trigger
                                                              className={`flex w-full items-start gap-3 py-2 hover:no-underline group/trigger ${FOCUS_RING} rounded-lg`}
                                                            >
                                                              <span
                                                                className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#10527c] text-xs font-bold text-white"
                                                                aria-hidden="true"
                                                              >
                                                                {step}
                                                              </span>
                                                              <div className="flex-1 text-left min-w-0">
                                                                <div className="flex flex-wrap items-center gap-1.5">
                                                                  <span className="font-semibold text-slate-700 text-xs">
                                                                    {stepLabel ?? `Step ${step}`}
                                                                  </span>
                                                                  <TierBadge tier={tier} />
                                                                  {hours > 0 && (
                                                                    <span className="text-[11px] text-slate-400">~{hours}h</span>
                                                                  )}
                                                                  {isEntry && (
                                                                    <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                                                      ▶ Start here
                                                                    </span>
                                                                  )}
                                                                  {isPreEntry && (
                                                                    <span className="rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] text-slate-400">
                                                                      Optional
                                                                    </span>
                                                                  )}
                                                                </div>
                                                                {stepSummary && (
                                                                  <p className="mt-0.5 text-[11px] text-slate-500 leading-relaxed">
                                                                    {stepSummary}
                                                                  </p>
                                                                )}
                                                              </div>
                                                              <ChevronDown
                                                                className="w-4 h-4 text-slate-400 flex-shrink-0 mt-1 transition-transform duration-200 group-data-[state=open]/trigger:rotate-180"
                                                                aria-hidden="true"
                                                              />
                                                            </AccordionPrimitive.Trigger>

                                                            <AccordionPrimitive.Content className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
                                                              <motion.div
                                                                initial={prefersReducedMotion ? {} : { opacity: 0, y: 4 }}
                                                                animate={{ opacity: 1, y: 0 }}
                                                                className="ml-10 mt-2 space-y-2"
                                                                role="list"
                                                                aria-label={`Courses for step ${step}`}
                                                              >
                                                                {cards.map((course: any) => {
                                                                  const courseCompleted = progress?.completed.has(course.courseId ?? "");
                                                                  const completionFooter = pathId && course.courseId ? (
                                                                    <label
                                                                      className="flex items-center gap-2 cursor-pointer text-[11px] text-slate-500 pl-1 select-none"
                                                                      aria-label={`Mark "${course.title}" as complete`}
                                                                    >
                                                                      <CheckboxPrimitive.Root
                                                                        checked={courseCompleted ?? false}
                                                                        onCheckedChange={(checked) =>
                                                                          handleToggleCourseComplete(pathId, course.courseId, checked === true)
                                                                        }
                                                                        className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${courseCompleted ? "bg-emerald-500 border-emerald-500" : "bg-white border-slate-300 hover:border-[#10527c]"} ${FOCUS_RING}`}
                                                                      >
                                                                        <CheckboxPrimitive.Indicator>
                                                                          <Check className="w-2.5 h-2.5 text-white" />
                                                                        </CheckboxPrimitive.Indicator>
                                                                      </CheckboxPrimitive.Root>
                                                                      <span className={courseCompleted ? "line-through text-slate-400" : ""}>
                                                                        Mark as complete
                                                                      </span>
                                                                    </label>
                                                                  ) : null;
                                                                  return (
                                                                    <div key={course.courseId ?? course.title} role="listitem">
                                                                      {renderCourseCard(course, course.courseId ?? course.title, completionFooter)}
                                                                    </div>
                                                                  );
                                                                })}
                                                              </motion.div>
                                                            </AccordionPrimitive.Content>
                                                          </AccordionPrimitive.Item>
                                                        );
                                                      })}
                                                    </AccordionPrimitive.Root>

                                                    <div className="ml-10 mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                                                      <span aria-hidden="true">✦</span>
                                                      <span>Goal: Complete {titleCase(msg.searchQuery ?? "this")} Practitioner</span>
                                                    </div>
                                                  </section>

                                                  {/*Save learning path button */}
                                                  {user && (
                                                    <button
                                                      type="button"
                                                      disabled={isSaved || isSaving}
                                                      onClick={() => handleSaveLearningPath(msg.id, courseCards, msg.searchQuery ?? "")}
                                                      aria-label={isSaved ? "Learning path saved" : "Save this learning path"}
                                                      className={`mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all border ${
                                                        isSaved
                                                          ? "bg-emerald-50 border-emerald-200 text-emerald-700 cursor-default"
                                                          : "bg-white border-[#c5d9e8] text-[#10527c] hover:bg-[#e8f1f8] active:scale-[0.98]"
                                                      } ${FOCUS_RING}`}
                                                    >
                                                      {isSaved ? (
                                                        <><BookmarkCheck className="w-3.5 h-3.5" aria-hidden="true" /> Saved ✓</>
                                                      ) : isSaving ? (
                                                        <><Bookmark className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" /> Saving…</>
                                                      ) : (
                                                        <><Bookmark className="w-3.5 h-3.5" aria-hidden="true" /> Save this learning path</>
                                                      )}
                                                    </button>
                                                  )}
                                                </div>
                                              );
                                            }

                                            // Comparer UI: reuses AccordionPrimitive from the learning path
                                            // but without the step-number badge or progression cues.
                                            if (isComparison) {
                                              const compGroups = courseCards.reduce((acc, card) => {
                                                const s = (card.step ?? 1) as 1 | 2;
                                                acc.set(s, [...(acc.get(s) ?? []), card]);
                                                return acc;
                                              }, new Map<1 | 2, any[]>());

                                              const labelA = (compGroups.get(1) ?? [])[0]?.stepLabel ?? "Topic A";
                                              const labelB = (compGroups.get(2) ?? [])[0]?.stepLabel ?? "Topic B";

                                              return (
                                                <div className="mt-4 not-prose">
                                                  <div className="mb-3 rounded-xl border border-[#c5d9e8] bg-[#e8f1f8] px-4 py-3">
                                                    <div className="flex items-center gap-2 font-semibold text-[#10527c]">
                                                      <ArrowLeftRight className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
                                                      <span>{labelA} vs {labelB}</span>
                                                    </div>
                                                    <p className="mt-0.5 text-xs text-slate-500">
                                                      2 topics · Expand each to explore courses
                                                    </p>
                                                  </div>

                                                  <AccordionPrimitive.Root
                                                    type="multiple"
                                                    defaultValue={["step-1", "step-2"]}
                                                  >
                                                    {([1, 2] as const).map((step) => {
                                                      const cards = compGroups.get(step) ?? [];
                                                      const { stepLabel, stepSummary, tier } = cards[0] ?? {};

                                                      return (
                                                        <AccordionPrimitive.Item
                                                          key={step}
                                                          value={`step-${step}`}
                                                          aria-label={stepLabel}
                                                          className="relative mb-3"
                                                        >
                                                          <AccordionPrimitive.Trigger
                                                            className={`flex w-full items-start gap-3 py-2 hover:no-underline group/trigger ${FOCUS_RING} rounded-lg`}
                                                          >
                                                            <div className="flex-1 text-left min-w-0">
                                                              <div className="flex flex-wrap items-center gap-1.5">
                                                                <span className="font-semibold text-slate-700 text-xs">
                                                                  {stepLabel}
                                                                </span>
                                                                <TierBadge tier={tier} />
                                                              </div>
                                                              {stepSummary && (
                                                                <p className="mt-0.5 text-[11px] text-slate-500 leading-relaxed">
                                                                  {stepSummary}
                                                                </p>
                                                              )}
                                                            </div>
                                                            <ChevronDown
                                                              className="w-4 h-4 text-slate-400 flex-shrink-0 mt-1 transition-transform duration-200 group-data-[state=open]/trigger:rotate-180"
                                                              aria-hidden="true"
                                                            />
                                                          </AccordionPrimitive.Trigger>

                                                          <AccordionPrimitive.Content className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
                                                            <motion.div
                                                              initial={prefersReducedMotion ? {} : { opacity: 0, y: 4 }}
                                                              animate={{ opacity: 1, y: 0 }}
                                                              className="ml-4 mt-2 space-y-2"
                                                              role="list"
                                                              aria-label={`Courses for ${stepLabel}`}
                                                            >
                                                              {cards.map((course: any, idx: number) => (
                                                                <div key={course.courseId ?? `${step}-${idx}`} role="listitem">
                                                                  {renderCourseCard(course, course.courseId ?? `${step}-${idx}`)}
                                                                </div>
                                                              ))}
                                                            </motion.div>
                                                          </AccordionPrimitive.Content>
                                                        </AccordionPrimitive.Item>
                                                      );
                                                    })}
                                                  </AccordionPrimitive.Root>
                                                </div>
                                              );
                                            }

                                            return (
                                              <section
                                                aria-label="Recommended courses"
                                                className="mt-4 space-y-2.5 not-prose"
                                              >
                                                {courseCards.map((course, idx) =>
                                                  renderCourseCard(course, idx)
                                                )}
                                              </section>
                                            );
                                          })()}

                                          {followUpQuestions.length > 0 && !isLoading && (
                                            <div
                                              role="group"
                                              aria-label="Suggested follow-up questions"
                                              className="flex flex-col gap-1.5 mt-3 pt-3 border-t border-slate-100 not-prose"
                                            >
                                              <div className="flex items-center gap-1.5 pl-1 mb-0.5">
                                                <Sparkles
                                                  className="w-3 h-3 text-emerald-600"
                                                  aria-hidden="true"
                                                />
                                                <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                                                  Suggested follow-ups
                                                </span>
                                              </div>
                                              {followUpQuestions.map((q, idx) => (
                                                <button
                                                  key={idx}
                                                  type="button"
                                                  onClick={(e) => handleSubmit(e as any, q)}
                                                  aria-label={`Follow-up: ${q}`}
                                                  className={`text-left px-3.5 py-2.5 bg-[#e8f1f8] hover:bg-[#10527c]/10 text-[#10527c] rounded-xl text-xs font-medium transition-all border border-[#c5d9e8] active:scale-95 flex items-center justify-between gap-3 ${FOCUS_RING}`}
                                                >
                                                  <span className="line-clamp-2 leading-relaxed">
                                                    {q}
                                                  </span>
                                                  <ChevronDown
                                                    className="w-3.5 h-3.5 -rotate-90 flex-shrink-0"
                                                    aria-hidden="true"
                                                  />
                                                </button>
                                              ))}
                                            </div>
                                          )}

                                          {/*
                                           * Reasoning trace — Radix Popover button (replaces inline
                                           * <details> to eliminate ~50 px vertical space per message).
                                           * Only shown after streaming completes (finalAnswer present).
                                           * During streaming the "Thinking…" indicator above is shown.
                                         
                                           */}
                                          {thoughtText && finalAnswer && (
                                            <div className="mt-2 not-prose">
                                              <Popover.Root>
                                                <Popover.Trigger asChild>
                                                  <button
                                                    aria-label="View reasoning trace"
                                                    aria-haspopup="dialog"
                                                    className={`flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-500 bg-white border border-slate-200 rounded-full shadow-sm hover:bg-[#e8f1f8] hover:text-[#10527c] hover:border-[#c5d9e8] transition-colors ${FOCUS_RING}`}
                                                  >
                                                    <Brain
                                                      className="w-3 h-3"
                                                      aria-hidden="true"
                                                    />
                                                    Reasoning
                                                  </button>
                                                </Popover.Trigger>
                                                <Popover.Portal>
                                                  <Popover.Content
                                                    side="top"
                                                    align="start"
                                                    sideOffset={6}
                                                    className="w-72 bg-white border border-slate-200 rounded-xl shadow-xl p-4 space-y-3 z-50"
                                                    aria-label="Journey's reasoning trace"
                                                  >
                                                    <div className="flex items-center justify-between">
                                                      <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wider">
                                                        How Journey thought about this
                                                      </h3>
                                                      <Popover.Close
                                                        aria-label="Close reasoning trace"
                                                        className={`p-1 text-slate-400 hover:text-slate-600 rounded ${FOCUS_RING}`}
                                                      >
                                                        <X
                                                          className="w-3.5 h-3.5"
                                                          aria-hidden="true"
                                                        />
                                                      </Popover.Close>
                                                    </div>
                                                    {agentSteps.map((step, i) => (
                                                      <div key={i} className="flex gap-2.5">
                                                        <div className="mt-0.5 w-5 h-5 rounded-md bg-[#e8f1f8] flex items-center justify-center flex-shrink-0 text-[#10527c]">
                                                          {step.agent === "CLASSIFIER" && (
                                                            <ShieldCheck
                                                              className="w-3 h-3"
                                                              aria-hidden="true"
                                                            />
                                                          )}
                                                          {step.agent === "RESEARCHER" && (
                                                            <Search
                                                              className="w-3 h-3"
                                                              aria-hidden="true"
                                                            />
                                                          )}
                                                          {step.agent === "CURATOR" && (
                                                            <Filter
                                                              className="w-3 h-3"
                                                              aria-hidden="true"
                                                            />
                                                          )}
                                                          {step.agent === "SAFETY" && (
                                                            <LockIcon
                                                              className="w-3 h-3"
                                                              aria-hidden="true"
                                                            />
                                                          )}
                                                          {step.agent === "THINKER" && (
                                                            <Brain
                                                              className="w-3 h-3"
                                                              aria-hidden="true"
                                                            />
                                                          )}
                                                        </div>
                                                        <div>
                                                          <p className="text-[11px] font-bold text-[#10527c] uppercase tracking-tight">
                                                            {step.agent}
                                                          </p>
                                                          <p className="text-xs text-slate-600 leading-relaxed mt-0.5 italic">
                                                            {step.message}
                                                          </p>
                                                        </div>
                                                      </div>
                                                    ))}
                                                    <Popover.Arrow className="fill-slate-200" />
                                                  </Popover.Content>
                                                </Popover.Portal>
                                              </Popover.Root>
                                            </div>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                )}

                                {msg.role === "assistant" && msg.content && !isBlocked && (
                                  <>
                                    <button
                                      onClick={() =>
                                        copyToClipboard(
                                          // Copy the cleaned finalAnswer (no <thought> blocks,
                                          // [COURSE_CARD] tags, or [RECOMMENDATION_META] JSON)
                                          // rather than the raw accumulated stream.
                                         
                                          parsedMessageMap.get(msg.id)?.finalAnswer ?? msg.content,
                                          msg.id
                                        )
                                      }
                                      aria-label={
                                        copiedId === msg.id
                                          ? "Copied to clipboard"
                                          : "Copy message to clipboard"
                                      }
                                      className={`
                                        absolute -top-2 right-2
                                        p-1.5 bg-white border border-slate-200 rounded-lg shadow-sm
                                        opacity-0 group-hover:opacity-100 focus-visible:opacity-100
                                        transition-opacity text-slate-400 hover:text-[#10527c]
                                        ${FOCUS_RING}
                                      `}
                                    >
                                      {copiedId === msg.id ? (
                                        <Check
                                          className="w-3 h-3 text-emerald-600"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <Copy className="w-3 h-3" aria-hidden="true" />
                                      )}
                                    </button>
                                    {/* Screen reader announcement for copy confirmation */}
                                    <div
                                      aria-live="polite"
                                      aria-atomic="true"
                                      className="sr-only"
                                    >
                                      {copiedId === msg.id ? "Message copied to clipboard" : ""}
                                    </div>
                                  </>
                                )}
                              </div>

                              {/* Thumbs feedback: authenticated users, settled bot messages only, not blocked */}
                              {user && msg.role === "assistant" && !isBlocked && !msg.streamError && !isLoading && (
                                <div className="flex items-center gap-1.5 mt-1.5 px-0.5">
                                  <button
                                    type="button"
                                    onClick={() => handleFeedback(msg.id, "up")}
                                    aria-label="Helpful response"
                                    aria-pressed={feedbackMap.get(msg.id) === "up"}
                                    className={`p-1.5 rounded-lg transition-colors ${FOCUS_RING} ${
                                      feedbackMap.get(msg.id) === "up"
                                        ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                                        : "text-slate-400 hover:text-emerald-600 hover:bg-emerald-50"
                                    }`}
                                  >
                                    <ThumbsUp className="w-3 h-3" aria-hidden="true" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleFeedback(msg.id, "down")}
                                    aria-label="Unhelpful response"
                                    aria-pressed={feedbackMap.get(msg.id) === "down"}
                                    className={`p-1.5 rounded-lg transition-colors ${FOCUS_RING} ${
                                      feedbackMap.get(msg.id) === "down"
                                        ? "bg-red-100 text-red-700 border border-red-300"
                                        : "text-slate-400 hover:text-red-500 hover:bg-red-50"
                                    }`}
                                  >
                                    <ThumbsDown className="w-3 h-3" aria-hidden="true" />
                                  </button>
                                  {feedbackMap.get(msg.id) && (
                                    <span className="text-[10px] text-slate-400 ml-0.5">Thanks!</span>
                                  )}
                                </div>
                              )}

                              {/* Stream error: show partial content note + Retry CTA */}
                              {msg.role === "assistant" && msg.streamError && (
                                <div className="flex items-center gap-2 mt-1.5 px-0.5">
                                  <span className="text-[11px] text-amber-600">Connection lost.</span>
                                  <button
                                    type="button"
                                    onClick={() => handleRetry(msg.id)}
                                    disabled={isLoading}
                                    aria-label="Retry this message"
                                    className={`flex items-center gap-1 text-[11px] font-semibold text-[#10527c] hover:underline disabled:opacity-50 ${FOCUS_RING}`}
                                  >
                                    <RefreshCw className="w-3 h-3" aria-hidden="true" />
                                    Retry →
                                  </button>
                                </div>
                              )}

                              {/* Timestamp is visible on hover/focus-within */}
                              {msg.createdAt && (
                                <time
                                  dateTime={msg.createdAt.toISOString()}
                                  className="text-xs text-slate-500 mt-1 px-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                                >
                                  {msg.createdAt.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </time>
                              )}
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/*
                 * Three-dot typing indicator
                 */}
                {isLoading && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex gap-3 items-start"
                  >
                    <div
                      className="w-8 h-8 rounded-xl bg-[#10527c] flex-shrink-0 flex items-center justify-center"
                      aria-hidden="true"
                    >
                      <Bot className="w-4 h-4 text-white" aria-hidden="true" />
                    </div>
                    <div
                      role="status"
                      aria-label="Journey is generating a response"
                      className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm px-4 py-3"
                    >
                      <div className="flex items-center gap-1.5" aria-hidden="true">
                        <div
                          className={`w-2 h-2 rounded-full bg-slate-400 [animation-delay:0ms] ${
                            prefersReducedMotion ? "animate-pulse" : "animate-bounce"
                          }`}
                        />
                        <div
                          className={`w-2 h-2 rounded-full bg-slate-400 [animation-delay:150ms] ${
                            prefersReducedMotion ? "animate-pulse" : "animate-bounce"
                          }`}
                        />
                        <div
                          className={`w-2 h-2 rounded-full bg-slate-400 [animation-delay:300ms] ${
                            prefersReducedMotion ? "animate-pulse" : "animate-bounce"
                          }`}
                        />
                      </div>
                    </div>
                  </motion.div>
                )}

                <div ref={messagesEndRef} />

                <AnimatePresence>
                  {showScrollButton && (
                    <motion.button
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      onClick={scrollToBottom}
                      aria-label="Scroll to latest message"
                      className={`absolute bottom-4 left-1/2 -translate-x-1/2 p-2 bg-white text-[#10527c] shadow-lg border border-slate-200 rounded-full z-10 hover:bg-[#e8f1f8] transition-colors ${FOCUS_RING}`}
                    >
                      <ChevronDown className="w-5 h-5" aria-hidden="true" />
                    </motion.button>
                  )}
                </AnimatePresence>
              </div>

              <Tooltip.Provider delayDuration={300}>
              <div className="px-4 py-4 bg-white border-t border-slate-200 space-y-3 flex-shrink-0">

                {/* Chips derived from the last assistant message's parsed content,
                 * not a static list, so they stay relevant after turn 2+. */}
                {!isLoading && messages.length > 0 && (() => {
                  const lastAsst = [...messages].reverse().find(
                    (m) => m.role === "assistant" && !m.streamError
                  );
                  const lastParsed = lastAsst ? parsedMessageMap.get(lastAsst.id) : null;
                  const hasCards = (lastParsed?.courseCards?.length ?? 0) > 0;
                  const isFaq = lastParsed
                    ? lastParsed.thoughtText.toLowerCase().includes('"faq"')
                    : false;
                  const chipKey: keyof typeof CHIP_SETS =
                    hasCards ? "recommendation" : isFaq ? "faq" : messages.length > 0 ? "general" : "default";
                  const chips = CHIP_SETS[chipKey];

                  // Compact (icon-only) when the panel is too narrow for labels.
                  // On mobile the full-width sheet always has room, so never compact there.
                  const compact = !isMobile && width < CHIP_COMPACT_BREAKPOINT;
                  return (
                    <div
                      role="group"
                      aria-label="Quick suggestions"
                      className="flex gap-2 pb-0.5 overflow-x-auto"
                    >
                      {chips.map(({ label, icon: Icon }) => (
                        <Tooltip.Root key={label}>
                          <Tooltip.Trigger asChild>
                            <button
                              type="button"
                              onClick={(e) => handleSubmit(e as any, label)}
                              aria-label={`Quick suggestion: ${label}`}
                              className={`
                                bg-[#e8f1f8] text-[#10527c] border border-[#c5d9e8]
                                rounded-full hover:bg-[#10527c]/10 transition-colors
                                flex-shrink-0 flex items-center gap-1.5
                                ${compact
                                  ? "w-8 h-8 justify-center"
                                  : "px-3 py-1.5 text-xs font-semibold whitespace-nowrap"
                                }
                                ${FOCUS_RING}
                              `}
                            >
                              <Icon className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                              {!compact && label}
                            </button>
                          </Tooltip.Trigger>
                          {/* Tooltip always shown on hover; required in compact mode for label */}
                          <Tooltip.Portal>
                            <Tooltip.Content
                              side="top"
                              sideOffset={6}
                              className="bg-white text-[#10527c] text-xs font-semibold px-3 py-1.5 rounded-xl shadow-md border border-slate-200 select-none z-[9999]"
                            >
                              {label}
                              <Tooltip.Arrow className="fill-slate-200" />
                            </Tooltip.Content>
                          </Tooltip.Portal>
                        </Tooltip.Root>
                      ))}
                    </div>
                  );
                })()}

                {activeContext && (
                  <div className="flex items-center justify-between bg-[#e8f1f8] text-[#10527c] px-3 py-2 rounded-lg text-xs border border-[#c5d9e8]">
                    <div className="flex items-center gap-2 min-w-0">
                      <Info className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                      <span className="truncate font-medium">Context attached</span>
                    </div>
                    <button
                      onClick={onClearContext}
                      aria-label="Remove attached context"
                      className={`ml-2 p-1 rounded hover:bg-[#10527c]/10 transition-colors flex-shrink-0 ${FOCUS_RING}`}
                    >
                      <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                  </div>
                )}

                <form onSubmit={handleSubmit}>
                  <div className="relative">
                    <label htmlFor="journey-input" className="sr-only">
                      Message Journey
                    </label>
                    <textarea
                      id="journey-input"
                      ref={textareaRef}
                      rows={1}
                      value={input}
                      onKeyDown={handleKeyDown}
                      onChange={(e) => setInput(e.target.value)}
                      placeholder="Ask me anything…"
                      aria-describedby="journey-disclaimer"
                      className={`w-full bg-slate-50 border border-slate-300 rounded-xl pl-4 pr-14 py-3.5 text-sm text-slate-900 placeholder:text-slate-500 focus:outline-none focus:border-[#10527c]/50 transition-colors resize-none min-h-[52px] max-h-[150px] custom-scrollbar focus-visible:ring-2 focus-visible:ring-[#10527c] focus-visible:ring-offset-2`}
                    />
                    {isLoading ? (
                      <button
                        type="button"
                        onClick={handleStop}
                        aria-label="Stop generating response"
                        className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-2 bg-red-600 text-white rounded-xl hover:bg-red-700 transition-colors ${FOCUS_RING}`}
                      >
                        <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!input.trim()}
                        aria-label="Send message"
                        aria-disabled={!input.trim()}
                        className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-2 bg-[#10527c] text-white rounded-xl hover:bg-[#10527c]/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${FOCUS_RING}`}
                      >
                        <Send className="w-4 h-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </form>

                {/* note that aria-describedby target for the textarea */}
                <p
                  id="journey-disclaimer"
                  className="text-xs text-center text-slate-500"
                >
                  Journey can make mistakes. Verify important information.
                </p>
              </div>
              </Tooltip.Provider>
            </motion.div>
          </FocusScope>
        </>
      )}
    </AnimatePresence>
  );
}

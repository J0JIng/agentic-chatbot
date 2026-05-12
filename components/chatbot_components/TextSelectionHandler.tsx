"use client";

import { useState, useEffect, useRef } from "react";

interface TextSelectionHandlerProps {
  onSelectText: (text: string) => void;
}

/** Renders a floating tooltip on text selection and forwards the enriched context to the chatbot. */
export default function TextSelectionHandler({
  onSelectText,
}: TextSelectionHandlerProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null
  );
  const [selectedText, setSelectedText] = useState("");
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setPosition({
          x: rect.left + rect.width / 2,
          y: rect.top - 10 + window.scrollY,
        });
        setSelectedText(selection.toString());
      } else {
        setPosition(null);
        setSelectedText("");
      }
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () =>
      document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  const handleAskJourney = (e: React.MouseEvent) => {
    e.stopPropagation();

    const currentPath = typeof window !== 'undefined' ? window.location.pathname : 'unknown page';
    const enrichedContext = `[Context from ${currentPath}]: "${selectedText}"`;

    onSelectText(enrichedContext);

    setPosition(null);
    if (window.getSelection) {
      if (window.getSelection()?.empty) {  // Chrome
        window.getSelection()?.empty();
      } else if (window.getSelection()?.removeAllRanges) {  // Firefox
        window.getSelection()?.removeAllRanges();
      }
    }
  };

  if (!position) return null;

  return (
    <div
      ref={tooltipRef}
      className="fixed z-50 transform -translate-x-1/2 -translate-y-full"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={handleAskJourney}
        className="bg-gray-900 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg hover:bg-gray-800 transition-colors flex items-center gap-1"
      >
        <div className="w-3 h-3 rounded-full bg-gradient-to-r from-blue-500 to-purple-600"></div>
        Ask Journey
      </button>
      <div className="w-2 h-2 bg-gray-900 transform rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-1"></div>
    </div>
  );
}

import React, { forwardRef } from "react";
import clsx from "clsx";

type ChatbotButtonProps = {
  onClick: () => void;
  isOpen: boolean;
  disabled?: boolean;
};

function SpinnerIcon() {
  return (
    <svg
      className="h-6 w-6 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M6 18L18 6M6 6l12 12"
      />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  );
}

/**
 * A2 fix (WCAG 2.4.3): Converted to forwardRef so ChatbotShell can hold a ref
 * to this button and return focus here when the chat panel closes.
 * Previously, closing the panel left focus on <body>, losing the user's place.
 */
const ChatbotButton = forwardRef<HTMLButtonElement, ChatbotButtonProps>(
  function ChatbotButton({ onClick, isOpen, disabled = false }, ref) {
    const icon = disabled ? (
      <SpinnerIcon />
    ) : isOpen ? (
      <CloseIcon />
    ) : (
      <ChatIcon />
    );

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label="Toggle chat"
        aria-expanded={isOpen}
        className={clsx(
          "fixed bottom-6 right-6 z-50 rounded-full bg-blue-500 p-4 text-white shadow-lg transition-all duration-200 hover:scale-105 hover:bg-blue-600",
          disabled && "cursor-wait opacity-75"
        )}
      >
        {icon}
      </button>
    );
  }
);

ChatbotButton.displayName = "ChatbotButton";

export default ChatbotButton;

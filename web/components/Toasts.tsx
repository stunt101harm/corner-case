"use client";

/**
 * Toasts.tsx — minimal toast system (a dependency would be heavier than the
 * feature). Errors persist a little longer than successes; an optional link
 * lets success toasts point at the explorer.
 */

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export interface ToastInput {
  kind: "success" | "error" | "info";
  text: string;
  link?: { href: string; label: string };
}

interface Toast extends ToastInput {
  id: number;
}

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

export function useToast(): (t: ToastInput) => void {
  const push = useContext(ToastContext);
  if (!push) throw new Error("useToast outside ToastProvider");
  return push;
}

const KIND_STYLES: Record<ToastInput["kind"], string> = {
  success: "border-turf-500/60 bg-pitch-800",
  error: "border-card-red/60 bg-pitch-800",
  info: "border-pitch-500 bg-pitch-800",
};

const KIND_ICON: Record<ToastInput["kind"], string> = {
  success: "✓",
  error: "✕",
  info: "•",
};

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((t: ToastInput) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { ...t, id }]);
    const ttl = t.kind === "error" ? 9000 : 6000;
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), ttl);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg border px-4 py-3 text-sm shadow-glow ${KIND_STYLES[t.kind]}`}
          >
            <div className="flex items-start gap-2">
              <span className={t.kind === "error" ? "text-card-red" : "text-turf-400"}>
                {KIND_ICON[t.kind]}
              </span>
              <div className="min-w-0">
                <p className="break-words text-chalk">{t.text}</p>
                {t.link && (
                  <a
                    href={t.link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-block text-xs text-turf-400 underline underline-offset-2 hover:text-turf-300"
                  >
                    {t.link.label} ↗
                  </a>
                )}
              </div>
              <button
                onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
                className="ml-auto text-chalk/40 hover:text-chalk"
                aria-label="dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

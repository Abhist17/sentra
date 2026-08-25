"use client";

import { engineStatus, timeAgo } from "@/lib/format";
import { useMounted, useNow } from "@/lib/hooks";
import { useTheme } from "@/lib/theme";
import { Button, Dot } from "./ui";

function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <rect
          x="1"
          y="1"
          width="18"
          height="18"
          rx="5"
          stroke="var(--text-secondary)"
          strokeWidth="1.2"
          fill="none"
        />
        <path
          d="M5.5 12.5 L8 8.5 L10.5 11 L14.5 5.5"
          stroke="var(--text)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight text-text">
        Sentra
      </span>
    </span>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const mounted = useMounted();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      aria-label={
        mounted && theme === "light"
          ? "Switch to dark theme"
          : "Switch to light theme"
      }
      className="!px-2"
    >
      {/* Rendered blank until mount — the server cannot know the stored theme
          and a guess would hydrate as the wrong icon. */}
      <span className="block h-3.5 w-3.5">
        {mounted &&
          (theme === "light" ? (
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
              <path
                d="M11.5 8.6A5 5 0 0 1 5.4 2.5 5 5 0 1 0 11.5 8.6Z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
              <circle cx="7" cy="7" r="2.9" fill="currentColor" />
              <path
                d="M7 .8v1.6M7 11.6v1.6M13.2 7h-1.6M2.4 7H.8M11.4 2.6l-1.1 1.1M3.7 10.3l-1.1 1.1M11.4 11.4l-1.1-1.1M3.7 3.7 2.6 2.6"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          ))}
      </span>
    </Button>
  );
}

export function TopBar({
  demo = false,
  lastTickAt,
  lastTickError,
  pricesStale,
  refreshing,
  onRefresh,
  onOpenSettings,
}: {
  demo?: boolean;
  lastTickAt: number;
  lastTickError: string | null;
  pricesStale: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  const mounted = useMounted();
  useNow(1000); // keeps the relative timestamp honest

  const status = engineStatus({ demo, lastTickError, pricesStale });

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
        <Logo />

        <span className="hidden text-xs text-tertiary sm:inline">
          Portfolio risk monitor
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1">
            <Dot color={status.color} pulse={status.pulse} />
            <span className="text-[11px] font-medium text-secondary">
              {status.label}
            </span>
          </span>

          <span className="numeric hidden px-1 text-[11px] text-tertiary sm:inline">
            {mounted ? timeAgo(lastTickAt) : ""}
          </span>

          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh data"
            className="!px-2"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 14 14"
              aria-hidden="true"
              className={refreshing ? "animate-spin" : undefined}
            >
              <path
                d="M12.2 7a5.2 5.2 0 1 1-1.6-3.7M12.4 1.4v3.2H9.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenSettings}
            aria-label="Connect to an engine"
            className="!px-2"
          >
            {/* Server / stack mark — deliberately not a gear, which reads
                as a sun next to the theme toggle. */}
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect
                x="1.5"
                y="2"
                width="11"
                height="4"
                rx="1.2"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
              <rect
                x="1.5"
                y="8"
                width="11"
                height="4"
                rx="1.2"
                stroke="currentColor"
                strokeWidth="1.2"
                fill="none"
              />
              <circle cx="4" cy="4" r="0.75" fill="currentColor" />
              <circle cx="4" cy="10" r="0.75" fill="currentColor" />
            </svg>
          </Button>

          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

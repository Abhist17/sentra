"use client";

import type { ReactNode } from "react";

/* ── Surfaces ─────────────────────────────────────────────────── */

export function Panel({
  children,
  className = "",
  delay,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={`card enter overflow-hidden ${className}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 className="label shrink-0">{title}</h2>
        {meta && (
          <span className="truncate text-xs text-tertiary">{meta}</span>
        )}
      </div>
      {action}
    </div>
  );
}

/* ── Controls ─────────────────────────────────────────────────── */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";

  const sizes = {
    sm: "h-7 px-2.5 text-xs",
    md: "h-9 px-3.5 text-[13px]",
  };

  const variants = {
    primary: "bg-primary text-primary-text hover:opacity-88",
    secondary:
      "border border-border-strong bg-surface text-text hover:bg-surface-hover",
    ghost: "text-secondary hover:bg-surface-hover hover:text-text",
    danger:
      "border border-transparent text-tertiary hover:border-severe/40 hover:text-severe",
  };

  return (
    <button
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Input({
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-9 w-full rounded-md border border-border bg-bg-subtle px-2.5 text-[13px] text-text transition-colors placeholder:text-tertiary hover:border-border-strong focus:border-focus focus:outline-none ${className}`}
      {...props}
    />
  );
}

/* ── Indicators ───────────────────────────────────────────────── */

export function Tag({
  children,
  color,
  subtle = false,
}: {
  children: ReactNode;
  /** CSS colour reference; omit for a neutral tag. */
  color?: string;
  subtle?: boolean;
}) {
  if (!color) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-tertiary">
        {children}
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
      style={{
        color,
        backgroundColor: subtle
          ? "transparent"
          : `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export function Dot({ color, pulse = false }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
        pulse ? "breathe" : ""
      }`}
      style={{ backgroundColor: color }}
    />
  );
}

/* ── States ───────────────────────────────────────────────────── */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function EmptyState({
  title,
  body,
  action,
  compact = false,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 text-center ${
        compact ? "py-8" : "py-14"
      }`}
    >
      <p className="text-[13px] font-medium text-text">{title}</p>
      <p className="mt-1 max-w-[34ch] text-xs leading-relaxed text-tertiary">
        {body}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error" | "success";
  children: ReactNode;
}) {
  const colors = {
    info: "var(--text-tertiary)",
    warn: "var(--watch)",
    error: "var(--severe)",
    success: "var(--calm)",
  };
  const color = colors[tone];

  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2 text-xs leading-snug"
      style={{
        color: tone === "info" ? "var(--text-secondary)" : color,
        backgroundColor: `color-mix(in srgb, ${color} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
      }}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

/** Definition row used by the sidebar and detail panels. */
export function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: ReactNode;
  color?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-xs text-tertiary">{label}</dt>
      <dd
        className="numeric text-xs font-medium"
        style={color ? { color } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

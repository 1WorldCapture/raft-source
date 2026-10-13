import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonSize = "xs" | "sm" | "md" | "lg";
type ButtonShape = "icon" | "text" | "iconText";
export type ButtonEmphasis = "default" | "high";

/**
 * Button tones map to the brutal palette. Callers say `tone="pink"`,
 * never `className="bg-brutal-pink"`. Adding a new tone means adding a
 * row here, not a one-off override at the callsite.
 *
 * Hidden context (PR #1905 / #proj-theme:ac79cf20 stdrc msg=6ce4d8bf):
 * the prior API exposed size+shape but left bg/color to caller
 * className. Tightening the boundary makes theme swaps possible without
 * re-auditing every callsite.
 */
const BUTTON_TONE_CLASSES = {
  white: "bg-layer-panel theme-brutal:bg-white text-foreground-strong theme-brutal:text-black",
  yellow: "bg-primary-soft theme-brutal:bg-soft-signal text-foreground-strong theme-brutal:text-black",
  pink: "bg-accent-soft theme-brutal:bg-brutal-pink text-foreground-strong theme-brutal:text-black",
  cyan: "bg-info-soft theme-brutal:bg-brutal-cyan text-foreground-strong theme-brutal:text-black",
  lavender: "bg-secondary-200 dark:bg-secondary-800 theme-brutal:bg-brutal-lavender text-foreground-strong theme-brutal:text-black",
  orange: "bg-warning-soft theme-brutal:bg-brutal-orange text-foreground-strong theme-brutal:text-black",
  lime: "bg-success-soft theme-brutal:bg-brutal-lime text-foreground-strong theme-brutal:text-black",
  red: "bg-danger-soft theme-brutal:bg-brutal-red text-foreground-strong theme-brutal:text-black",
  stone: "bg-fill-muted theme-brutal:bg-brutal-stone text-foreground-strong theme-brutal:text-black",
} as const;

export type ButtonTone = keyof typeof BUTTON_TONE_CLASSES;

const SIZE_SHAPE_CLASSES: Record<ButtonSize, Record<ButtonShape, string>> = {
  xs: {
    icon: "size-6 text-[11px]",
    text: "h-6 px-2 text-[11px]",
    iconText: "h-6 gap-1 px-2 text-[11px]",
  },
  sm: {
    icon: "size-7 text-xs",
    text: "h-7 px-2.5 text-xs",
    iconText: "h-7 gap-1.5 px-2.5 text-xs",
  },
  md: {
    icon: "size-8 text-sm",
    text: "h-8 px-3 text-sm",
    iconText: "h-8 gap-2 px-3 text-sm",
  },
  lg: {
    icon: "size-10 text-sm",
    text: "h-10 px-4 text-sm",
    iconText: "h-10 gap-2 px-4 text-sm",
  },
};

function brutalButtonClassName({
  size = "sm",
  shape = "text",
  emphasis = "default",
  tone = "white",
  className = "",
}: {
  size?: ButtonSize;
  shape?: ButtonShape;
  emphasis?: ButtonEmphasis;
  tone?: ButtonTone;
  className?: string;
} = {}) {
  return [
    emphasis === "high" ? "btn-brutal-high" : "btn-brutal-sm",
    "inline-flex shrink-0 items-center justify-center font-bold leading-none",
    BUTTON_TONE_CLASSES[tone],
    SIZE_SHAPE_CLASSES[size][shape],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: ButtonSize;
  shape?: ButtonShape;
  /** Elevation follows semantic emphasis, never size. Defaults to small → medium. */
  emphasis?: ButtonEmphasis;
  /** Background tone from the brutal palette. Defaults to `white`. */
  tone?: ButtonTone;
  children?: ReactNode;
}

export default function Button({
  size = "sm",
  shape = "text",
  emphasis = "default",
  tone,
  className = "",
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={brutalButtonClassName({ size, shape, emphasis, tone, className })}
      {...props}
    >
      {children}
    </button>
  );
}

import { Check } from "lucide-react";
import type { HTMLAttributes } from "react";

export type CheckMarkerShape = "square" | "circle";
export type CheckMarkerSize = "sm" | "md" | "lg";
export type CheckMarkerTone = "black-fill" | "yellow-fill";

const SIZE_CLASS: Record<CheckMarkerSize, string> = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-5",
};

const ICON_PX: Record<CheckMarkerSize, number> = {
  sm: 10,
  md: 12,
  lg: 13,
};

const STROKE_WIDTH: Record<CheckMarkerSize, number> = {
  sm: 4,
  md: 4,
  lg: 3,
};

export interface CheckMarkerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "size"> {
  checked: boolean;
  shape?: CheckMarkerShape;
  size?: CheckMarkerSize;
  tone?: CheckMarkerTone;
  disabled?: boolean;
  previewOnHover?: boolean;
  className?: string;
}

export default function CheckMarker({
  checked,
  shape = "square",
  size = "sm",
  tone = "black-fill",
  disabled = false,
  previewOnHover = false,
  className = "",
  ...props
}: CheckMarkerProps) {
  const checkedClasses = tone === "yellow-fill"
    ? "bg-primary-soft theme-brutal:bg-soft-signal text-foreground-strong theme-brutal:text-black"
    : "bg-foreground-strong theme-brutal:bg-black text-white";
  const uncheckedClasses = previewOnHover
    ? "bg-layer-panel theme-brutal:bg-white text-transparent group-hover:text-foreground-placeholder theme-brutal:group-hover:text-black/20"
    : "bg-layer-panel theme-brutal:bg-white text-transparent";

  return (
    <span
      {...props}
      aria-hidden
      className={[
        "check-marker-brutal inline-flex shrink-0 items-center justify-center border theme-brutal:border-2 border-line-strong theme-brutal:border-black transition-colors",
        SIZE_CLASS[size],
        shape === "circle" ? "rounded-full" : "",
        checked ? checkedClasses : uncheckedClasses,
        disabled ? "opacity-50" : "",
        className,
      ].filter(Boolean).join(" ")}
    >
      {(checked || previewOnHover) && (
        <Check size={ICON_PX[size]} strokeWidth={STROKE_WIDTH[size]} />
      )}
    </span>
  );
}

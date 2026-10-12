import type { ButtonHTMLAttributes, ReactNode } from "react";

export const SHOW_MORE_TOGGLE_CLASS = "text-[11px] font-black text-foreground-muted theme-brutal:text-black/60 underline underline-offset-2 hover:text-foreground-strong theme-brutal:hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-line-strong theme-brutal:focus-visible:outline-black";

type ShowMoreToggleProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> & {
  expanded: boolean;
  collapsedLabel: ReactNode;
  expandedLabel?: ReactNode;
};

export default function ShowMoreToggle({
  expanded,
  collapsedLabel,
  expandedLabel = "Collapse",
  className = "",
  ...buttonProps
}: ShowMoreToggleProps) {
  const cls = `${SHOW_MORE_TOGGLE_CLASS}${className ? ` ${className}` : ""}`;
  return (
    <button type="button" className={cls} {...buttonProps}>
      {expanded ? expandedLabel : collapsedLabel}
    </button>
  );
}

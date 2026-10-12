import type { HTMLAttributes, ReactNode } from "react";

export default function SurfaceListItem({
  children,
  selected = false,
  interactive = true,
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  selected?: boolean;
  interactive?: boolean;
}) {
  return (
    <div
      className={[
        "border theme-brutal:border-2 px-4 py-3 transition-colors",
        selected
          ? "border-line-strong theme-brutal:border-black bg-info-soft/15 theme-brutal:bg-brutal-cyan/15 shadow-raft-xs theme-brutal:shadow-brutal-sm"
          : [
              "border-line-muted theme-brutal:border-black/30 bg-layer-panel theme-brutal:bg-white",
              interactive ? "hover:border-line-strong theme-brutal:hover:border-black hover:shadow-raft-xs theme-brutal:hover:shadow-brutal-sm" : "",
            ].join(" "),
        className,
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

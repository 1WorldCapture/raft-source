import { createElement, type ReactNode } from "react";

// Children always sit in the body host. The strip and status bar are later
// siblings, so showing or hiding them does not remount the app stack.
export function connectionBannerFrame<S>(input: {
  Host: (props: { children?: ReactNode; style?: S }) => ReactNode;
  rootStyle: S;
  bodyStyle: S;
  children: ReactNode;
  strip: ReactNode;
  status: ReactNode;
}): ReactNode {
  const { Host, rootStyle, bodyStyle, children, strip, status } = input;
  return createElement(
    Host,
    { style: rootStyle },
    createElement(Host, { style: bodyStyle }, children),
    strip,
    status,
  );
}

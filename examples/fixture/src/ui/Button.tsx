import type { ButtonHTMLAttributes } from "react";

/** A labelled button: "default" for most, "primary" for the main action, "ghost" for ways out. */
export function Button({
  variant = "default",
  small = false,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost"; small?: boolean }) {
  const cls = ["btn", variant !== "default" && variant, small && "small", className].filter(Boolean).join(" ");
  return <button type="button" className={cls} {...rest} />;
}

import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "icon";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  icon: "btn btn-icon",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "btn-sm",
  md: "btn-md",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  disabled = false,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    variantClasses[variant],
    sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button className={classes} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}

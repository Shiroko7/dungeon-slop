interface LoadingSpinnerProps {
  size?: number;
}

export function LoadingSpinner({ size }: LoadingSpinnerProps) {
  const style = size ? { width: size, height: size } : undefined;

  return <div className="spinner" style={style} />;
}

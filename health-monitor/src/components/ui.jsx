export function cn(...values) {
  return values.filter(Boolean).join(" ");
}

export function Card({ className, children }) {
  return <div className={cn("rounded-xl border border-zinc-800 bg-zinc-950/70 shadow-sm", className)}>{children}</div>;
}

export function CardHeader({ className, children }) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)}>{children}</div>;
}

export function CardContent({ className, children }) {
  return <div className={cn("p-6 pt-0", className)}>{children}</div>;
}

export function Badge({ variant = "default", children }) {
  const variants = {
    default: "border-emerald-500/20 bg-emerald-500/10 text-emerald-400",
    destructive: "border-red-500/20 bg-red-500/10 text-red-400",
    secondary: "border-zinc-700 bg-zinc-800 text-zinc-300",
    warning: "border-amber-500/20 bg-amber-500/10 text-amber-400",
  };
  return <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", variants[variant])}>{children}</span>;
}

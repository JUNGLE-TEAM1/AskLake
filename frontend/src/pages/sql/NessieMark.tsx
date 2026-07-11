import { useState } from "react";
import { Sparkles } from "lucide-react";

import nessieIcon from "@/assets/asklake-nessi-icon.png";
import { cn } from "@/lib/utils";

export function NessieMark({ className }: { className?: string }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (imageFailed) {
    return <Sparkles aria-hidden="true" className={cn("text-emerald-500", className)} />;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("object-contain", className)}
      onError={() => setImageFailed(true)}
      src={nessieIcon}
    />
  );
}

import { cn } from "@/lib/utils";
import { SqlPageIcon } from "./SqlPageIcon";

export function NessieMark({ className }: { className?: string }) {
  return <SqlPageIcon aria-hidden="true" className={cn("text-blue-600", className)} />;
}

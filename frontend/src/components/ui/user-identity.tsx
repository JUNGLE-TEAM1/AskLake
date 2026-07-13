import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

export function getIdentityInitials(name: string, explicitInitials?: string) {
  if (explicitInitials?.trim()) return explicitInitials.trim().slice(0, 2).toUpperCase();

  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

export type UserIdentityProps = React.ComponentProps<"div"> & {
  avatarAlt?: string;
  avatarInitials?: string;
  avatarUrl?: string;
  name: string;
  nameClassName?: string;
  secondary?: string;
  secondaryClassName?: string;
  size?: "default" | "sm" | "lg";
};

export function UserIdentity({
  avatarAlt,
  avatarInitials,
  avatarUrl,
  className,
  name,
  nameClassName,
  secondary,
  secondaryClassName,
  size = "lg",
  ...props
}: UserIdentityProps) {
  return (
    <div className={cn("user-identity flex min-w-0 items-center gap-2.5 text-left", className)} {...props}>
      <Avatar size={size}>
        {avatarUrl && <AvatarImage alt={avatarAlt ?? `${name} 프로필`} src={avatarUrl} />}
        <AvatarFallback className="bg-slate-100 font-semibold text-slate-700 ring-1 ring-slate-200">
          {getIdentityInitials(name, avatarInitials)}
        </AvatarFallback>
      </Avatar>
      <div className="grid min-w-0 gap-1">
        <span className={cn("truncate text-lg font-semibold text-slate-800", nameClassName)} title={name}>
          {name}
        </span>
        {secondary && (
          <span className={cn("truncate text-base font-medium text-slate-500", secondaryClassName)} title={secondary}>
            {secondary}
          </span>
        )}
      </div>
    </div>
  );
}

import asklakeLogo from "../../assets/asklake-logo.png";
import { navItems } from "../../data/appShellData";
import type { CurrentUserResponse, NavId, NavItem } from "../../types";
import { ChevronUp, CircleUser, LogOut } from "../../vendor/lucide";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { UserIdentity } from "../ui/user-identity";

export function Sidebar({
  activeNavId,
  canAccessAdmin,
  currentUser,
  logoutPending,
  onAccount,
  onBrandClick,
  onLogout,
  onNavigate,
}: {
  activeNavId: NavId | null;
  canAccessAdmin: boolean;
  currentUser: CurrentUserResponse;
  logoutPending: boolean;
  onAccount: () => void;
  onBrandClick: () => void;
  onLogout: () => Promise<void>;
  onNavigate: (item: NavItem) => void;
}) {
  const visibleNavItems = canAccessAdmin ? navItems : navItems.filter((item) => item.id !== "admin");
  const displayName = currentUser.profile.displayName || currentUser.displayName || currentUser.email;
  const email = currentUser.profile.email || currentUser.email;

  return (
    <aside className="sidebar">
      <button className="brand" type="button" aria-label="수집/처리 랜딩 페이지로 이동" onClick={onBrandClick}>
        <img src={asklakeLogo} alt="AskLake" />
      </button>
      <nav className="nav-list">
        {visibleNavItems.map((item) => {
          const { icon: Icon, id, label } = item;
          return (
          <button className={id === activeNavId ? "nav-item active" : "nav-item"} key={id} type="button" onClick={() => onNavigate(item)}>
            <Icon size={18} />
            <span>{label}</span>
          </button>
          );
        })}
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label={`${displayName} 계정 메뉴 열기`} className="account-button" title={`${displayName} · ${email}`} type="button">
            <UserIdentity
              avatarInitials={currentUser.profile.avatarInitials}
              className="min-w-0 flex-1"
              name={displayName}
              nameClassName="text-sm"
              size="sm"
            />
            <ChevronUp aria-hidden="true" className="size-4 shrink-0 text-slate-400" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-0"
          side="top"
          sideOffset={8}
          style={{
            maxWidth: "calc(var(--sidebar-width) - 20px)",
            width: "var(--radix-dropdown-menu-trigger-width)",
          }}
        >
          <DropdownMenuItem className="py-2.5 text-sm" onSelect={onAccount}>
            <CircleUser aria-hidden="true" className="size-4" />
            내 프로필
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="py-2.5 text-sm text-red-600 focus:bg-red-50 focus:text-red-700"
            disabled={logoutPending}
            onSelect={() => void onLogout()}
          >
            <LogOut aria-hidden="true" className="size-4" />
            {logoutPending ? "로그아웃 중..." : "로그아웃"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </aside>
  );
}

import { CircleUser } from "lucide-react";
import asklakeLogo from "../../assets/asklake-logo.png";
import { navItems } from "../../data/appShellData";
import type { NavId, NavItem } from "../../types";

export function Sidebar({
  activeNavId,
  canAccessAdmin,
  onAccount,
  onBrandClick,
  onNavigate,
}: {
  activeNavId: NavId | null;
  canAccessAdmin: boolean;
  onAccount: () => void;
  onBrandClick: () => void;
  onNavigate: (item: NavItem) => void;
}) {
  const visibleNavItems = canAccessAdmin ? navItems : navItems.filter((item) => item.id !== "admin");

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
      <button className="account-button" type="button" onClick={onAccount}>
        <CircleUser size={18} />
        <span>내 계정</span>
      </button>
    </aside>
  );
}

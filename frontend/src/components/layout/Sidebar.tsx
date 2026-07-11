import { CircleUser } from "lucide-react";
import asklakeLogo from "../../assets/asklake-logo.png";
import { navItems } from "../../data/appShellData";
import type { NavId, NavItem } from "../../types";

export function Sidebar({
  activeNavId,
  onAccount,
  onBrandClick,
  onNavigate,
}: {
  activeNavId: NavId;
  onAccount: () => void;
  onBrandClick: () => void;
  onNavigate: (item: NavItem) => void;
}) {
  return (
    <aside className="sidebar">
      <button className="brand" type="button" aria-label="수집/처리 랜딩 페이지로 이동" onClick={onBrandClick}>
        <img src={asklakeLogo} alt="AskLake" />
      </button>
      <p className="nav-eyebrow">나만무 Data Lake</p>
      <nav className="nav-list">
        {navItems.map((item) => {
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

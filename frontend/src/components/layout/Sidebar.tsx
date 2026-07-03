import { CircleUser } from "lucide-react";
import { navItems } from "../../data/mockData";
import type { NavId, NavItem } from "../../types";

export function Sidebar({ activeNavId, onAccount, onNavigate }: { activeNavId: NavId; onAccount: () => void; onNavigate: (item: NavItem) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <strong>AskLake</strong>
      </div>
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

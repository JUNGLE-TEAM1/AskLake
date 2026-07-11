import { Boxes, CircleUser, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InfoBox, PageTitle } from "../../components/common";
import { fetchCurrentUser } from "../../services/identityApi";
import { ApiError } from "../../types";
import type { CurrentUserResponse, PermissionSummary } from "../../types";

type ProfilePageProps = {
  onAction: (action: string, apiPath: string, targetId: string, result?: "success" | "failed", options?: { targetType?: "ui" }) => void;
};

const permissionLabels: Array<[keyof PermissionSummary, string]> = [
  ["canView", "조회"],
  ["canQuery", "쿼리"],
  ["canRun", "실행"],
  ["canManage", "관리"],
  ["canDelete", "삭제"],
  ["canShare", "공유"],
];

export function ProfilePage({ onAction }: ProfilePageProps) {
  const [currentUser, setCurrentUser] = useState<CurrentUserResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onActionRef = useRef(onAction);

  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchCurrentUser()
      .then((user) => {
        if (!active) return;
        setCurrentUser(user);
        setError(null);
        onActionRef.current("identity.profile.loaded", "/api/users/me", user.id, "success", { targetType: "ui" });
      })
      .catch((unknownError) => {
        if (!active) return;
        const message = unknownError instanceof ApiError ? unknownError.message : "프로필 정보를 불러오지 못했습니다.";
        setError(message);
        onActionRef.current("identity.profile.load_failed", "/api/users/me", "profile", "failed", { targetType: "ui" });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const profile = currentUser?.profile;
  const displayName = profile?.displayName || currentUser?.displayName || "사용자";
  const avatarInitials = profile?.avatarInitials || initials(displayName);

  return (
    <div className="content-grid module-page-grid profile-page">
      <div className="content-main">
        <PageTitle
          title="내 프로필"
          description="현재 actor 기준의 계정 정보, 소속 그룹, 접근 권한 요약을 확인합니다."
          icon={<CircleUser size={28} />}
        />

        {loading && (
          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon"><CircleUser size={17} /></span>
              <div>
                <h2>프로필 로딩 중</h2>
                <p>현재 세션의 계정 정보를 확인합니다.</p>
              </div>
            </div>
            <InfoBox title="API 요청 처리 중" body="/api/users/me에서 현재 사용자 정보를 가져오고 있습니다." />
          </section>
        )}

        {!loading && error && (
          <section className="xflow-review-card">
            <div className="xflow-review-card-header">
              <span className="xflow-review-icon"><CircleUser size={17} /></span>
              <div>
                <h2>프로필 오류</h2>
                <p>계정 정보를 불러오지 못했습니다.</p>
              </div>
            </div>
            <InfoBox title="프로필 요청 실패" body={error} />
          </section>
        )}

        {!loading && currentUser && (
          <div className="xflow-review-stack profile-xflow-stack">
            <section className="xflow-review-card profile-hero-panel">
              <div className="profile-hero">
                <div className="profile-avatar" aria-hidden="true">{avatarInitials}</div>
                <div>
                  <span className="profile-role">{currentUser.role}</span>
                  <h2>{displayName}</h2>
                  <p>{currentUser.email}</p>
                  {profile?.title && <small>{profile.title}</small>}
                </div>
              </div>
            </section>

            <section className="xflow-review-card">
              <div className="xflow-review-card-header">
                <span className="xflow-review-icon permission"><ShieldCheck size={17} /></span>
                <div>
                  <h2>권한 요약</h2>
                  <p>{currentUser.permissionsSummary.canView}개 리소스 조회 가능</p>
                </div>
              </div>
              <div className="profile-permission-grid">
                {permissionLabels.map(([key, label]) => (
                  <article className="profile-permission-card" key={key}>
                    <strong>{label}</strong>
                    <span>{currentUser.permissionsSummary[key]}개</span>
                  </article>
                ))}
              </div>
            </section>

            <section className="xflow-review-card">
              <div className="xflow-review-card-header">
                <span className="xflow-review-icon schema"><Boxes size={17} /></span>
                <div>
                  <h2>소속 그룹</h2>
                  <p>{currentUser.groups.length}개 그룹이 현재 actor principal로 계산됩니다.</p>
                </div>
              </div>
              <div className="profile-group-list">
                {currentUser.groups.map((group) => (
                  <article className="profile-group-row" key={group.id}>
                    <div>
                      <strong>{group.name}</strong>
                      <span>{group.description || group.id}</span>
                    </div>
                    {typeof group.memberCount === "number" && <em>{group.memberCount} members</em>}
                  </article>
                ))}
                {currentUser.groups.length === 0 && <InfoBox title="소속 그룹 없음" body="현재 actor header에 연결된 그룹이 없습니다." />}
              </div>
            </section>
          </div>
        )}
      </div>

      <aside className="xflow-review-card profile-summary-panel">
        <div className="xflow-review-card-header">
          <span className="xflow-review-icon"><CircleUser size={17} /></span>
          <div>
            <h2>Actor Context</h2>
            <p>권한 계산에 사용하는 현재 계정 기준입니다.</p>
          </div>
        </div>
        <dl>
          <div>
            <dt>사용자</dt>
            <dd>{currentUser?.displayName || "-"}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{currentUser?.role || "-"}</dd>
          </div>
          <div>
            <dt>Groups</dt>
            <dd>{currentUser?.groups.map((group) => group.name).join(", ") || "-"}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

function initials(value: string) {
  const words = value.replace(/[_-]+/g, " ").split(" ").filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "U";
}

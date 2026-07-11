import { useEffect, useRef, useState } from "react";
import { Bot, Braces, Database, FileText, Search, ShieldCheck, Workflow } from "lucide-react";
import { Link } from "react-router";
import askLakeLogo from "../../assets/asklake-logo.png";
import nessiMascot from "../../assets/landing/nessi-mascot.png";
import teamSheet from "../../assets/landing/team-members.png";

const teamMembers = [
  { name: "박태정", role: "Backend Developer", position: "7.3% 8.8%" },
  { name: "염태선", role: "Frontend Developer", position: "48.8% 8.8%" },
  { name: "유중일", role: "Backend Developer", position: "90.7% 8.8%" },
  { name: "이원재", role: "Backend Developer", position: "7.3% 70.8%" },
  { name: "이해건", role: "Backend Developer", position: "48.8% 70.8%" },
  { name: "황선호", role: "Frontend Developer", position: "90.7% 70.8%" },
] as const;

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "landing-brand compact" : "landing-brand"}>
      <img alt="" aria-hidden="true" src="/asklake-wave-icon.png" />
      <span>AskLake</span>
    </span>
  );
}

function HeroMark() {
  return (
    <div className="landing-hero-mark" aria-label="물결 위를 헤엄치는 AskLake 네시" role="img">
      <div className="landing-nessi-track" aria-hidden="true">
        <span className="landing-nessi-mover">
          <span className="landing-nessi-swimmer" style={{ backgroundImage: `url(${nessiMascot})` }} />
        </span>
      </div>
      <div className="landing-wave-stack" aria-hidden="true">
        <img className="landing-wave-logo" alt="" src="/asklake-wave-hero.svg" />
      </div>
    </div>
  );
}

function ChallengeVisual() {
  return (
    <div className="landing-visual landing-signal-visual" aria-hidden="true">
      <div className="landing-source-stack">
        <span><Database size={22} />Database</span>
        <span><Braces size={22} />API</span>
        <span><FileText size={22} />Files</span>
        <span><Workflow size={22} />Logs</span>
      </div>
      <div className="landing-signal-lines">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="landing-scatter-dots">
        {Array.from({ length: 13 }, (_, index) => <i key={index} />)}
      </div>
    </div>
  );
}

function LakehouseVisual() {
  return (
    <div className="landing-visual landing-lakehouse-visual" aria-hidden="true">
      <div className="landing-source-stack compact">
        <span><Database size={20} />DB</span>
        <span><Braces size={20} />API</span>
        <span><FileText size={20} />FILE</span>
      </div>
      <div className="landing-flow-lines"><i /><i /><i /></div>
      <div className="landing-lake-basin">
        <img alt="" src="/asklake-wave-icon.png" />
        <span>Trusted Lake</span>
      </div>
    </div>
  );
}

function CatalogVisual() {
  return (
    <div className="landing-visual landing-product-window" aria-hidden="true">
      <div className="landing-window-topbar">
        <Brand compact />
        <strong>sales_orders</strong>
        <span>•••</span>
      </div>
      <div className="landing-window-body">
        <div className="landing-window-sidebar"><Search /><Database /><Workflow /><ShieldCheck /></div>
        <div className="landing-schema-panel">
          <small>Schema</small>
          <span><b>order_id</b><em>string</em></span>
          <span><b>customer_id</b><em>string</em></span>
          <span><b>amount</b><em>decimal</em></span>
          <span><b>order_date</b><em>date</em></span>
        </div>
        <div className="landing-lineage-panel">
          <small>Lineage</small>
          <div className="landing-lineage-map"><i /><i /><b /><i /><i /></div>
          <div className="landing-quality"><strong>98%</strong><span>Validity</span></div>
        </div>
      </div>
    </div>
  );
}

function QueryVisual() {
  return (
    <div className="landing-visual landing-query-window" aria-hidden="true">
      <div className="landing-query-tabs"><strong>SQL</strong><span><Bot size={16} />AI Assistant</span></div>
      <pre>{`SELECT region,
       SUM(amount) AS revenue
FROM sales_orders
GROUP BY region
ORDER BY revenue DESC;`}</pre>
      <div className="landing-query-results">
        <div><span>Americas</span><i style={{ width: "92%" }} /></div>
        <div><span>EMEA</span><i style={{ width: "72%" }} /></div>
        <div><span>APAC</span><i style={{ width: "54%" }} /></div>
      </div>
    </div>
  );
}

const storyItems = [
  {
    body: "Data lives everywhere—databases, APIs, files, and logs. When those sources stay siloed, trust and focus disappear.",
    label: "The Challenge",
    title: <><span>Scattered data,</span><span>scattered <em>focus.</em></span></>,
    Visual: ChallengeVisual,
  },
  {
    body: "AskLake gathers distributed data into one governed lake, ready for reliable processing and shared discovery.",
    label: "Data Lakehouse",
    title: <><span>Unified storage,</span><span>trusted <em>scale.</em></span></>,
    Visual: LakehouseVisual,
  },
  {
    body: "Explore schema, lineage, quality, and ownership together so every dataset is understandable before it is used.",
    label: "Catalog",
    title: <><span>Find what matters,</span><span><em>instantly.</em></span></>,
    Visual: CatalogVisual,
  },
  {
    body: "Move from SQL exploration to AI-assisted analysis and dashboards without losing the dataset context behind the result.",
    label: "Query",
    title: <><span>Turn trusted data</span><span>into <em>answers.</em></span></>,
    Visual: QueryVisual,
  },
] as const;

function TeamGroup({ duplicate = false }: { duplicate?: boolean }) {
  return (
    <div className="landing-team-group" aria-hidden={duplicate || undefined}>
      {teamMembers.map((member) => (
        <article className="landing-team-card" key={`${duplicate ? "copy-" : ""}${member.name}`}>
          <div
            className="landing-team-photo"
            style={{
              backgroundImage: `url(${teamSheet})`,
              backgroundPosition: member.position,
              backgroundSize: "390% auto",
            }}
          >
            <span>{member.role}</span>
          </div>
          <h3>{member.name}</h3>
        </article>
      ))}
    </div>
  );
}

export function AskLakeLandingPage() {
  const [activeStory, setActiveStory] = useState(0);
  const storyRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const nextIndex = Number((entry.target as HTMLElement).dataset.storyIndex);
        if (Number.isInteger(nextIndex)) setActiveStory(nextIndex);
      });
    }, { rootMargin: "-42% 0px -42% 0px", threshold: 0 });

    storyRefs.current.forEach((node) => {
      if (node) observer.observe(node);
    });

    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing-page">
      <header className="landing-header">
        <a className="landing-header-brand" href="#top" aria-label="AskLake 처음으로">
          <Brand />
        </a>
        <nav aria-label="랜딩 페이지 탐색">
          <a href="#solutions">Solutions</a>
          <a href="#team">Team</a>
        </nav>
        <Link className="landing-button landing-button-dark landing-header-cta" to="/login">Start AskLake</Link>
      </header>

      <main id="top">
        <section className="landing-hero" aria-labelledby="landing-hero-title">
          <HeroMark />
          <h1 className="landing-hero-wordmark" id="landing-hero-title">
            <img alt="AskLake" src={askLakeLogo} />
          </h1>
          <p>From collection to catalog, analysis to action.<br />One trusted lake for every data journey.</p>
          <div className="landing-hero-actions">
            <Link className="landing-button landing-button-dark" to="/login">Get Started</Link>
            <a className="landing-button landing-button-light" href="#video">Watch Video</a>
          </div>
        </section>

        <section className="landing-video-section" id="video" aria-labelledby="landing-video-title">
          <h2 id="landing-video-title">See AskLake in motion.</h2>
          <div className="landing-video-frame">
            <iframe
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              loading="lazy"
              src="https://www.youtube-nocookie.com/embed/-bSkREem8dM?rel=0"
              title="AskLake 소개 영상"
            />
          </div>
        </section>

        <section className="landing-sticky-showcase" id="solutions" aria-label="AskLake 핵심 기능">
          <div className="landing-showcase-grid">
            <div className="landing-showcase-copy-rail">
              {storyItems.map(({ body, label, title, Visual }, index) => (
                <article
                  aria-current={activeStory === index ? "step" : undefined}
                  className={activeStory === index ? "landing-showcase-step active" : "landing-showcase-step"}
                  data-story-index={index}
                  key={label}
                  ref={(node) => { storyRefs.current[index] = node; }}
                >
                  <div className="landing-story-copy">
                    <span className="landing-section-label">{label}</span>
                    <h2>{title}</h2>
                    <p>{body}</p>
                    <div className="landing-showcase-mobile-visual"><Visual /></div>
                  </div>
                </article>
              ))}
            </div>

            <div className="landing-showcase-visual-rail">
              <div className="landing-showcase-sticky">
                <div className="landing-showcase-stage">
                  {storyItems.map(({ label, Visual }, index) => (
                    <div
                      aria-hidden={activeStory !== index}
                      className={activeStory === index ? "landing-showcase-pane active" : "landing-showcase-pane"}
                      key={label}
                    >
                      <Visual />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="landing-team-section" id="team" aria-labelledby="landing-team-title">
          <div className="landing-team-heading">
            <span className="landing-section-label">Our Team</span>
            <h2 id="landing-team-title">Meet the Team</h2>
            <p>AskLake is built by a team making trusted data easier to collect, understand, and use.</p>
          </div>
          <div className="landing-team-marquee">
            <div className="landing-team-track">
              <TeamGroup />
              <TeamGroup duplicate />
            </div>
          </div>
        </section>

        <section className="landing-final-cta">
          <img alt="" aria-hidden="true" src="/asklake-wave-icon.png" />
          <h2>Ready to build your trusted data lake?</h2>
          <Link className="landing-button landing-button-dark" to="/login">Start AskLake Now</Link>
        </section>
      </main>

      <footer className="landing-footer">
        <Brand />
        <nav aria-label="하단 탐색">
          <a href="#solutions">Solutions</a>
          <a href="#team">Team</a>
        </nav>
        <span>© 2026 AskLake</span>
      </footer>
    </div>
  );
}

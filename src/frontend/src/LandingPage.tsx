export function SiteNav(_props: { dashboard?: boolean }) {
  return <header className="site-nav">
    <div className="site-nav__in">
      <a className="site-brand" href="/dashboard" aria-label="AI6 live board">
        <span>AI6</span>
      </a>
      <span className="site-nav__status"><i aria-hidden="true" /> Live market data</span>
    </div>
  </header>;
}

export function DashboardHero() {
  return <section className="dashboard-hero">
    <div className="dashboard-hero__in">
      <p>Execution monitor</p>
      <h1>Jupiter and Backpack live board</h1>
      <p>Live quotes and finalized on-chain execution records. Estimated opportunities are kept separate from realized results.</p>
    </div>
  </section>;
}

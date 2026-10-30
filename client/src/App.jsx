import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Activity, AlertCircle, ArrowDownLeft, ArrowUpRight, Bot, LayoutGrid, List, Loader2,
  RefreshCw, Repeat, ShieldCheck, Sparkles, Store, TrendingUp, UploadCloud, Wallet, X,
} from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MAX_FILE = 12 * 1024 * 1024;
const DEFAULT_GOAL = "Audit my transactions for subscription traps and silent price hikes.";
const EXAMPLE = [
  "2026-09-14 TST* SPOTIFY USA 11.99",
  "2026-09-18 UPI/FOOD DELIVERY/8231 18.75",
  "2026-09-20 POS HPCL FUEL HYD 25.00",
].join("\n");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CAT_COLORS = {
  Subscriptions: "#656fe0", Shopping: "#e8a33d", Fuel: "#3aa981", "Food delivery": "#d6609a",
  Dining: "#4e9bd6", Income: "#3aa981", Bills: "#8a6fd1", Other: "#8b91a7",
};

const usd = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const round2 = (n) => Math.round(n * 100) / 100;
const fmtDay = (iso) => {
  if (!iso) return "Date unclear";
  const [, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};
const fmtMonth = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// Every request goes through here so errors always surface the backend's `detail` message.
async function api(path, options) {
  let res;
  try {
    res = await fetch(API + path, options);
  } catch {
    throw new Error("Could not reach the backend. Is it running on " + API + "?");
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const d = data?.detail;
    throw new Error(typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x.msg).join("; ") : `Request failed (${res.status})`);
  }
  return data;
}

// L3: all dashboard maths is plain JavaScript, recomputed whenever transactions change.
function useDashboard(tx) {
  return useMemo(() => {
    const charges = tx.filter((t) => t.amount > 0);
    const outflow = round2(charges.reduce((s, t) => s + t.amount, 0));
    const subs = round2(charges.filter((t) => t.category === "Subscriptions").reduce((s, t) => s + t.amount, 0));
    const byMonth = {};
    charges.filter((t) => t.date).forEach((t) => {
      const k = t.date.slice(0, 7);
      byMonth[k] = (byMonth[k] || 0) + t.amount;
    });
    const monthly = Object.keys(byMonth).sort().map((k) => ({ month: fmtMonth(k), total: round2(byMonth[k]) }));
    const byCat = {};
    charges.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + t.amount; });
    const cats = Object.entries(byCat).map(([name, v]) => ({ name, total: round2(v) }))
      .sort((a, b) => b.total - a.total).slice(0, 6);
    const rows = [...tx].sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? 1 : -1));
    return { count: tx.length, merchants: new Set(tx.map((t) => t.merchant)).size, outflow, subs, monthly, cats, rows };
  }, [tx]);
}

function Metric({ icon: Icon, tone, label, value, sub }) {
  return (
    <div className="card metric">
      <div className={`metric-icon ${tone}`}><Icon size={18} /></div>
      <div>
        <div className="metric-label">{label}</div>
        <div className="metric-value">{value}</div>
        <div className="metric-sub">{sub}</div>
      </div>
    </div>
  );
}

function TraceTimeline({ log }) {
  const tone = (t) => (t === "tool" ? "green" : t === "error" ? "red" : ["approval_required", "approved_simulation", "rejected"].includes(t) ? "amber" : "blue");
  return (
    <ol className="timeline">
      {log.map((e, i) => (
        <li key={i}>
          <span className={`dot ${tone(e.type)}`} />
          <div>
            <div className="tl-msg">{e.message}</div>
            <div className="tl-meta">{e.type} · {fmtTime(e.time)}</div>
            {e.type === "plan" && e.details?.tool && (
              <code className="tl-code">{e.details.tool}({JSON.stringify(e.details.arguments || {})})</code>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function App() {
  const [transactions, setTransactions] = useState([]);
  const [source, setSource] = useState("Sample data");
  const [health, setHealth] = useState({ gemini_configured: false });
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState([]);
  const [goal, setGoal] = useState(DEFAULT_GOAL);
  const [audit, setAudit] = useState(null);
  const [busy, setBusy] = useState({ sample: false, extract: false, audit: false, decide: false });
  const fileRef = useRef(null);
  const dash = useDashboard(transactions);

  const setFlag = (k, v) => setBusy((b) => ({ ...b, [k]: v }));

  async function loadSample() {
    setError(""); setAudit(null); setNotes([]); setFlag("sample", true);
    try {
      const d = await api("/api/sample");
      setTransactions(d.transactions);
      setSource("Sample data");
    } catch (e) {
      setError(e.message.startsWith("Could not reach") ? "Could not load sample data. Is the backend running?" : e.message);
    } finally { setFlag("sample", false); }
  }

  useEffect(() => {
    loadSample();
    api("/api/health").then(setHealth).catch(() => setHealth({ gemini_configured: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickFile(f) {
    if (!f) return;
    if (f.size > MAX_FILE) { setError("Please use a file smaller than 12 MB for this classroom demo."); return; }
    setError(""); setFile(f);
  }

  async function extract() {
    setError(""); setAudit(null); setNotes([]); setFlag("extract", true);
    try {
      const form = new FormData();
      if (text.trim()) form.append("text", text);
      if (file) form.append("file", file);
      const d = await api("/api/extract", { method: "POST", body: form });
      setNotes(d.notes || []);
      if (d.count === 0) {
        setError("No valid transactions were extracted. Check the input and try again.");
      } else {
        setTransactions(d.transactions);
        setSource("Your input");
      }
    } catch (e) {
      setError(e.message); // existing transactions stay untouched
    } finally { setFlag("extract", false); }
  }

  async function runAudit() {
    setError(""); setAudit(null); setFlag("audit", true);
    try {
      setAudit(await api("/api/audits", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions, goal }),
      }));
    } catch (e) { setError(e.message); } finally { setFlag("audit", false); }
  }

  async function decide(decision) {
    setError(""); setFlag("decide", true);
    try {
      setAudit(await api(`/api/audits/${audit.session_id}/approval`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      }));
    } catch (e) { setError(e.message); } finally { setFlag("decide", false); }
  }

  const goTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  const pa = audit?.pending_action;
  const decided = pa && (pa.approved === true || pa.approved === false);
  const statusLabel = audit ? audit.status.replace("_", " ") : "";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon"><Activity size={20} /></div>
          <div><div className="brand-name">Finwise</div><div className="brand-cap">INTELLIGENCE AGENT</div></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          <button className="nav active" onClick={() => goTo("top")}><LayoutGrid size={16} /> Overview</button>
          <button className="nav" onClick={() => goTo("transactions")}>
            <List size={16} /> Transactions <span className="badge">{dash.count}</span>
          </button>
          <button className="nav" onClick={() => goTo("agent")}><Bot size={16} /> Agent audit</button>
        </nav>
        <div className="side-card">
          <ShieldCheck size={18} />
          <strong>Demo-safe mode</strong>
          <p>Sample data is fictional. Approval actions are simulated and never sent.</p>
          <small>WORKSHOP BUILD · v1.0.0</small>
        </div>
      </aside>

      <main className="main" id="top">
        <header className="topbar">
          <div>
            <div className="eyebrow">PERSONAL FINANCE / OVERVIEW</div>
            <h1>Finance overview</h1>
            <p className="sub">Understand your spending. Let your agent investigate the details.</p>
          </div>
          <div className="top-right">
            <span className="status">
              <span className={`status-dot ${health.gemini_configured ? "on" : ""}`} />
              {health.gemini_configured ? "Gemini connected" : "Demo mode available"}
            </span>
            <button className="icon-btn" aria-label="Reload sample data" onClick={loadSample} disabled={busy.sample}>
              <RefreshCw size={16} className={busy.sample ? "spin" : ""} />
            </button>
            <div className="avatar">N</div>
          </div>
        </header>

        {error && (
          <div className="banner" role="alert">
            <AlertCircle size={18} /><span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button>
          </div>
        )}

        <section className="metrics">
          <Metric icon={Wallet} tone="blue" label="Total transactions" value={dash.count} sub={`${dash.merchants} unique merchants`} />
          <Metric icon={TrendingUp} tone="violet" label="Total outflow" value={usd(dash.outflow)} sub="Across loaded transactions" />
          <Metric icon={Repeat} tone="amber" label="Subscription charges" value={usd(dash.subs)} sub="All visible periods combined" />
          <Metric icon={Store} tone="green" label="Potential price hikes"
            value={audit ? audit.findings.length : "—"} sub={audit ? "Found by the agent" : "Run an agent audit"} />
        </section>

        <section className="two-col">
          <div className="card">
            <div className="card-head">
              <div><h2>Spending activity</h2><p className="sub">Monthly transaction outflow</p></div>
              <span className="pill">{source}</span>
            </div>
            {dash.monthly.length === 0 ? (
              <div className="empty">Add dated transactions to see spending activity.</div>
            ) : (
              <div className="chart">
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={dash.monthly} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#6d78e8" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#6d78e8" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="4 4" vertical={false} stroke="#e4e7f0" />
                    <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} />
                    <YAxis tickFormatter={(v) => `$${v}`} tickLine={false} axisLine={false} fontSize={12} width={48} />
                    <Tooltip formatter={(v) => usd(v)} />
                    <Area type="monotone" dataKey="total" stroke="#6d78e8" strokeWidth={2.5} fill="url(#fill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div><h2>Spending by category</h2><p className="sub">Positive charges only</p></div></div>
            {dash.cats.length === 0 ? (
              <div className="empty">Category totals appear after transactions are loaded.</div>
            ) : (
              <ul className="cats">
                {dash.cats.map((c) => (
                  <li key={c.name}>
                    <span className="cat-ico" style={{ background: CAT_COLORS[c.name] }}>{c.name[0]}</span>
                    <div className="cat-body">
                      <div className="cat-row"><span>{c.name}</span><strong>{usd(c.total)}</strong></div>
                      <div className="bar"><div style={{ width: `${Math.max(3, (c.total / dash.cats[0].total) * 100)}%`, background: CAT_COLORS[c.name] }} /></div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="card import">
          <div className="card-head">
            <div><div className="kicker">GENAI EXTRACTION</div><h2>Bring in financial data</h2></div>
            <span className="tag">01 Extract &amp; validate</span>
          </div>
          <div className="import-grid">
            <div className="drop">
              <input ref={fileRef} type="file" hidden accept="image/*,.pdf,.csv,.txt" onChange={(e) => pickFile(e.target.files?.[0])} />
              <UploadCloud size={26} />
              {file ? (
                <>
                  <strong>{file.name}</strong>
                  <span className="muted">{(file.size / 1024).toFixed(1)} KB</span>
                  <button className="link" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}>Remove</button>
                </>
              ) : (
                <>
                  <strong>Choose a receipt or statement</strong>
                  <span className="muted">PNG, JPG, PDF, CSV or TXT · max 12 MB</span>
                  <button className="btn secondary small" onClick={() => fileRef.current?.click()}>Browse files</button>
                </>
              )}
            </div>
            <div className="or">OR</div>
            <div className="paste">
              <label htmlFor="raw">Paste raw transaction text</label>
              <textarea id="raw" rows={4} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={"2026-09-14 TST* SPOTIFY USA 11.99\n2026-09-18 UPI/FOOD DELIVERY/8231 18.75"} />
              <div className="paste-foot">
                <span className="muted">Raw text is sent to Gemini when configured.</span>
                <button className="link" onClick={() => setText(EXAMPLE)}>Use example</button>
              </div>
            </div>
          </div>
          <div className="import-foot">
            <span className="muted">Structured output + Pydantic validation. Unclear fields should stay null, not guessed.</span>
            <div className="btn-row">
              <button className="btn secondary" onClick={loadSample} disabled={busy.sample}>
                {busy.sample && <Loader2 size={16} className="spin" />} Load sample data
              </button>
              <button className="btn primary" onClick={extract} disabled={busy.extract || (!text.trim() && !file)}>
                {busy.extract ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />} Extract transactions
              </button>
            </div>
          </div>
          {notes.length > 0 && (
            <div className="notes"><strong>Extraction notes</strong><ul>{notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
          )}
        </section>

        <section className="card" id="transactions">
          <div className="card-head">
            <div><h2>Transactions</h2><p className="sub">Validated, typed records feeding your dashboard</p></div>
            <span className="pill">{dash.count} records</span>
          </div>
          {dash.rows.length === 0 ? (
            <div className="empty">No transactions yet. Load sample data or extract a statement above.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>MERCHANT</th><th>DATE</th><th>CATEGORY</th><th>RAW SOURCE</th><th className="right">AMOUNT</th></tr></thead>
                <tbody>
                  {dash.rows.map((t, i) => (
                    <tr key={i}>
                      <td><span className="avatar-sm">{t.merchant[0]}</span><strong>{t.merchant}</strong></td>
                      <td>{fmtDay(t.date)}</td>
                      <td><span className="chip">{t.category}</span></td>
                      <td className="mono muted">{t.raw_line || "—"}</td>
                      <td className={`right amt ${t.amount < 0 ? "refund" : ""}`}>
                        {t.amount < 0 ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
                        {usd(Math.abs(t.amount))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section id="agent" className="agent">
          <div className="kicker">AUTONOMOUS AGENT</div>
          <h2 className="big">Run a finance audit</h2>
          <p className="sub">The agent investigates with Python tools, then asks before any consequential action.</p>
          <div className="agent-grid">
            <div className="card">
              <label htmlFor="goal" className="lbl">Your audit goal</label>
              <textarea id="goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
              <p className="safety">Read-only analysis runs automatically. Cancellation / dispute actions are drafts and require your approval. Nothing is sent.</p>
              <button className="btn primary full" onClick={runAudit} disabled={busy.audit || transactions.length === 0 || !goal.trim()}>
                {busy.audit ? <Loader2 size={16} className="spin" /> : <Bot size={16} />} Run agent audit
              </button>
            </div>

            <div className="card">
              <div className="card-head">
                <div><h2>Agent trace</h2><p className="sub">Tools, observations and decisions</p></div>
                {audit && <span className={`pill st-${audit.status}`}>{statusLabel}</span>}
              </div>
              {!audit ? (
                <div className="empty trace-empty">
                  <Bot size={30} />
                  <strong>Your audit trace will appear here</strong>
                  <p>Run an audit to see each planning step, tool call and approval request.</p>
                  <div className="mini"><span>Inspect</span>→<span>Calculate</span>→<span>Ask first</span></div>
                </div>
              ) : (
                <>
                  {audit.summary && <div className="summary">{audit.summary}</div>}
                  <TraceTimeline log={audit.audit_log} />
                </>
              )}
            </div>
          </div>

          {audit?.findings.length > 0 && (
            <div className="findings">
              {audit.findings.map((f, i) => (
                <div className="card finding" key={i}>
                  <div className="finding-top">
                    <span className="warn-badge">Price increase detected</span>
                    <strong className="pct">+{f.change_pct}%</strong>
                  </div>
                  <h3>{f.merchant}</h3>
                  <p className="price">{usd(f.old_amount)} → <strong>{usd(f.new_amount)}</strong>/month</p>
                  <div className="finding-foot">
                    <span>Detected {fmtDay(f.date)}</span><strong>+{usd(f.monthly_increase)} / month</strong>
                  </div>
                </div>
              ))}
            </div>
          )}

          {pa && (
            <div className="card approval">
              <div className="kicker">HUMAN-IN-THE-LOOP</div>
              <div className="card-head">
                <div>
                  <h2>{!decided ? "Action needs your approval" : pa.approved ? "Action approved (simulation)" : "Proposed action reviewed"}</h2>
                  <p className="sub">{pa.merchant} · Subscription change review</p>
                </div>
                <span className="pill">{decided ? "Decision recorded" : "Awaiting decision"}</span>
              </div>
              <div className="facts">
                <div><span>Price increase</span><strong>+{pa.change_pct}%</strong></div>
                <div><span>Annualized cost now</span><strong>{usd(pa.annual_cost)}</strong></div>
                <div><span>Monthly difference</span><strong>{usd(pa.monthly_increase)}</strong></div>
              </div>
              <div className="draft">
                <div className="draft-head"><span>CANCELLATION / DISPUTE DRAFT</span><span className="not-sent">NOT SENT</span></div>
                <pre>{pa.draft}</pre>
              </div>
              <div className="approval-foot">
                <span className="muted">
                  {!decided ? "Approving only records a local simulation. Nothing will be sent."
                    : pa.approved ? "Approved in simulation. No message was sent."
                    : "You rejected this proposal. Nothing was sent."}
                </span>
                {!decided && (
                  <div className="btn-row">
                    <button className="btn secondary" onClick={() => decide("reject")} disabled={busy.decide}>Reject</button>
                    <button className="btn primary" onClick={() => decide("approve")} disabled={busy.decide}>
                      {busy.decide && <Loader2 size={16} className="spin" />} Approve simulation
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <footer className="footer">
          <span>FINWISE · FINANCE INTELLIGENCE AGENT</span>
          <span>Built for learning · Not financial advice</span>
        </footer>
      </main>
    </div>
  );
}

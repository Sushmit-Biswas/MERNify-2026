import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { List } from 'react-window';
import {
  Activity,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Clock3,
  Flame,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Pause,
  Play,
  Radio,
  Search,
  SlidersHorizontal,
  Wind,
  X,
} from 'lucide-react';
import { ZONES, STATUS_NAMES, METRICS, REGION, compass, fdiBand } from '@emberwatch/shared';
import { api, readToken, saveToken } from './api.js';
import { telemetry, useTelemetry } from './store.js';
import { Chart } from './Chart.jsx';
const SensorMap = lazy(() => import('./SensorMap.jsx'));
import AlertList, { AlertDetails, age } from './AlertList.jsx';

const DEMOS = [
  { label: 'Administrator', email: 'admin@emberwatch.dev' },
  { label: 'Operations', email: 'ops@emberwatch.dev' },
  { label: 'North ranger', email: 'north@emberwatch.dev' },
  { label: 'East ranger', email: 'east@emberwatch.dev' },
  { label: 'South / West ranger', email: 'south@emberwatch.dev' },
];
const show = (n, digits = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : '—';

function Login({ onLogin }) {
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const signIn = async (address = email, secret = password) => {
    setBusy(true);
    setError('');
    try {
      const result = await api('/auth/login', {
        method: 'POST',
        body: { email: address, password: secret },
        token: null,
      });
      saveToken(result.token);
      onLogin(result.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="brand-lockup">
          <span className="brand-icon">
            <Flame size={25} fill="currentColor" />
          </span>
          <div>
            <h1>EmberWatch</h1>
            <p>Wildfire telemetry</p>
          </div>
        </div>
        <h2>Welcome back</h2>
        <p className="muted">Sign in to your monitoring workspace.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void signIn();
          }}
        >
          <label>
            Email
            <input
              autoComplete="username"
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
            <ChevronRight size={16} />
          </button>
        </form>
        <div className="demo-login">
          <span className="eyebrow">Explore the simulation</span>
          <div>
            {DEMOS.map((demo) => (
              <button
                key={demo.email}
                disabled={busy}
                onClick={() => void signIn(demo.email, 'ember-demo')}
              >
                {demo.label}
                <ChevronRight size={13} />
              </button>
            ))}
          </div>
          <p>Demo shortcuts use the default seeded accounts.</p>
        </div>
      </section>
    </main>
  );
}

function Modal({ children, label, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function useLive(user, zone, selected, windowMs, setSelected) {
  const view = useTelemetry(),
    socketRef = useRef(null),
    subscription = useRef(0),
    historyRequest = useRef(0),
    historyAbort = useRef(null),
    lastSnapshot = useRef(0);
  const [error, setError] = useState(''),
    [historyError, setHistoryError] = useState(''),
    [loading, setLoading] = useState(false);
  const allowed = useMemo(
    () => ZONES.filter((z) => user.role !== 'ranger' || user.zones.includes(z.id)).map((z) => z.id),
    [user],
  );
  const current = useRef({});
  current.current = { zones: zone === 'all' ? allowed : [zone], selected, windowMs, zone };
  const refreshHistory = useCallback(async () => {
    const { selected: id, windowMs: duration } = current.current;
    if (!id) return;
    const requestId = ++historyRequest.current;
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    setLoading(true);
    try {
      const from = Date.now() - duration;
      const result = await api(
        `/sensors/${encodeURIComponent(id)}/history?from=${from}&limit=10000`,
        { signal: controller.signal },
      );
      if (requestId === historyRequest.current && current.current.selected === id) {
        telemetry.setHistory(result);
        setHistoryError('');
      }
    } catch (err) {
      if (err.name !== 'AbortError' && requestId === historyRequest.current)
        setHistoryError(err.message);
    } finally {
      if (requestId === historyRequest.current) setLoading(false);
    }
  }, []);
  const subscribe = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket?.connected) return;
    const generation = ++subscription.current,
      { zones, selected: id } = current.current;
    telemetry.scope(zones, id);
    telemetry.beginAlertSnapshot();
    try {
      const result = await socket.timeout(7000).emitWithAck('subscribe', { zones, sensor: id });
      if (generation !== subscription.current) return;
      if (!result.ok) throw new Error(result.error);
      telemetry.setSnapshot(result.snapshot);
      telemetry.setAlertSnapshot(result.alerts);
      telemetry.flush();
      setError('');
      lastSnapshot.current = Date.now();
      if (!id) {
        const first = result.snapshot.devices.find((st) => st.type === 'sensor');
        if (first) setSelected(first.id);
      } else void refreshHistory();
    } catch (err) {
      if (generation === subscription.current) setError(err.message);
    }
  }, [refreshHistory, setSelected]);
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  useEffect(() => {
    telemetry.start();
    const socket = io('/live', {
      auth: { token: readToken() },
      autoConnect: false,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
    });
    socketRef.current = socket;
    socket.on('connect', () => {
      telemetry.status(true);
      void subscribeRef.current();
    });
    socket.on('disconnect', (reason) => {
      telemetry.status(false);
      if (reason === 'io server disconnect') window.dispatchEvent(new Event('session:expired'));
    });
    socket.on('connect_error', (err) => {
      telemetry.status(false);
      setError(err.message);
      if (err.message === 'unauthorized') window.dispatchEvent(new Event('session:expired'));
    });
    socket.on('f', (frame) => telemetry.frame(frame));
    socket.on('sensor', (value) => telemetry.sensor(value));
    socket.on('alert', (alert) => {
      telemetry.alert(alert);
      window.dispatchEvent(new CustomEvent('incident:received', { detail: alert }));
    });
    socket.on('metrics', (metrics) => telemetry.setMetrics(metrics));
    socket.on('heads', async (head) => {
      if (!current.current.zones.includes(head.zone)) return;
      for (const st of head.weather || []) {
        const old = telemetry.byIndex.get(st.idx);
        if (old && (st.seq > old.seq || (st.seq === old.seq && head.ts >= (old._at || 0))))
          telemetry.byIndex.set(st.idx, { ...old, ...st, _at: head.ts });
      }
      telemetry.touch();
      const behind =
        head.epoch !== telemetry.epoch ||
        head.rows.some(
          ([idx, seq, status]) =>
            !telemetry.byIndex.has(idx) ||
            telemetry.byIndex.get(idx).seq < seq ||
            telemetry.byIndex.get(idx).status !== status,
        );
      if (behind && Date.now() - lastSnapshot.current > 1500) {
        lastSnapshot.current = Date.now();
        const generation = subscription.current;
        try {
          const value = await api(`/snapshot?zone=${current.current.zone}`);
          if (generation === subscription.current) telemetry.setSnapshot(value);
        } catch (err) {
          setError(err.message);
        }
      }
    });
    let refreshAt = 0;
    socket.on('history:changed', ({ sid }) => {
      if (sid === current.current.selected && Date.now() - refreshAt > 2000) {
        refreshAt = Date.now();
        void refreshHistory();
      }
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && socket.connected) void refreshHistory();
    }, 5000);
    const visible = () => {
      if (document.visibilityState === 'visible') void subscribeRef.current();
    };
    document.addEventListener('visibilitychange', visible);
    socket.connect();
    return () => {
      clearInterval(timer);
      historyAbort.current?.abort();
      document.removeEventListener('visibilitychange', visible);
      socket.close();
      telemetry.stop();
      telemetry.status(false);
    };
  }, [user.id, refreshHistory]);
  useEffect(() => {
    void subscribe();
  }, [zone, selected, subscribe]);
  useEffect(() => {
    void refreshHistory();
  }, [windowMs, refreshHistory]);
  return { view, error, historyError, loading, refresh: subscribe, allowed };
}

function SummaryCard({ label, value, suffix, detail, points, color }) {
  return (
    <article className="summary-card">
      <div>
        <span>{label}</span>
        <strong style={color ? { color } : undefined}>
          {value}
          <small>{suffix}</small>
        </strong>
        <p>{detail}</p>
      </div>
      <div className="summary-spark">
        <Chart points={points} metric="value" compact height={65} color={color || '#22c55e'} />
      </div>
    </article>
  );
}

function SensorDetail({
  source,
  points,
  windowMs,
  onWindow,
  historyMode,
  historyTruncated,
  historyError,
  loading,
  onChoose,
  devices,
  paused,
  onPause,
}) {
  const [expanded, setExpanded] = useState(false);
  if (!source)
    return (
      <section className="panel detail-panel">
        <div className="panel-heading">
          <h2>Sensor detail</h2>
        </div>
        <div className="empty-state">
          <Radio size={24} />
          <strong>Select a source</strong>
          <p>Choose a sensor on the map or in Sources.</p>
        </div>
      </section>
    );
  const rows =
    source.type === 'station'
      ? [
          ['t', '#ef4444'],
          ['h', '#60a5fa'],
          ['ws', '#f59e0b'],
          ['wd', '#a1a1aa'],
        ]
      : [
          ['t', '#ef4444'],
          ['s', '#f97316'],
          ['h', '#60a5fa'],
          ['fdi', '#eab308'],
        ];
  return (
    <section className="panel detail-panel">
      <div className="panel-heading">
        <h2>{source.id}</h2>
        <span>Zone {ZONES.find((z) => z.id === source.zone)?.name}</span>
      </div>
      <div className="detail-toolbar">
        <select
          aria-label="Selected sensor"
          value={source.id}
          onChange={(e) => onChoose(e.target.value)}
        >
          {devices.map((d) => (
            <option value={d.id} key={d.id}>
              {d.id} · {d.site}
            </option>
          ))}
        </select>
        <select
          aria-label="History time range"
          value={windowMs}
          onChange={(e) => onWindow(Number(e.target.value))}
        >
          <option value={900000}>15 min</option>
          <option value={3600000}>1 hour</option>
          <option value={21600000}>6 hours</option>
          {source.type === 'sensor' && <option value={86400000}>24 hours</option>}
        </select>
        <button
          className={`icon-button ${paused ? 'active' : ''}`}
          aria-label={paused ? 'Resume chart' : 'Pause chart'}
          onClick={onPause}
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
        </button>
      </div>
      <div className="detail-meta">
        <span className={`status-text ${STATUS_NAMES[source.status]}`}>
          {STATUS_NAMES[source.status]}
        </span>
        <span>
          {paused
            ? 'Chart paused'
            : historyMode === 'rollup'
              ? '1-minute history · live reading'
              : 'Live + history'}
        </span>
      </div>
      {historyError && (
        <p className="inline-error" role="alert">
          {historyError}
        </p>
      )}
      {loading && !points.length && <p className="detail-hint">Loading available history…</p>}
      {historyTruncated && <p className="detail-hint">Latest 10,000 readings shown</p>}
      {(expanded ? rows : rows.slice(0, 2)).map(([key, color]) => (
        <div className="metric-chart" key={key}>
          <div>
            <span>{key === 'fdi' ? 'Fire danger index' : METRICS[key].label}</span>
            <strong style={{ color }}>
              {show(key === 'fdi' ? source.fdi : source[key], key === 't' ? 1 : 0)}
              <small>{key === 'fdi' ? ' / 100' : ` ${METRICS[key].unit}`}</small>
            </strong>
          </div>
          <Chart
            points={points}
            metric={key}
            color={color}
            height={105}
            label={`${source.id} ${key === 'fdi' ? 'composite fire danger index' : METRICS[key].label}`}
          />
        </div>
      ))}
      <button className="detail-expand" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Fewer metrics' : 'More metrics'}
      </button>
      <div className="source-footer">
        <span>
          {source.type === 'station' ? 'Weather station' : 'Mesh sensor'} · {source.site}
        </span>
        <span>
          Battery {show(source.b)}% · {source.ts ? `${age(source.ts)} ago` : 'No readings yet'}
        </span>
      </div>
    </section>
  );
}

function SourceRow({ index, style, ariaAttributes, devices, onSelect }) {
  const st = devices[index];
  return (
    <div {...ariaAttributes} style={style}>
      <button className="source-row" onClick={() => onSelect(st.id)}>
        <span>
          <strong>{st.id}</strong>
          <small>{st.site}</small>
        </span>
        <span>{st.zone}</span>
        <span>{show(st.t, 1)} °C</span>
        <span>{show(st.h)}%</span>
        <span className={`status-text ${STATUS_NAMES[st.status]}`}>{STATUS_NAMES[st.status]}</span>
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

function Sources({ devices, onSelect }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () =>
      devices.filter((st) =>
        `${st.id} ${st.site} ${st.type}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [devices, query],
  );
  return (
    <section className="panel sources-panel">
      <div className="panel-heading">
        <h2>
          Sources <small>{filtered.length}</small>
        </h2>
        <label className="search-field">
          <Search size={15} />
          <input
            aria-label="Search sources"
            placeholder="Find a source"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <div className="source-table-heading">
        <span>Source</span>
        <span>Zone</span>
        <span>Temperature</span>
        <span>Humidity</span>
        <span>Status</span>
        <span />
      </div>
      {filtered.length ? (
        <List
          rowComponent={SourceRow}
          rowCount={filtered.length}
          rowHeight={66}
          rowProps={{ devices: filtered, onSelect }}
          overscanCount={5}
          style={{ height: 'min(68vh, 740px)', minHeight: 260 }}
        />
      ) : (
        <div className="empty-state">No matching sources.</div>
      )}
    </section>
  );
}

function MetricsPage({ value }) {
  if (!value)
    return (
      <section className="panel empty-state">
        <Activity size={25} />
        <strong>Waiting for metrics</strong>
        <p>Operational measurements update once per second.</p>
      </section>
    );
  const entries = [
    ['Accepted', value.rates.accepted, 'events/s'],
    ['Written', value.totals.written, 'records'],
    ['Duplicate', value.totals.duplicate, 'events'],
    ['Out of order', value.totals.outOfOrder, 'events'],
    ['Rejected', value.totals.rejected, 'events'],
    ['Rate limited', value.totals.rateLimited, 'events'],
    ['Queue depth', value.queueDepth, 'records'],
    ['Viewers', value.clients, 'clients'],
    ['Write p95', value.writeMs.p95, 'ms'],
    ['Processing lag p95', value.e2eMs.p95, 'ms'],
    ['Event-loop p99', value.loopLagMs.p99, 'ms'],
    ['Memory', value.rssMb, 'MB'],
  ];
  const series = value.series.accepted.map((n, i, a) => ({
    ts: Date.now() - (a.length - i) * 1000,
    value: n,
  }));
  return (
    <div className="metrics-page">
      <section className="panel">
        <div className="panel-heading">
          <h2>Ingestion rate</h2>
          <span>Last 60 seconds</span>
        </div>
        <div className="large-chart">
          <Chart
            points={series}
            metric="value"
            color="#22c55e"
            height={240}
            label="Accepted events per second"
          />
        </div>
      </section>
      <div className="metric-grid">
        {entries.map(([label, value, unit]) => (
          <article className="panel metric-number" key={label}>
            <span>{label}</span>
            <strong>
              {show(value, Number.isInteger(value) ? 0 : 1)}
              <small>{unit}</small>
            </strong>
          </article>
        ))}
      </div>
      <p className="footnote">
        Processing lag measures source timestamp to the broadcast tick, before transport queuing.
        Ingest acknowledgement means queued acceptance; Written counts database inserts.
      </p>
    </div>
  );
}

function HistoryPage({ zones }) {
  const [zone, setZone] = useState(zones[0] || ''),
    [points, setPoints] = useState([]),
    [at, setAt] = useState(null),
    [follow, setFollow] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (!zone) return;
      try {
        const data = await api(`/zones/${zone}/history?from=${Date.now() - 86400000}`, {
          signal: controller.signal,
        });
        setPoints(data.points);
        setError('');
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    };
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [zone]);
  const index = follow
    ? points.length - 1
    : Math.max(
        0,
        points.findLastIndex((p) => p.ts <= at),
      );
  const selected = points[index];
  return (
    <section className="panel replay-panel">
      <div className="panel-heading">
        <h2>Zone history</h2>
        <div className="row">
          <select
            aria-label="Replay zone"
            value={zone}
            onChange={(e) => {
              setZone(e.target.value);
              setPoints([]);
              setFollow(true);
            }}
          >
            {zones.map((id) => (
              <option key={id} value={id}>
                Zone {ZONES.find((z) => z.id === id)?.name}
              </option>
            ))}
          </select>
          <button className={`button ${follow ? 'active' : ''}`} onClick={() => setFollow(!follow)}>
            {follow ? <Pause size={14} /> : <Play size={14} />}
            {follow ? 'Follow live' : 'Resume live'}
          </button>
        </div>
      </div>
      {error && <p className="inline-error">{error}</p>}
      {points.length ? (
        <div className="replay-content">
          <div className="replay-readings">
            <div>
              <span>Time</span>
              <strong>{selected ? new Date(selected.ts).toLocaleTimeString() : '—'}</strong>
            </div>
            <div>
              <span>Mean temperature</span>
              <strong>{show(selected?.t, 1)} °C</strong>
            </div>
            <div>
              <span>Peak smoke</span>
              <strong>{show(selected?.sMax)} ppm</strong>
            </div>
            <div>
              <span>Peak danger index</span>
              <strong>{show(selected?.fdi)}</strong>
            </div>
          </div>
          <Chart
            points={points.filter((p) => !selected || p.ts <= selected.ts)}
            metric="t"
            color="#f97316"
            height={270}
            label="Zone mean temperature history"
          />
          <label className="replay-slider">
            History scrubber
            <input
              type="range"
              min={0}
              max={Math.max(0, points.length - 1)}
              value={Math.max(0, index)}
              onChange={(e) => {
                setFollow(false);
                setAt(points[Number(e.target.value)].ts);
              }}
            />
          </label>
          <p className="footnote">
            Available 1-minute aggregates within 24-hour retention. Live mode refreshes as telemetry
            is persisted.
          </p>
        </div>
      ) : (
        <div className="empty-state">
          <Clock3 size={26} />
          <strong>No retained history yet</strong>
          <p>Aggregates appear after readings have been written.</p>
        </div>
      )}
    </section>
  );
}

function SimulatorControls({ onClose, onIgnite, onMessage }) {
  const [status, setStatus] = useState(null),
    [connected, setConnected] = useState(false),
    [dir, setDir] = useState(292),
    [speed, setSpeed] = useState(22),
    [rate, setRate] = useState(2),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const initialized = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const result = await api('/sim/status', { signal: controller.signal });
        setConnected(result.connected);
        setStatus(result.status);
        if (!initialized.current && result.status) {
          setDir(result.status.wind.dir);
          setSpeed(result.status.wind.speed);
          setRate(result.status.hz);
          initialized.current = true;
        }
      } catch (err) {
        if (err.name !== 'AbortError') setError(err.message);
      }
    };
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  const command = async (body) => {
    setBusy(true);
    setError('');
    try {
      await api('/control', { method: 'POST', body });
      onMessage('Command sent to the simulator');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="dialog-card">
      <div className="panel-heading">
        <h2>Simulator controls</h2>
        <button className="icon-button" aria-label="Close simulator controls" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="dialog-content">
        <p className="control-status">
          <span className={`connection-dot ${connected ? 'online' : ''}`} />
          {connected
            ? `${status?.burningCells ?? 0} burning cells · ${status?.areaHa ?? 0} ha simulated`
            : 'Simulator is not connected'}
        </p>
        {error && <p className="error-message">{error}</p>}
        <div className="control-buttons">
          <button
            className="button primary"
            disabled={!connected}
            onClick={() => {
              onIgnite();
              onClose();
            }}
          >
            <Flame size={16} />
            Ignite on map
          </button>
          <button
            className="button"
            disabled={busy || !connected}
            onClick={() => void command({ cmd: 'extinguish' })}
          >
            Extinguish
          </button>
        </div>
        <div className="control-group">
          <h3>Wind</h3>
          <label>
            From {compass(dir)} · {dir}°
            <input
              type="range"
              min="0"
              max="360"
              value={dir}
              onChange={(e) => setDir(Number(e.target.value))}
            />
          </label>
          <label>
            Speed · {speed} km/h
            <input
              type="range"
              min="0"
              max="100"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
          <button
            className="button"
            disabled={busy || !connected}
            onClick={() => void command({ cmd: 'wind', dir, speed })}
          >
            Apply wind
          </button>
        </div>
        <div className="control-group">
          <h3>Sampling rate</h3>
          <label>
            Target · {rate} Hz
            <input
              type="range"
              min="0.2"
              max="20"
              step="0.2"
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </label>
          <button
            className="button"
            disabled={busy || !connected}
            onClick={() => void command({ cmd: 'rate', hz: rate })}
          >
            Apply rate
          </button>
          <p className="footnote">
            Rates above the configured source limit demonstrate backpressure.
          </p>
        </div>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={status?.chaos || false}
            disabled={busy || !connected}
            onChange={(e) => void command({ cmd: 'chaos', on: e.target.checked })}
          />
          Chaos mode <small>Duplicates, reordered batches, and link interruptions</small>
        </label>
      </div>
    </section>
  );
}

function Console({ user, onLogout }) {
  const [zone, setZone] = useState('all'),
    [selected, setSelected] = useState(null),
    [page, setPage] = useState('overview'),
    [windowMs, setWindow] = useState(900000),
    [paused, setPaused] = useState(false),
    [frozen, setFrozen] = useState([]),
    [controls, setControls] = useState(false),
    [ignite, setIgnite] = useState(false),
    [heat, setHeat] = useState(true),
    [alertDetail, setAlertDetail] = useState(null),
    [message, setMessage] = useState(''),
    [ackBusy, setAckBusy] = useState(null),
    [sound, setSound] = useState(false),
    [alertState, setAlertState] = useState('active');
  const { view, error, historyError, loading, allowed } = useLive(
    user,
    zone,
    selected,
    windowMs,
    setSelected,
  );
  const trends = useRef([]),
    soundRef = useRef(false),
    audio = useRef(null);
  soundRef.current = sound;
  const devices = view.devices,
    sensors = devices.filter((st) => st.type === 'sensor'),
    online = sensors.filter((st) => st.status !== 3),
    active = view.alerts.filter((a) => a.state !== 'resolved');
  const humidityValues = online.filter((st) => Number.isFinite(st.h)),
    dangerValues = online.filter((st) => Number.isFinite(st.fdi));
  const humidity = humidityValues.length
    ? humidityValues.reduce((sum, st) => sum + st.h, 0) / humidityValues.length
    : null;
  const danger = dangerValues.length
    ? dangerValues.reduce((sum, st) => sum + st.fdi, 0) / dangerValues.length
    : null;
  const source = devices.find((st) => st.id === selected);
  const station = devices.find((st) => st.type === 'station' && st.ws !== null);
  if (!trends.current.length || Date.now() - trends.current.at(-1).ts > 1000) {
    trends.current.push({
      ts: Date.now(),
      online: online.length,
      alerts: active.length,
      fdi: danger,
      humidity,
    });
    if (trends.current.length > 60) trends.current.shift();
  }
  const trend = (key) => trends.current.map((p) => ({ ts: p.ts, value: p[key] }));
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4500);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    const heard = new Set();
    const onIncident = (event) => {
      const alert = event.detail;
      if (
        alert.severity !== 'critical' ||
        alert.state === 'resolved' ||
        heard.has(String(alert._id))
      )
        return;
      heard.add(String(alert._id));
      if (heard.size > 500) heard.delete(heard.values().next().value);
      setMessage(`Critical incident · ${alert.sid}`);
      if (soundRef.current && audio.current) {
        const ctx = audio.current,
          oscillator = ctx.createOscillator(),
          gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.frequency.value = 620;
        gain.gain.setValueAtTime(0.07, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        oscillator.start();
        oscillator.stop(ctx.currentTime + 0.35);
      }
    };
    window.addEventListener('incident:received', onIncident);
    return () => {
      window.removeEventListener('incident:received', onIncident);
      audio.current?.close();
    };
  }, []);
  const select = useCallback((id) => {
    setSelected(id);
    setPaused(false);
    setFrozen([]);
    if ([...telemetry.byIndex.values()].some((d) => d.id === id && d.type === 'station'))
      setWindow((value) => Math.min(value, 21600000));
  }, []);
  const chooseZone = useCallback(
    (id) => {
      setZone(id);
      select(null);
      trends.current = [];
    },
    [select],
  );
  const acknowledge = useCallback(async (alert) => {
    setAckBusy(String(alert._id));
    try {
      const result = await api(`/alerts/${alert._id}/ack`, { method: 'POST' });
      telemetry.alert(result.alert);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setAckBusy(null);
    }
  }, []);
  const loadAlerts = async (state) => {
    setAlertState(state);
    try {
      const result = await api(`/alerts?zone=${zone}&state=${state}`);
      for (const a of result.alerts) telemetry.alert(a);
    } catch (err) {
      setMessage(err.message);
    }
  };
  const igniteAt = async ({ lat, lng }) => {
    if (lat < REGION.south || lat > REGION.north || lng < REGION.west || lng > REGION.east)
      return setMessage('Choose a point inside the monitored forest');
    try {
      await api('/control', { method: 'POST', body: { cmd: 'ignite', lat, lng } });
      setIgnite(false);
      setMessage('Ignition command sent');
    } catch (err) {
      setMessage(err.message);
    }
  };
  const nav = [
    ['overview', LayoutDashboard, 'Overview'],
    ['map', MapIcon, 'Map'],
    ['sources', Radio, 'Sources'],
    ['alerts', Bell, 'Alerts'],
    ...(user.role !== 'ranger' ? [['metrics', Activity, 'Metrics']] : []),
    ['history', Clock3, 'History'],
  ];
  const pageAlerts = view.alerts.filter(
    (a) =>
      alertState === 'all' ||
      (alertState === 'active' ? a.state !== 'resolved' : a.state === alertState),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-icon" aria-label="EmberWatch">
          <Flame size={23} fill="currentColor" />
        </div>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button
              key={id}
              className={`nav-icon ${page === id ? 'selected' : ''}`}
              aria-label={label}
              title={label}
              onClick={() => setPage(id)}
            >
              <Icon size={21} />
            </button>
          ))}
        </nav>
        <button
          className="nav-icon logout"
          aria-label="Sign out"
          title="Sign out"
          onClick={onLogout}
        >
          <LogOut size={20} />
        </button>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <h1>{nav.find(([id]) => id === page)?.[2] || 'Overview'}</h1>
          <div className="zone-tabs" aria-label="Zone filter">
            {allowed.length > 1 && (
              <button
                className={zone === 'all' ? 'selected' : ''}
                onClick={() => chooseZone('all')}
              >
                All zones
              </button>
            )}
            {allowed.map((id) => (
              <button
                key={id}
                className={zone === id || allowed.length === 1 ? 'selected' : ''}
                onClick={() => chooseZone(id)}
              >
                {ZONES.find((z) => z.id === id)?.name}
              </button>
            ))}
          </div>
          <div className="top-status">
            <span className="simulation-label">SIMULATION</span>
            <span className={`connection-dot ${view.connected ? 'online' : ''}`} />
            <span>{view.connected ? 'LIVE' : 'RECONNECTING'}</span>
            {view.metrics && (
              <span title="Accepted events per second · source-to-broadcast-tick p95 (before transport queue)">
                · {show(view.metrics.rates.accepted)} ev/s · {show(view.metrics.e2eMs.p95)} ms
              </span>
            )}
          </div>
          <button
            className="icon-button sound-toggle"
            aria-label={sound ? 'Mute critical alerts' : 'Enable critical alert sound'}
            onClick={() => {
              if (!sound) {
                const Audio = window.AudioContext || window.webkitAudioContext;
                if (Audio) {
                  audio.current ||= new Audio();
                  void audio.current.resume();
                }
              }
              setSound(!sound);
            }}
          >
            {sound ? <Bell size={16} /> : <BellOff size={16} />}
          </button>
          {user.role === 'admin' && (
            <button
              className="quick-ignite-btn"
              onClick={() => {
                setPage('overview');
                setIgnite(true);
              }}
              title="Click on the sensor map to ignite a test wildfire"
            >
              <Flame size={14} fill="currentColor" />
              <span>Ignite Fire</span>
            </button>
          )}
          {user.role === 'admin' && (
            <button
              className="icon-button"
              aria-label="Simulator controls"
              title="Simulator controls"
              onClick={() => setControls(true)}
            >
              <SlidersHorizontal size={18} />
            </button>
          )}
          <span className="avatar" title={`${user.name} · ${user.role}`}>
            {user.name
              .split(' ')
              .map((s) => s[0])
              .slice(0, 2)
              .join('')}
          </span>
        </header>
        {error && (
          <div className="connection-banner" role="status">
            {error}
            <span>Reconnecting and recovering the latest state.</span>
          </div>
        )}
        {ignite && (
          <div className="ignite-banner">
            <Flame size={15} />
            Ignition mode<button onClick={() => setIgnite(false)}>Cancel</button>
          </div>
        )}
        <main className="main-content">
          {['overview', 'map'].includes(page) && (
            <>
              <div className="summary-grid">
                <SummaryCard
                  label="Sensors online"
                  value={show(online.length)}
                  suffix={` / ${sensors.length}`}
                  detail={`${sensors.length - online.length} offline`}
                  points={trend('online')}
                />
                <SummaryCard
                  label="Active alerts"
                  value={active.length >= 250 ? '≥250' : show(active.length)}
                  detail={active.length ? 'Attention required' : 'No active incidents'}
                  points={trend('alerts')}
                  color="#ef4444"
                />
                <SummaryCard
                  label="Fire danger index"
                  value={show(danger)}
                  detail={
                    danger === null ? 'Awaiting readings' : `${fdiBand(danger)} · composite index`
                  }
                  points={trend('fdi')}
                  color="#f97316"
                />
                <SummaryCard
                  label="Avg humidity"
                  value={show(humidity)}
                  suffix="%"
                  detail={
                    humidity === null
                      ? 'Awaiting readings'
                      : `${humidityValues.length} reporting sensors`
                  }
                  points={trend('humidity')}
                  color="#a1a1aa"
                />
              </div>
              <div className={`console-grid ${page === 'map' ? 'map-focused' : ''}`}>
                <section className="panel map-panel">
                  <div className="panel-heading">
                    <h2>Sensor mesh</h2>
                    <div className="map-tools">
                      {station && (
                        <span className="wind-label">
                          <Wind size={14} />
                          {show(station.ws)} km/h from {compass(station.wd ?? 0)}
                        </span>
                      )}
                      <button
                        className={`text-button ${heat ? 'enabled' : ''}`}
                        onClick={() => setHeat(!heat)}
                      >
                        Heat {heat ? 'on' : 'off'}
                      </button>
                    </div>
                  </div>
                  <Suspense fallback={<div className="empty-state">Loading map…</div>}>
                    <SensorMap
                      devices={devices}
                      alerts={active}
                      selected={selected}
                      zone={zone === 'all' && allowed.length === 1 ? allowed[0] : zone}
                      onSelect={select}
                      igniteMode={ignite}
                      onIgnite={igniteAt}
                      heat={heat}
                    />
                  </Suspense>
                </section>
                <aside className="right-rail">
                  {page !== 'map' && (
                    <section className="panel alerts-panel">
                      <div className="panel-heading">
                        <h2>Alerts</h2>
                        <span>
                          {active.length >= 250 ? '250+ shown' : `${active.length} active`}
                        </span>
                      </div>
                      <AlertList
                        alerts={active}
                        onSelect={(a) => {
                          select(a.sid);
                          setAlertDetail(a);
                        }}
                        onAcknowledge={acknowledge}
                        busy={ackBusy}
                        height={330}
                      />
                    </section>
                  )}
                  <SensorDetail
                    source={source}
                    points={paused ? frozen : view.points}
                    windowMs={windowMs}
                    onWindow={(value) => {
                      setWindow(value);
                      setPaused(false);
                      setFrozen([]);
                    }}
                    historyMode={view.historyMode}
                    historyTruncated={view.historyTruncated}
                    historyError={historyError}
                    loading={loading}
                    onChoose={select}
                    devices={devices}
                    paused={paused}
                    onPause={() => {
                      if (!paused) setFrozen([...view.points]);
                      setPaused(!paused);
                    }}
                  />
                </aside>
              </div>
            </>
          )}
          {page === 'sources' && (
            <Sources
              devices={devices}
              onSelect={(id) => {
                select(id);
                setPage('overview');
              }}
            />
          )}
          {page === 'alerts' && (
            <section className="panel alerts-page">
              <div className="panel-heading">
                <h2>Incidents</h2>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <select
                    aria-label="Incident state"
                    value={alertState}
                    onChange={(e) => void loadAlerts(e.target.value)}
                  >
                    <option value="active">Active</option>
                    <option value="ack">Acknowledged</option>
                    <option value="resolved">Resolved</option>
                    <option value="all">All recent</option>
                  </select>
                  <button
                    className="export-incidents-btn"
                    onClick={() => {
                      const data = JSON.stringify(pageAlerts, null, 2);
                      const blob = new Blob([data], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `emberwatch-incidents-${Date.now()}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    title="Export incident audit log to JSON"
                  >
                    Export Log
                  </button>
                </div>
              </div>
              <AlertList
                alerts={pageAlerts}
                onSelect={setAlertDetail}
                onAcknowledge={acknowledge}
                busy={ackBusy}
                height={560}
              />
            </section>
          )}
          {page === 'metrics' && user.role !== 'ranger' && <MetricsPage value={view.metrics} />}
          {page === 'history' && (
            <HistoryPage key={zone} zones={zone === 'all' ? allowed : [zone]} />
          )}
        </main>
      </div>
      {message && (
        <div className="toast" role="status">
          {message}
          <button aria-label="Dismiss message" onClick={() => setMessage('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {controls && (
        <Modal label="Simulator controls" onClose={() => setControls(false)}>
          <SimulatorControls
            onClose={() => setControls(false)}
            onIgnite={() => {
              setPage('overview');
              setIgnite(true);
            }}
            onMessage={setMessage}
          />
        </Modal>
      )}
      {alertDetail && (
        <Modal label="Incident details" onClose={() => setAlertDetail(null)}>
          <AlertDetails
            alert={
              view.alerts.find((a) => String(a._id) === String(alertDetail._id)) || alertDetail
            }
            onClose={() => setAlertDetail(null)}
            onSelectSource={(id) => {
              select(id);
              setPage('overview');
              setAlertDetail(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null),
    [checking, setChecking] = useState(Boolean(readToken()));
  const logout = useCallback(() => {
    saveToken(null);
    telemetry.byIndex.clear();
    telemetry.alerts.clear();
    telemetry.detail.clear();
    telemetry.metrics = null;
    telemetry.epoch = null;
    telemetry.touch();
    telemetry.flush();
    setUser(null);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    if (readToken())
      api('/auth/me', { signal: controller.signal })
        .then(({ user }) => setUser(user))
        .catch((err) => {
          if (err.name !== 'AbortError') logout();
        })
        .finally(() => {
          if (!controller.signal.aborted) setChecking(false);
        });
    const expired = () => logout();
    window.addEventListener('session:expired', expired);
    return () => {
      controller.abort();
      window.removeEventListener('session:expired', expired);
    };
  }, [logout]);
  if (checking)
    return (
      <main className="login-screen">
        <div className="loading-brand">
          <Flame size={25} />
          <span>Opening EmberWatch…</span>
        </div>
      </main>
    );
  return user ? <Console user={user} onLogout={logout} /> : <Login onLogin={setUser} />;
}

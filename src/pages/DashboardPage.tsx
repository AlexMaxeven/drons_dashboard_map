import { useMemo, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Link, useNavigate } from 'react-router-dom';

import type { DemoFleetUpdate } from '../demo/realtime/demoFleet.worker';
import { useFleet } from '../fleet/FleetContext';

function kindLabel(kind: string) {
  if (kind === 'fpv') return 'FPV';
  if (kind === 'bomber') return 'Bomber';
  if (kind === 'fixedWing') return 'drone_type_1';
  return 'drone_type_2';
}

function statusLabel(state: string, missingReason: string | null) {
  if (state !== 'missing') return 'Active';
  if (missingReason === 'destroyed') return 'Destroyed';
  return 'Missing';
}

function formatFlightTimeMin(min: number) {
  if (!Number.isFinite(min)) return '—';
  if (min <= 0) return '<1 min';
  return `${min.toLocaleString()} min`;
}

export function DashboardPage() {
  const nav = useNavigate();
  const { updates, eventsPerSecond, lastTickTs, selectedId, setSelectedId } = useFleet();

  const [kindFilter, setKindFilter] = useState<'all' | DemoFleetUpdate['kind']>('all');
  const [regionFilter, setRegionFilter] = useState<string>('all');
  const [helpOpen, setHelpOpen] = useState<string | null>('dash');

  const regions = useMemo(() => {
    const set = new Set<string>();
    for (const u of updates) {
      if (u.region) set.add(u.region);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [updates]);

  const list = useMemo(() => {
    return updates.filter((u) => {
      if (kindFilter !== 'all' && u.kind !== kindFilter) return false;
      if (regionFilter !== 'all' && u.region !== regionFilter) return false;
      return true;
    });
  }, [updates, kindFilter, regionFilter]);

  return (
    <div className="row g-3">
      <div className="col-12 col-lg-4">
        <div className="card">
          <div className="card-body">
            <div className="d-flex align-items-center justify-content-between gap-2">
              <h5 className="card-title mb-0">Fleet overview</h5>
              <span className="badge text-bg-secondary">Demo mode</span>
            </div>
            <div className="mt-3 small text-muted">
              Events/sec: <span className="fw-semibold text-body">{eventsPerSecond.toLocaleString()}</span>
            </div>
            <div className="small text-muted">
              Last tick:{' '}
              <span className="fw-semibold text-body">{lastTickTs ? new Date(lastTickTs).toLocaleTimeString() : '—'}</span>
            </div>
          </div>
        </div>

        <div className="card mt-3 border-0 shadow-sm">
          <div className="card-body">
            <h5 className="card-title mb-3">Як користуватись</h5>
            <div className="accordion" id="dashboard-help-accordion">
              {[
                {
                  id: 'dash',
                  title: 'Dashboard (ця сторінка)',
                  body: (
                    <ul className="small mb-0 ps-3">
                      <li>
                        <b>Клік по рядку</b> у списку — перехід на <Link to="/map">Map</Link> і цей дрон уже{' '}
                        <b>виділений</b> (попап відкриється на карті).
                      </li>
                      <li>
                        Фільтри <b>Тип</b> та <b>Регіон</b> звужують список; лічильник «visible» показує скільки рядків
                        зараз у віртуалізованому списку.
                      </li>
                      <li>Дані спільні з картою через один контекст симуляції (живий стрім оновлень).</li>
                    </ul>
                  ),
                },
                {
                  id: 'map',
                  title: 'Карта (Map)',
                  body: (
                    <ul className="small mb-0 ps-3">
                      <li>
                        <b>Клік по точці</b> на мапі — попап з деталями; можна ввімкнути <b>Follow selected</b> у бічній
                        панелі.
                      </li>
                      <li>
                        <b>Маршрут</b> у попапі або в панелі — жовта лінія, якщо для дрона є синтетичний трек (демо
                        ~40% після Start/Apply). Якщо кнопка неактивна — наведи курсор для короткої підказки.
                      </li>
                      <li>
                        <b>Start / Apply</b>: зміна кількості дронів або ticks часто потребує <b>Apply</b>, потім{' '}
                        <b>Start</b> — див. підказки на самій сторінці Map.
                      </li>
                      <li>Легенда з чекбоксами ховає типи з карти та з оновлень списку.</li>
                    </ul>
                  ),
                },
                {
                  id: 'reports',
                  title: 'Звіти (Reports)',
                  body: (
                    <p className="small mb-0">
                      Генерація файлу <code>.xlsx</code> на клієнті (тестові рядки, аркуш-підсумок). Відкрий вкладку{' '}
                      <Link to="/reports">Reports</Link>.
                    </p>
                  ),
                },
                {
                  id: 'ai',
                  title: 'Про створення коду',
                  body: (
                    <p className="small mb-0">
                      <b>Значну частину</b> цього репозиторію (компоненти, воркер симуляції, карта, звіти, тексти UI)
                      згенеровано та відредаговано з допомогою <b>ШІ</b> (великі мовні моделі в середовищі на кшталт{' '}
                      <i>Cursor</i>), з подальшою перевіркою, зборкою та правками людини. Це навмисний демо-проєкт, а не
                      production-система.
                    </p>
                  ),
                },
              ].map((item) => {
                const open = helpOpen === item.id;
                return (
                  <div key={item.id} className="accordion-item">
                    <h2 className="accordion-header" id={`heading-${item.id}`}>
                      <button
                        type="button"
                        className={`accordion-button rounded-0 ${open ? '' : 'collapsed'} shadow-none`}
                        aria-expanded={open}
                        aria-controls={`collapse-${item.id}`}
                        onClick={() => setHelpOpen((prev) => (prev === item.id ? null : item.id))}
                      >
                        {item.title}
                      </button>
                    </h2>
                    <div
                      id={`collapse-${item.id}`}
                      className={`accordion-collapse collapse ${open ? 'show' : ''}`}
                      role="region"
                      aria-labelledby={`heading-${item.id}`}
                    >
                      <div className="accordion-body pt-0 small text-body-secondary">{item.body}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="card mt-3">
          <div className="card-body">
            <h5 className="card-title">Що демонструє проєкт</h5>
            <ul className="mb-0">
              <li>SPA + маршрутизація (Dashboard, Map, Reports)</li>
              <li>Спільний стан флоту: Web Worker + React Context (один симулятор на сесію)</li>
              <li>Продуктивність: віртуалізований список (react-virtuoso), RAF для мапи</li>
              <li>MapLibre: точки, попап, шар маршруту, стилі карти</li>
              <li>Експорт XLSX (ExcelJS) на клієнті</li>
              <li>Частина коду створена з допомогою ШІ — див. акордеон «Про створення коду»</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="col-12 col-lg-8">
        <div className="card">
          <div className="card-body">
            <div className="d-flex align-items-center justify-content-between gap-2 flex-wrap">
              <h5 className="card-title mb-0">Fleet (live, virtualized)</h5>
              <span className="text-muted small">{list.length.toLocaleString()} visible</span>
            </div>

            <div className="row g-2 mt-2">
              <div className="col-12 col-md-6">
                <label className="form-label small mb-1">Type</label>
                <select
                  className="form-select form-select-sm"
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value as 'all' | DemoFleetUpdate['kind'])}
                >
                  <option value="all">All</option>
                  <option value="fpv">FPV</option>
                  <option value="bomber">Bomber</option>
                  <option value="fixedWing">drone_type_1</option>
                  <option value="mavic">drone_type_2</option>
                </select>
              </div>
              <div className="col-12 col-md-6">
                <label className="form-label small mb-1">Region</label>
                <select className="form-select form-select-sm" value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
                  <option value="all">All</option>
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ height: 520 }}>
              <Virtuoso
                data={list}
                itemContent={(_index, v) => (
                  <button
                    type="button"
                    className={`w-100 text-start border-0 bg-transparent px-0`}
                    onClick={() => {
                      setSelectedId(v.id);
                      nav('/map');
                    }}
                  >
                    <div
                      className={`d-flex align-items-center justify-content-between py-2 border-bottom ${
                        selectedId === v.id ? 'bg-primary-subtle' : ''
                      }`}
                    >
                    <div className="d-flex flex-column">
                      <span className="fw-semibold">{v.id}</span>
                      <span className="text-muted small">
                        {v.region ?? '—'} · Flight {formatFlightTimeMin(v.flightMin)} ·{' '}
                        {(v.routePolyline?.length ?? 0) >= 2 ? 'Маршрут: є' : 'Маршрут: потрібні дані'}
                      </span>
                    </div>
                    <div className="d-flex align-items-center gap-2">
                      <span
                        className={
                          v.state === 'missing'
                            ? 'badge text-bg-secondary'
                            : 'badge text-bg-success'
                        }
                      >
                        {statusLabel(v.state, v.missingReason)}
                      </span>
                      <span
                        className={
                          v.kind === 'fpv'
                            ? 'badge text-bg-danger'
                            : v.kind === 'bomber'
                              ? 'badge text-bg-warning'
                              : v.kind === 'fixedWing'
                                ? 'badge text-bg-primary'
                                : 'badge text-bg-success'
                        }
                      >
                        {kindLabel(v.kind)}
                      </span>
                    </div>
                  </div>
                  </button>
                )}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


import ExcelJS from 'exceljs';

type DroneKind = 'fpv' | 'bomber' | 'fixedWing' | 'mavic';

type DroneRow = {
  name: string;
  kind: DroneKind;
  avgSpeedKmh: number;
  enduranceMin: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function makeDemoFleet(count: number): DroneRow[] {
  const kinds: DroneKind[] = ['fpv', 'bomber', 'fixedWing', 'mavic'];
  const rows: DroneRow[] = [];

  for (let i = 0; i < count; i++) {
    const r = Math.random();
    const kind: DroneKind = r < 0.28 ? 'mavic' : r < 0.52 ? 'fixedWing' : r < 0.78 ? 'fpv' : 'bomber';

    // Rough "realistic-ish" demo ranges (km/h and minutes).
    const enduranceMin =
      kind === 'fpv' ? 25 + Math.round(Math.random() * 10) : kind === 'bomber'
        ? 30 + Math.round(Math.random() * 12) : kind === 'fixedWing'
          ? 180 + Math.round(Math.random() * 180) : 45 + Math.round(Math.random() * 30);

    const avgSpeedKmh =
      kind === 'fpv'
        ? clamp(randomBetween(65, 125) + randomBetween(-8, 8), 45, 140)
        : kind === 'bomber'
          ? clamp(randomBetween(75, 145) + randomBetween(-10, 10), 55, 165)
          : kind === 'fixedWing'
            ? clamp(randomBetween(70, 155) + randomBetween(-8, 8), 55, 175)
            : clamp(randomBetween(18, 55) + randomBetween(-6, 6), 0, 70);

    rows.push({
      name: `Drone ${String(i + 1).padStart(3, '0')}`,
      kind,
      avgSpeedKmh: Number(avgSpeedKmh.toFixed(1)),
      enduranceMin,
    });
  }

  // Make it stable-ish: sort by kind then name (nice for reading).
  rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
  return rows;
}

async function downloadDemoXlsx() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Fleet');
  const summary = workbook.addWorksheet('Summary');

  const fleet = makeDemoFleet(200);

  sheet.columns = [
    { header: 'Name', key: 'name', width: 18 },
    { header: 'Type', key: 'kind', width: 12 },
    { header: 'Avg speed (km/h)', key: 'avgSpeedKmh', width: 18 },
    { header: 'Endurance (min)', key: 'enduranceMin', width: 16 },
    { header: 'Estimated range (km)', key: 'efficiency', width: 20 },
  ];

  // Rows + per-row efficiency formula:
  // Estimated range (km) = AvgSpeed * EnduranceHours (approx distance possible).
  // (This is a demo metric; in a real system you'd define it differently.)
  for (let i = 0; i < fleet.length; i++) {
    const rowNum = i + 2; // header is row 1
    const r = fleet[i]!;
    sheet.addRow({
      name: r.name,
      kind: r.kind,
      avgSpeedKmh: r.avgSpeedKmh,
      enduranceMin: r.enduranceMin,
      efficiency: { formula: `C${rowNum}*(D${rowNum}/60)` },
    });
  }

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = 'A1:E1';
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Summary sheet
  summary.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 22 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.views = [{ state: 'frozen', ySplit: 1 }];

  const lastRow = fleet.length + 1;
  summary.addRow({ metric: 'Fleet size', value: fleet.length });
  summary.addRow({
    metric: 'Average estimated range (km) — all drones',
    value: { formula: `AVERAGE(Fleet!E2:E${lastRow})` },
  });

  summary.addRow({ metric: '', value: '' });
  summary.addRow({ metric: 'Per-type average estimated range (km)', value: '' });
  summary.getRow(summary.rowCount).font = { bold: true };

  const kinds: DroneKind[] = ['fpv', 'bomber', 'fixedWing', 'mavic'];
  for (const k of kinds) {
    summary.addRow({
      metric: k,
      value: { formula: `AVERAGEIF(Fleet!B2:B${lastRow},"${k}",Fleet!E2:E${lastRow})` },
    });
  }

  const bytes = await workbook.xlsx.writeBuffer();
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'geofleet-report-demo.xlsx';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ReportsPage() {
  return (
    <div className="row g-3">
      <div className="col-12 col-lg-6">
        <div className="card">
          <div className="card-body">
            <h5 className="card-title">XLSX export</h5>
            <p className="mb-2">
              Exports a demo fleet table: Name, Type, Avg speed, Endurance, plus a Summary sheet with Excel formulas.
            </p>
            <button className="btn btn-primary" onClick={() => void downloadDemoXlsx()}>
              Download demo .xlsx
            </button>
            <div className="form-text mt-2">
              Next: export real data from the live stream (Map) and add user-selected filters to the report.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


export function MetricRing({
  value,
  label,
  detail,
  color = "#67e8f9",
}: {
  value: number;
  label: string;
  detail: string;
  color?: string;
}) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div className="metric-ring-wrap">
      <div
        className="metric-ring"
        style={{
          background: `conic-gradient(${color} ${bounded * 3.6}deg, rgba(255,255,255,.07) 0deg)`,
        }}
      >
        <div className="metric-ring-inner">
          <span>{Math.round(value)}%</span>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
      </div>
    </div>
  );
}

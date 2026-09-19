import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FiActivity, FiDollarSign, FiGrid, FiRefreshCw, FiX, FiZap } from "react-icons/fi";
import { getProviderDisplayName, getProviderIcon } from "../features/conversation/capability/provider-ui";
import { useProviderCatalog } from "../features/conversation/capability/provider-catalog-store";
import type { ProviderId } from "../features/conversation/api/conversation-api";
import { fetchUserUsage, type UserUsagePeriod, type UserUsageSnapshotDto } from "../features/settings/api/user-management-api";
import { t } from "../shared/i18n";

interface TrendPoint { label: string; sessions: number; totalTokens: number; costUsd: number; cacheReadTokens: number; cacheWriteTokens: number; }
interface ProviderOption { id: string; sessions: number; totalTokens: number; costUsd: number; }

export function PerformanceOverviewPanel({ compact = false }: { compact?: boolean }) {
  const [period, setPeriod] = useState<UserUsagePeriod>("day");
  const [snapshot, setSnapshot] = useState<UserUsageSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState("all");
  const [selectedPoint, setSelectedPoint] = useState<TrendPoint | null>(null);
  const allowEmptyDayFallback = useRef(true);
  const { items: providerCatalog } = useProviderCatalog(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    void fetchUserUsage(period).then((value) => {
      if (!active) return;
      const shouldFallbackToWeek = period === "day" && allowEmptyDayFallback.current && !hasUsageData(value);
      allowEmptyDayFallback.current = false;
      if (shouldFallbackToWeek) {
        setSnapshot(null);
        setPeriod("week");
        return;
      }
      setSnapshot(value);
    }).catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [period, reloadVersion]);
  const providers = useMemo(
    () => getProviderOptions(snapshot, providerCatalog?.filter((item) => item.enabled).map((item) => item.provider) ?? []),
    [providerCatalog, snapshot]
  );
  const summary = useMemo(() => aggregateUsage(snapshot, selectedProvider), [snapshot, selectedProvider]);
  useEffect(() => { if (selectedProvider !== "all" && !providers.some((item) => item.id === selectedProvider)) setSelectedProvider("all"); setSelectedPoint(null); }, [period, selectedProvider, providers]);
  if (failed && !snapshot) return null;
  return <section className={`settings-performance-panel${compact ? " settings-performance-panel-compact" : ""}`}>
    <div className="settings-performance-heading"><div><h2>{t("settings.performanceTitle")}</h2><p>{t("settings.performanceDescription")}</p></div><div className="settings-performance-actions"><div className="settings-performance-periods" role="tablist" aria-label={t("settings.performancePeriodLabel")}>{(["day", "week", "month"] as UserUsagePeriod[]).map((value) => <button key={value} type="button" role="tab" aria-selected={period === value} className="settings-performance-period" data-active={period === value ? "true" : undefined} onClick={() => { allowEmptyDayFallback.current = false; setPeriod(value); }}>{periodLabel(value)}</button>)}</div><button type="button" className="settings-performance-refresh" title={t("settings.performanceRefresh")} aria-label={t("settings.performanceRefresh")} onClick={() => setReloadVersion((value) => value + 1)}><FiRefreshCw aria-hidden="true" /></button></div></div>
    {loading && !snapshot ? <div className="settings-performance-loading">{t("settings.performanceLoading")}</div> : <><ProviderFilter options={providers} selected={selectedProvider} onSelect={setSelectedProvider} /><div className="settings-performance-summary"><div className="settings-performance-hero"><span className="settings-performance-hero-icon"><FiZap aria-hidden="true" /></span><div><span>{t("settings.performanceTotalTokens")}</span><strong>{compactNumber(summary.totalTokens)}</strong><small>{`≈ ${compactNumber(summary.totalTokens)}`}</small></div></div><div className="settings-performance-side-metrics"><Metric icon={<FiActivity aria-hidden="true" />} label={t("settings.performanceSessions")} value={number(summary.sessions)} /><Metric icon={<FiDollarSign aria-hidden="true" />} label={t("settings.performanceCost")} value={usd(summary.costUsd)} tone="cost" /></div></div><div className="settings-performance-tiles"><Metric label={t("settings.performanceInputTokens")} value={compactNumber(summary.inputTokens)} /><Metric label={t("settings.performanceOutputTokens")} value={compactNumber(summary.outputTokens)} /><Metric label={t("settings.performanceCacheReadTokens")} value={compactNumber(summary.cacheReadTokens)} tone="cache" /><Metric label={t("settings.performanceCacheWriteTokens")} value={compactNumber(summary.cacheWriteTokens)} tone="cache" /><Metric label={t("settings.performanceCacheHitRate")} value={percent(summary.cacheHitRate)} tone="cache" /><Metric label={t("settings.performanceModels")} value={number(summary.models)} /><Metric label={t("settings.performancePricedSessions")} value={number(summary.pricedSessions)} /><Metric label={t("settings.performanceAverageTokensPerSession")} value={compactNumber(summary.averageTokensPerSession)} /></div><div className="settings-performance-trend"><div className="settings-performance-trend-heading"><strong>{t("settings.performanceTrendTitle")}</strong><span>{periodLabel(period)}</span></div><TrendChart points={summary.points} selectedLabel={selectedPoint?.label ?? null} onSelect={setSelectedPoint} />{selectedPoint ? <PointDetails point={selectedPoint} onClose={() => setSelectedPoint(null)} /> : null}</div></>}
  </section>;
}

function ProviderFilter({ options, selected, onSelect }: { options: ProviderOption[]; selected: string; onSelect: (value: string) => void }) { return <div className="settings-performance-provider-filter" role="group" aria-label={t("settings.performanceProviderFilter")}><button type="button" className="settings-performance-provider" data-active={selected === "all" ? "true" : undefined} aria-pressed={selected === "all"} title={t("settings.performanceAllProviders")} onClick={() => onSelect("all")}><FiGrid aria-hidden="true" /><span>{t("settings.performanceAllProviders")}</span></button>{options.map((option) => <button key={option.id} type="button" className="settings-performance-provider" data-active={selected === option.id ? "true" : undefined} aria-pressed={selected === option.id} title={providerLabel(option.id)} onClick={() => onSelect(option.id)}><img src={getProviderIcon(option.id as ProviderId)} alt="" aria-hidden="true" /><span>{providerLabel(option.id)}</span></button>)}</div>; }
function Metric({ icon, label, value, tone }: { icon?: ReactNode; label: string; value: string; tone?: "cost" | "cache" }) { return <div className={`settings-performance-metric${tone ? ` settings-performance-metric-${tone}` : ""}`}>{icon ? <span className="settings-performance-metric-icon">{icon}</span> : null}<span>{label}</span><strong>{value}</strong></div>; }

function TrendChart({ points, selectedLabel, onSelect }: { points: TrendPoint[]; selectedLabel: string | null; onSelect: (point: TrendPoint) => void }) { if (!points.length) return <div className="settings-performance-empty">{t("settings.performanceEmpty")}</div>; const width = 1000, height = 280, left = 26, right = 24, top = 20, bottom = 34, chartWidth = width - left - right, chartHeight = height - top - bottom; const tokenMax = Math.max(1, ...points.map((item) => item.totalTokens)), costMax = Math.max(1, ...points.map((item) => item.costUsd)); const x = (index: number) => left + (points.length === 1 ? chartWidth / 2 : index / (points.length - 1) * chartWidth); const ty = (value: number) => top + chartHeight - value / tokenMax * chartHeight; const cy = (value: number) => top + chartHeight - value / costMax * chartHeight; const tokens = points.map((item, index) => `${x(index)},${ty(item.totalTokens)}`).join(" "); const costs = points.map((item, index) => `${x(index)},${cy(item.costUsd)}`).join(" "); return <div className="settings-performance-chart-wrap"><svg className="settings-performance-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("settings.performanceTrendAriaLabel")}>{[0, 1, 2, 3].map((line) => { const y = top + chartHeight / 3 * line; return <line key={line} x1={left} x2={left + chartWidth} y1={y} y2={y} className="settings-performance-grid-line" />; })}<polygon points={`${left},${top + chartHeight} ${tokens} ${left + chartWidth},${top + chartHeight}`} className="settings-performance-token-area" /><polyline points={tokens} className="settings-performance-token-line" /><polyline points={costs} className="settings-performance-cost-line" />{points.map((point, index) => <g key={`${point.label}-${index}`}><title>{t("settings.performancePointTooltip", { label: point.label, tokens: number(point.totalTokens), cost: usd(point.costUsd) })}</title><circle cx={x(index)} cy={ty(point.totalTokens)} r={selectedLabel === point.label ? "6" : "4"} className="settings-performance-token-dot" data-selected={selectedLabel === point.label ? "true" : undefined} role="button" tabIndex={0} aria-label={t("settings.performancePointTooltip", { label: point.label, tokens: number(point.totalTokens), cost: usd(point.costUsd) })} onClick={() => onSelect(point)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(point); } }} /></g>)}{labelIndexes(points.length).map((index) => <text key={index} x={x(index)} y={height - 8} textAnchor="middle" className="settings-performance-axis-label">{points[index]?.label}</text>)}</svg><div className="settings-performance-legend"><span><i className="settings-performance-legend-token" />{t("settings.performanceTokenLegend")}</span><span><i className="settings-performance-legend-cost" />{t("settings.performanceCostLegend")}</span></div></div>; }
function PointDetails({ point, onClose }: { point: TrendPoint; onClose: () => void }) { return <div className="settings-performance-point-details"><div><strong>{point.label}</strong><span>{t("settings.performancePointDetails")}</span></div><div className="settings-performance-point-values"><span>{t("settings.performanceTotalTokens")}: <b>{number(point.totalTokens)}</b></span><span>{t("settings.performanceCost")}: <b>{usd(point.costUsd)}</b></span><span>{t("settings.performanceCacheReadTokens")}: <b>{number(point.cacheReadTokens)}</b></span><span>{t("settings.performanceCacheWriteTokens")}: <b>{number(point.cacheWriteTokens)}</b></span><span>{t("settings.performanceSessions")}: <b>{number(point.sessions)}</b></span></div><button type="button" onClick={onClose} aria-label={t("settings.performanceCloseDetails")} title={t("settings.performanceCloseDetails")}><FiX aria-hidden="true" /></button></div>; }

function aggregateUsage(snapshot: UserUsageSnapshotDto | null, provider: string) {
  const points = new Map<string, TrendPoint>();
  let sessions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let pricedSessions = 0;
  const models = new Set<string>();

  for (const user of snapshot?.users ?? []) {
    const item = provider === "all" ? null : user.cliProviderUsage.find((entry) => entry.label === provider);
    sessions += item?.count ?? (provider === "all" ? user.sessionCount : 0);
    inputTokens += item?.inputTokens ?? (provider === "all" ? user.tokenTotals.inputTokens : 0);
    outputTokens += item?.outputTokens ?? (provider === "all" ? user.tokenTotals.outputTokens : 0);
    totalTokens += item?.totalTokens ?? (provider === "all" ? user.tokenTotals.totalTokens : 0);
    cacheReadTokens += item?.cacheReadTokens ?? (provider === "all" ? user.tokenTotals.cacheReadTokens ?? 0 : 0);
    cacheWriteTokens += item?.cacheWriteTokens ?? (provider === "all" ? user.tokenTotals.cacheWriteTokens ?? 0 : 0);
    costUsd += item?.costUsd ?? (provider === "all" && user.costUsageAvailable ? user.costUsd : 0);
    pricedSessions += provider === "all" ? (user.costUsageAvailable ? user.sessionCount : 0) : (item?.costUsd != null ? item.count : 0);

    for (const model of user.modelUsage ?? []) models.add(model.label);

    const timeline = provider === "all" ? user.timeline ?? [] : user.cliProviderTimeline?.[provider] ?? [];
    for (const bucket of timeline) {
      const current = points.get(bucket.bucket) ?? {
        label: bucket.bucket,
        sessions: 0,
        totalTokens: 0,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      };
      current.sessions += bucket.sessionCount ?? 0;
      current.totalTokens += bucket.totalTokens ?? 0;
      current.costUsd += bucket.costUsd ?? 0;
      current.cacheReadTokens += bucket.cacheReadTokens ?? 0;
      current.cacheWriteTokens += bucket.cacheWriteTokens ?? 0;
      points.set(bucket.bucket, current);
    }
  }

  return {
    sessions,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd,
    pricedSessions,
    models: models.size,
    averageTokensPerSession: totalTokens / Math.max(1, sessions),
    cacheHitRate: cacheReadTokens / Math.max(1, cacheReadTokens + inputTokens),
    points: [...points.values()].sort((left, right) => left.label.localeCompare(right.label))
  };
}
function getProviderOptions(snapshot: UserUsageSnapshotDto | null, enabledProviders: readonly string[]): ProviderOption[] { const enabledProviderSet = new Set(enabledProviders); const options = new Map<string, ProviderOption>(); for (const user of snapshot?.users ?? []) for (const item of user.cliProviderUsage) { if (!enabledProviderSet.has(item.label)) continue; const current = options.get(item.label) ?? { id: item.label, sessions: 0, totalTokens: 0, costUsd: 0 }; current.sessions += item.count; current.totalTokens += item.totalTokens; current.costUsd += item.costUsd ?? 0; options.set(item.label, current); } return [...options.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.id.localeCompare(right.id)); }
function hasUsageData(snapshot: UserUsageSnapshotDto): boolean {
  return snapshot.users.some((user) =>
    user.sessionCount > 0
    || user.costUsd > 0
    || user.tokenTotals.totalTokens > 0
    || (user.timeline?.length ?? 0) > 0
    || Object.values(user.cliProviderTimeline ?? {}).some((timeline) => timeline.length > 0)
    || user.modelUsage.some((item) => item.count > 0 || item.totalTokens > 0)
    || user.cliProviderUsage.some((item) => item.count > 0 || item.totalTokens > 0)
  );
}
function providerLabel(id: string): string { return getProviderDisplayName(id as ProviderId); }
function periodLabel(period: UserUsagePeriod): string { return t(period === "week" ? "settings.performancePeriodWeek" : period === "month" ? "settings.performancePeriodMonth" : "settings.performancePeriodDay"); }
function labelIndexes(length: number): number[] { return length <= 5 ? Array.from({ length }, (_, index) => index) : [0, Math.round((length - 1) / 2), length - 1]; }
function number(value: number): string { return new Intl.NumberFormat().format(value); }
function compactNumber(value: number): string { return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function usd(value: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value); }
function percent(value: number): string { return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value); }

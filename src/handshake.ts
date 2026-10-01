/** Pure handshake parser: turns a receiver AI's restatement into a verdict.
 * The contract (see taskbook.ts HANDSHAKE_TEXT) requires three blocks —
 * 【回读】 restatement, 【缺口】 gaps, and a STATUS line plus version stamp.
 * Anything short of that is an invalid handshake, never a silent pass. */

export type HandshakeStatus = 'ready' | 'need-input';

export interface Handshake {
  ok: boolean;
  status: HandshakeStatus | null;
  version: number | null;
  restatement: string;
  gaps: string[];
  issues: string[];
}

const STATUS_RE = /STATUS\s*[:：]\s*(READY|NEED[-_ ]?INPUT)/i;
const VERSION_RE = /(?:version|版本)\s*[:：]?\s*v?(\d+)/i;
const MARKERS = { restatement: '【回读】', gaps: '【缺口】' } as const;

/** 1. / 1、 / 1) / - 1. … numbered gap lines; bare "无" lines mean no gaps. */
const NUMBERED_RE = /^\s*(?:[-*]\s*)?(\d{1,3})\s*[.、)．]\s*(.+)$/;

function sectionAfter(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) return '';
  const rest = text.slice(start + marker.length);
  const next = rest.search(/【[^】]{1,6}】|^\s*STATUS\s*[:：]/im);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function parseHandshake(input: string): Handshake {
  const text = String(input ?? '');
  const issues: string[] = [];

  const statusMatch = STATUS_RE.exec(text);
  const status = (statusMatch ? (statusMatch[1]!.toUpperCase().startsWith('READY') ? 'ready' : 'need-input') : null) as HandshakeStatus | null;
  if (!statusMatch) issues.push('缺少 STATUS 行（READY / NEED-INPUT）——没有明确放行，不能当握手通过');

  const versionMatch = VERSION_RE.exec(text);
  const version = versionMatch ? Number.parseInt(versionMatch[1]!, 10) : null;
  if (version === null) issues.push('缺少 version 确认（接收方必须注明它读到的是哪一版）');

  const restatement = sectionAfter(text, MARKERS.restatement);
  if (!restatement) issues.push('缺少【回读】段——没有复述理解就不算确认');

  const rawGaps = sectionAfter(text, MARKERS.gaps);
  const gaps: string[] = [];
  if (!rawGaps) {
    issues.push('缺少【缺口】段');
  } else {
    for (const line of rawGaps.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean) continue;
      if (/^(无|none|没有)$/i.test(clean)) break;
      const numbered = NUMBERED_RE.exec(clean);
      gaps.push(numbered ? numbered[2]!.trim() : clean.replace(/^[-*]\s*/, ''));
    }
  }

  return { ok: status !== null && restatement !== '' && version !== null, status, version, restatement, gaps, issues };
}

export function isStaleVersion(hs: Handshake, current: number): boolean {
  return hs.version !== null && hs.version !== current;
}

export function renderAckReply(
  hs: Handshake,
  task: { id: string; version: number; title: string },
  target: string,
  gapQids: string[] = [],
): string {
  const gapLabel = (index: number): string => (gapQids[index] ? `G${index + 1} → ${gapQids[index]}` : `G${index + 1}`);
  if (!hs.ok) {
    return [
      `✗ ${target} 的回读不算有效握手（${task.id}@v${task.version}）：`,
      ...hs.issues.map((issue) => `- ${issue}`),
      '把下面这段补发给对方窗口，让它按格式重来回读：',
      `请按任务书 ${task.id}@v${task.version} 的握手指令回读：先【回读】复述目标/约束/验收标准，再【缺口】列出疑问，首行注明 version，末行 STATUS: READY 或 STATUS: NEED-INPUT。`,
    ].join('\n');
  }
  const stale = isStaleVersion(hs, task.version)
    ? [`⚠ 对方确认的是 v${hs.version}，最新版是 v${task.version}——回读按旧版处理，需要把最新版重新 relay 并让对方重新回读。`]
    : [];
  if (hs.status === 'ready') {
    return [
      `✓ ${target} 回读通过（${task.id}@v${task.version}，STATUS: READY），可以放心让它开工。`,
      ...stale,
      '后续所有交接引用该任务时都带上版本号：' + `${task.id}@v${task.version}。`,
    ].join('\n');
  }
  return [
    `△ ${target} 回读完成但有待补缺口（${task.id}@v${task.version}，STATUS: NEED-INPUT）：`,
    ...hs.gaps.map((gap, index) => `- ${gapLabel(index)}: ${gap}`),
    ...stale,
    hs.gaps.length
      ? `缺口已登记进任务书的开放缺口（${gapQids.join(' ') || '编号待定'}）。逐条 /answer ${task.id} <Q编号> <答案>，答完版本 +1，记得把新版重新 relay 给所有已交接的窗口。`
      : '对方标了 NEED-INPUT 但没列出具体缺口——直接问它缺什么。',
  ].join('\n');
}

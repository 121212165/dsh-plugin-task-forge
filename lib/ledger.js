/** Pure handshake ledger: one JSONL event per protocol step, folded into
 * per-task state. The ledger is the single authority for "who holds which
 * version of which task" — the system-prompt section reads it live, so a
 * relay or ack lands in every future session without restarts. */
import { STATUS_LABEL, targetSummary } from './taskbook.js';
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const KINDS = ['created', 'compiled', 'revised', 'relayed', 'acked', 'gap-resolved', 'noted', 'done'];
export function parseLine(line) {
    const text = line.trim();
    if (!text)
        return null;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!isRecord(value))
        return null;
    if (typeof value.task !== 'string' || !value.task)
        return null;
    if (typeof value.event !== 'string' || !KINDS.includes(value.event))
        return null;
    if (typeof value.ts !== 'string' || !Number.isFinite(Date.parse(value.ts)))
        return null;
    const ev = value;
    if (value.v !== undefined && value.v !== 1)
        return null; // future envelope
    // Notes come from user/agent free text: a stray newline would break JSONL.
    return { ...ev, note: typeof ev.note === 'string' ? ev.note.replace(/\s+/g, ' ').trim() : undefined };
}
export function parseLedger(content) {
    const events = [];
    let skipped = 0;
    for (const line of content.split(/\r?\n/)) {
        const event = parseLine(line);
        if (event)
            events.push(event);
        else if (line.trim())
            skipped++;
    }
    return { events, skipped };
}
export function eventLine(event) {
    // envelope version for P5 compatibility: older readers and older cached
    // state meet what we write; parseLine accepts v1 and versionless legacy rows
    const clean = { v: 1, ...event, note: event.note?.replace(/\s+/g, ' ').trim() };
    return JSON.stringify(clean);
}
/** Later events win; targets accumulate across relay/ack; ack tallies fold
 * from event notes; title sticks from whichever event last carried one. */
export function foldStates(events) {
    const states = new Map();
    for (const event of events) {
        const current = states.get(event.task) ?? {
            id: event.task,
            title: '',
            version: 0,
            status: 'draft',
            targets: [],
            lastAt: event.ts,
            events: 0,
            acksReady: 0,
            acksGap: 0,
            notes: 0,
        };
        current.events += 1;
        current.lastAt = event.ts;
        // 版本单调不回退：多进程对同一台账追加时，旧事件晚到不应把版本拽回去
        // （status/title 仍以后写者为准）。
        if (typeof event.version === 'number' && event.version > current.version)
            current.version = event.version;
        if (event.status)
            current.status = event.status;
        if (event.title)
            current.title = event.title;
        if (event.note)
            current.lastNote = event.note;
        if (event.event === 'noted')
            current.notes += 1;
        if (event.target && (event.event === 'relayed' || event.event === 'acked') && !current.targets.includes(event.target)) {
            current.targets.push(event.target);
        }
        if (event.event === 'acked') {
            if (event.status === 'ready')
                current.acksReady += 1;
            else if (/need-input|stale/i.test(event.note ?? ''))
                current.acksGap += 1;
        }
        states.set(event.task, current);
    }
    return [...states.values()].sort((a, b) => (a.lastAt === b.lastAt ? (a.id < b.id ? 1 : -1) : a.lastAt < b.lastAt ? 1 : -1));
}
/** Compact relative time for the ledger view ("刚刚", "3 小时前", "2 天前"). */
export function relativeTime(ts, now = new Date()) {
    const then = Date.parse(ts);
    if (!Number.isFinite(then))
        return '时间未知';
    const diff = now.getTime() - then;
    if (diff < 60_000)
        return '刚刚';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 60)
        return `${minutes} 分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
}
/** The one action that moves this task forward, by protocol position. */
export function nextStepHint(status, acksGap) {
    switch (status) {
        case 'draft':
            return '等模型编译（forge_write），或直接 /relay 导出草稿';
        case 'relayed':
            return acksGap > 0
                ? '有回读待补缺口：/answer 逐条回答，答完重新 /relay 新版'
                : '等接收方回读；把回读全文交给 /ack';
        case 'ready':
            return '可以让它开工；引用任务一定带 id@version';
        case 'in-progress':
            return '干完 /forge-done 收档';
        case 'done':
            return '已归档';
        default:
            return '';
    }
}
export function renderForgeList(states, skipped = 0, details = new Map()) {
    if (!states.length)
        return '任务台账是空的。/forge <大白话需求> 编译第一个任务书。';
    const summaryParts = [];
    for (const status of ['draft', 'relayed', 'ready', 'in-progress', 'done']) {
        const n = states.filter((state) => state.status === status).length;
        if (n > 0)
            summaryParts.push(`${STATUS_LABEL[status]} ${n}`);
    }
    const lines = [`任务台账 ${states.length} 个 · ${summaryParts.join(' · ')}`];
    for (const state of states) {
        const mark = STATUS_MARK[state.status] ?? '○';
        lines.push(`  ${mark} ${state.id}@v${state.version} [${STATUS_LABEL[state.status] ?? state.status}] ${state.title || '（未命名）'}`);
        const facts = [relativeTime(state.lastAt)];
        const detail = details.get(state.id);
        if (detail?.mode)
            facts.push(detail.mode === 'interview' ? 'interview' : 'auto');
        if (state.acksReady)
            facts.push(`回读通过 ${state.acksReady} 次`);
        if (state.acksGap)
            facts.push(`待补缺口 ${state.acksGap} 次`);
        if (state.notes)
            facts.push(`备注 ${state.notes}`);
        if (detail) {
            if (detail.missing)
                facts.push('⚠ 任务书文件缺失');
            else {
                if (detail.gaps)
                    facts.push(`缺口 ${detail.gaps}`);
                if (detail.decisions)
                    facts.push(`决策 ${detail.decisions}`);
                if (detail.cost)
                    facts.push(detail.cost);
            }
        }
        // Per-window read-back comes from the task book; the ledger only knows names.
        if (detail?.targets?.length)
            facts.push(`窗口: ${targetSummary(detail.targets, state.version)}`);
        else if (state.targets.length)
            facts.push(`交接: ${state.targets.join(', ')}`);
        if (state.status === 'draft' && state.lastNote)
            facts.push(state.lastNote);
        lines.push('      ' + facts.join(' · '));
        const hint = nextStepHint(state.status, state.acksGap);
        if (hint)
            lines.push(`      ▸ ${hint}`);
    }
    if (skipped)
        lines.push(`⚠ ${skipped} 行台账损坏被跳过`);
    return lines.join('\n');
}
const STATUS_MARK = { draft: '○', relayed: '◐', ready: '◉', 'in-progress': '▶', done: '✓' };
/** Injected section: only live (non-done) tasks, capped like pinboard's budget.
 * An oversized line is truncated rather than dropped so the newest task always shows. */
export function renderSection(states, budget) {
    const live = states.filter((state) => state.status !== 'done').slice(0, budget.limit);
    if (!live.length)
        return '';
    const lines = [];
    let used = 0;
    for (const state of live) {
        const remaining = budget.maxChars - used - (lines.length ? 1 : 0);
        if (remaining < 3)
            break;
        const mark = STATUS_MARK[state.status] ?? '○';
        const targets = state.targets.length ? `，交接给 ${state.targets.join('/')}` : '';
        const line = `- ${mark} ${state.id}@v${state.version} ${state.title || '（未命名）'} [${state.status}]${targets}`;
        if (line.length <= remaining) {
            lines.push(line);
            used += line.length + (lines.length > 1 ? 1 : 0);
            continue;
        }
        if (!lines.length)
            lines.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
        break;
    }
    if (!lines.length)
        return '';
    return [
        '## 进行中任务（task-forge）',
        '这些任务正通过任务书+回读握手跨窗口交接。引用任务必须带完整版本号（id@version）；收到任务书的 AI 先按握手指令回读，再开工。',
        ...lines,
    ].join('\n');
}
/** 台账和 task.md 是两本账：命令侧 bug 或手工编辑都可能让版本漂移。把漂移
 * 变成注入区段里的可见警告，而不是静默矛盾。loader 按 id 读盘（不存在返回
 * null，损坏抛异常——两者都算漂移）。最多报 max 条，避免警告淹没正文。 */
export function driftAlerts(states, loader, max = 3) {
    const alerts = [];
    for (const state of states) {
        if (alerts.length >= max)
            break;
        if (state.status === 'done')
            continue;
        let disk = null;
        try {
            disk = loader(state.id);
        }
        catch {
            alerts.push(`⚠ ${state.id} 任务书损坏，台账显示 v${state.version}——先修 tasks/${state.id}/task.md`);
            continue;
        }
        if (!disk) {
            alerts.push(`⚠ ${state.id} 台账有活动记录但任务书文件不存在`);
            continue;
        }
        if (disk.version !== state.version) {
            alerts.push(`⚠ ${state.id} 台账记 v${state.version} 但任务书是 v${disk.version}——以任务书为准，排查中间缺的事件`);
        }
    }
    return alerts;
}
//# sourceMappingURL=ledger.js.map
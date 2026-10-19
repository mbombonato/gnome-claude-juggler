// Picks the best account to use right now.
//
// Idea: weekly quota that isn't used before the reset is wasted. So each
// account's score is its remaining weekly capacity (in "Pro units", using the
// plan weight) divided by the hours until the reset — how much quota "expires"
// per hour. A Pro that resets in 2h with 60% left beats a Max 20x that only
// resets in 6 days, but otherwise the bigger account wins. The 5h window caps
// immediate use, so accounts close to the session limit are penalized and the
// ones that hit a limit are left out.

import {effectiveWeight, shortName} from './accounts.js';
import {_, _f} from './i18n.js';

const SESSION_BLOCKED = 97;
const WEEKLY_BLOCKED = 99;
const SESSION_COMFORT = 30; // below 30% left in the session, start penalizing

export function formatDuration(ms) {
    if (ms === null || ms === undefined)
        return '—';
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60)
        return `${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24)
        return `${h}h ${min % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function untilReset(win, now) {
    return win?.resetsAt ? Math.max(0, win.resetsAt - now) : null;
}

export function scoreAccount(account, usage, now = Date.now()) {
    if (!usage?.session || !usage?.weekly)
        return null;

    const sessionFree = 100 - usage.session.used;
    const weeklyFree = 100 - usage.weekly.used;
    const weeklyMs = untilReset(usage.weekly, now) ?? 7 * 24 * 3600e3;

    const blockers = [];
    if (usage.session.used >= SESSION_BLOCKED)
        blockers.push(untilReset(usage.session, now) ?? 0);
    if (usage.weekly.used >= WEEKLY_BLOCKED)
        blockers.push(weeklyMs);
    if (blockers.length)
        return {blocked: true, availableIn: Math.max(...blockers), score: 0};

    const hours = Math.max(1, weeklyMs / 3600e3);
    const expiringPerHour = effectiveWeight(account) * (weeklyFree / 100) / hours;
    const sessionFactor = Math.min(1, Math.max(0.1, sessionFree / SESSION_COMFORT));
    return {blocked: false, score: expiringPerHour * sessionFactor, sessionFree, weeklyFree, weeklyMs};
}

// entries: [{account, usage}] -> {account, reason} | null
export function recommend(entries, now = Date.now()) {
    const scored = entries
        .filter(e => e.account.include !== false)
        .map(e => ({...e, s: scoreAccount(e.account, e.usage, now)}))
        .filter(e => e.s);

    if (!scored.length)
        return null;

    const available = scored.filter(e => !e.s.blocked).sort((a, b) => b.s.score - a.s.score);
    if (!available.length) {
        const soonest = scored.sort((a, b) => a.s.availableIn - b.s.availableIn)[0];
        return {
            account: soonest.account,
            blocked: true,
            reason: _f('All at the limit — {name} frees up in {time}', {name: shortName(soonest.account), time: formatDuration(soonest.s.availableIn)}),
        };
    }

    const best = available[0];
    const {sessionFree, weeklyFree, weeklyMs} = best.s;
    let reason;
    if (sessionFree < SESSION_COMFORT)
        reason = _f('Session at {pct}%, but still the best option', {pct: Math.round(100 - sessionFree)});
    else if (weeklyMs < 36 * 3600e3 && weeklyFree >= 15)
        reason = _f('{pct}% of the week left and it resets in {time} — use it before you lose it', {pct: Math.round(weeklyFree), time: formatDuration(weeklyMs)});
    else if (available.every(e => e === best || effectiveWeight(e.account) < effectiveWeight(best.account)))
        reason = _f('Most free capacity ({plan})', {plan: best.account.plan || _('bigger plan')});
    else
        reason = _('Best balance between session and weekly quota');

    return {account: best.account, blocked: false, reason};
}

export const visitorRanges = [7, 30, 90];
const count = value => Number.isSafeInteger(value) && value >= 0;
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const problem = () => { throw new Error('Die Website hat keine vollständige Aufrufstatistik geliefert. Bitte erneut laden.'); };

export function visitorReport(value, expectedDays) {
  if (!value || !visitorRanges.includes(expectedDays) || value.rangeDays !== expectedDays || value.timeZone !== 'Europe/Berlin' || value.retentionDays !== 90 || !validTime(value.startedAt) || !validTime(value.generatedAt) || Date.parse(value.startedAt) > Date.parse(value.generatedAt) || typeof value.partial !== 'boolean') problem();
  if (!validDay(value.today?.date) || !count(value.today?.views) || !count(value.today?.visitors) || !count(value.period?.views) || !count(value.period?.visitorDays) || !count(value.totals?.views) || !count(value.totals?.visitorDays)) problem();
  if (!Array.isArray(value.daily) || !value.daily.length || value.daily.length > expectedDays || !Array.isArray(value.pages) || value.pages.length > 1000) problem();
  let previous = '', views = 0, visitors = 0;
  for (const day of value.daily) {
    if (!validDay(day?.date) || day.date <= previous || day.date > value.today.date || !count(day.views) || !count(day.visitors) || day.visitors > day.views) problem();
    if (previous && Date.parse(day.date + 'T12:00:00Z') - Date.parse(previous + 'T12:00:00Z') !== 86400000) problem();
    previous = day.date; views += day.views; visitors += day.visitors;
  }
  const today = value.daily.at(-1);
  if (today.date !== value.today.date || today.views !== value.today.views || today.visitors !== value.today.visitors || views !== value.period.views || visitors !== value.period.visitorDays || value.totals.views < views || value.totals.visitorDays < visitors || value.totals.visitorDays > value.totals.views) problem();
  const paths = new Set(); let pageViews = 0;
  for (const page of value.pages) {
    if (!page || typeof page.path !== 'string' || !page.path.startsWith('/') || page.path.length > 400 || paths.has(page.path) || typeof page.label !== 'string' || !page.label.trim() || page.label.length > 200 || !count(page.views)) problem();
    paths.add(page.path); pageViews += page.views;
  }
  if (pageViews !== views) problem();
  return value;
}

// Each request owns a sequence number. A response for a previous range or a
// disposed account view must never replace the currently visible report.
export function createVisitorStatsController({ request, onChange }) {
  let active = true, sequence = 0;
  let state = { days: 30, data: null, loading: false, error: '' };
  const update = next => { state = { ...state, ...next }; if (active) onChange(state); };
  return {
    state: () => state,
    async load(days = state.days) {
      if (!active || !visitorRanges.includes(days)) return false;
      const current = ++sequence;
      update({ days, loading: true, error: '', ...(days !== state.days ? { data: null } : {}) });
      try {
        const data = await request(days);
        if (!active || current !== sequence) return false;
        update({ data: visitorReport(data, days), loading: false });
        return true;
      } catch (error) {
        if (!active || current !== sequence) return false;
        // Clear old numbers on failure, including expired/revoked admin access.
        update({ data: null, loading: false, error: error?.message || 'Die Aufrufe konnten nicht geladen werden.' });
        return false;
      }
    },
    dispose() { active = false; sequence++; state = { ...state, data: null, loading: false }; },
  };
}

export const visitorNumber = value => new Intl.NumberFormat('de-DE').format(value);
export const visitorTime = value => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(value));
export const visitorDate = (value, full = false) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', ...(full ? { year: 'numeric' } : {}), timeZone: 'Europe/Berlin' }).format(new Date(`${value}T12:00:00Z`));

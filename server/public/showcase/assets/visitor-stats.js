const number = new Intl.NumberFormat('de-DE');
const dateFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'Europe/Berlin' });
const timestampFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' });
const count = value => Number.isSafeInteger(value) && value >= 0;
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function dayLabel(value) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(`${value}T12:00:00Z`) : null;
  return day && Number.isFinite(day.getTime()) ? dateFormat.format(day) : '–';
}
function timeLabel(value, formatter = timestampFormat) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? formatter.format(date) : '–';
}
function validResult(result, days) {
  return result && result.rangeDays === days && result.timeZone === 'Europe/Berlin'
    && count(result.today?.views) && count(result.today?.visitors)
    && count(result.period?.views) && count(result.totals?.views)
    && Array.isArray(result.daily) && result.daily.length <= 90
    && result.daily.every(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date || '') && count(day.views) && count(day.visitors))
    && Array.isArray(result.pages) && result.pages.every(page => typeof page.path === 'string' && typeof page.label === 'string' && count(page.views));
}

// The existing admin session remains the only authority for loading this panel.
export function createVisitorStats({ getContext, onAuthError }) {
  const root = document.getElementById('aufrufstatistik');
  const $ = id => document.getElementById(id);
  const range = $('visitorStatsRange');
  const reload = $('visitorStatsRefresh');
  const status = $('visitorStatsStatus');
  let pending = null;
  let revision = 0;
  let adminLocked = false;

  function controls() {
    range.disabled = adminLocked || Boolean(pending);
    reload.disabled = adminLocked || Boolean(pending);
    root.setAttribute('aria-busy', String(Boolean(pending)));
  }
  function emptyValues() {
    ['visitorStatsTodayViews', 'visitorStatsTodayVisitors', 'visitorStatsPeriodViews', 'visitorStatsTotalViews'].forEach(id => { $(id).textContent = '–'; });
    $('visitorStatsDaily').replaceChildren();
    $('visitorStatsPages').replaceChildren();
    $('visitorStatsDetails').hidden = true;
    $('visitorStatsStarted').textContent = 'Die Erfassung beginnt mit der Aktivierung. Frühere Besuche können nicht nachträglich gezählt werden.';
  }
  function cancel() {
    revision++;
    pending?.abort();
    pending = null;
    controls();
  }
  function clear() {
    cancel();
    emptyValues();
    status.textContent = 'Die Statistik wird nach der Admin-Anmeldung geladen.';
    status.classList.remove('is-error');
  }
  function render(result) {
    $('visitorStatsTodayViews').textContent = number.format(result.today.views);
    $('visitorStatsTodayVisitors').textContent = number.format(result.today.visitors);
    $('visitorStatsPeriodViews').textContent = number.format(result.period.views);
    $('visitorStatsTotalViews').textContent = number.format(result.totals.views);
    $('visitorStatsPeriodLabel').textContent = `Aufrufe · letzte ${result.rangeDays} Tage`;
    $('visitorStatsPagesHeading').textContent = `Häufig aufgerufene Seiten · ${result.rangeDays} Tage`;
    const daily = document.createDocumentFragment();
    for (const day of result.daily) {
      const row = node('tr');
      const heading = node('th', dayLabel(day.date));
      heading.scope = 'row';
      row.append(heading, node('td', number.format(day.views)), node('td', number.format(day.visitors)));
      daily.append(row);
    }
    if (!result.daily.length) {
      const row = node('tr');
      const cell = node('td', 'Noch keine Tageswerte vorhanden.');
      cell.colSpan = 3;
      row.append(cell);
      daily.append(row);
    }
    $('visitorStatsDaily').replaceChildren(daily);
    const pages = document.createDocumentFragment();
    for (const page of result.pages) {
      const item = node('li');
      const title = node('span');
      title.append(node('strong', page.label || page.path), node('small', page.path));
      item.append(title, node('span', `${number.format(page.views)} Aufrufe`, 'cb-visitor-page-count'));
      pages.append(item);
    }
    if (!result.pages.length) pages.append(node('li', 'Noch keine Gäste-Aufrufe in diesem Zeitraum.'));
    $('visitorStatsPages').replaceChildren(pages);
    $('visitorStatsDetails').hidden = false;
    $('visitorStatsStarted').textContent = `Erfassung seit ${timeLabel(result.startedAt)}. Tagesverlauf und Seitenübersicht für höchstens ${result.retentionDays || 90} Tage; die Gesamtzahl bleibt erhalten. Frühere Besuche sind nicht enthalten.`;
    status.textContent = `Stand: ${timeLabel(result.generatedAt)} · Zeitzone Berlin.${result.partial ? ' Ein Teil der Aufrufe oder Besucher konnte nicht vollständig erfasst werden.' : ''}${result.period.views === 0 ? ' In diesem Zeitraum wurden noch keine Gäste-Aufrufe gezählt.' : ''}`;
  }
  async function refresh() {
    cancel();
    const context = getContext();
    if (!context.allowed) { clear(); return; }
    const current = revision;
    const selectedDays = Number(range.value);
    const controller = new AbortController();
    pending = controller;
    emptyValues();
    $('visitorStatsPeriodLabel').textContent = `Aufrufe · letzte ${selectedDays} Tage`;
    status.textContent = 'Aufrufstatistik wird geladen …';
    status.classList.remove('is-error');
    controls();
    const isCurrent = () => current === revision && getContext().allowed && context.generation === getContext().generation;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/admin/visitor-stats?days=${selectedDays}`, {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!isCurrent()) return;
      if ([401, 403].includes(response.status)) {
        clear();
        onAuthError();
        return;
      }
      if (!response.ok) throw new Error('Die Aufrufstatistik ist gerade nicht verfügbar. Bitte erneut laden.');
      const result = await response.json();
      if (!isCurrent()) return;
      if (!validResult(result, selectedDays)) throw new Error('Die Statistikantwort ist unvollständig. Bitte erneut laden.');
      render(result);
    } catch (error) {
      if (!isCurrent()) return;
      emptyValues();
      status.textContent = error.name === 'AbortError' ? 'Die Statistik antwortet gerade nicht. Bitte erneut laden.' : 'Die Aufrufstatistik konnte nicht geladen werden. Bitte erneut versuchen. Konten und Anfragen kannst du weiterhin verwalten.';
      status.classList.add('is-error');
    } finally {
      clearTimeout(timer);
      if (current === revision) { pending = null; controls(); }
    }
  }
  range.addEventListener('change', () => { void refresh(); });
  reload.addEventListener('click', () => { void refresh(); });
  clear();
  return { refresh, cancel, clear, setLocked(value) { adminLocked = value; controls(); } };
}

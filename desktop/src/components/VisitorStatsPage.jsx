import React, {useEffect, useId, useRef, useState} from 'react';
import {ChartNoAxesCombined, RefreshCw, ShieldCheck, Globe, Eye, Users, CalendarDays} from 'lucide-react';
import {WebsiteAdminGate, WorkspaceHero} from './WebsiteAdminShared';
import {IntegrationEmpty, IntegrationError} from './IntegrationShared';
import {createVisitorStatsController, visitorRanges, visitorNumber as number, visitorTime, visitorDate} from './visitor-stats-state.mjs';
import './visitor-stats.css';

function DailyChart({daily}) {
  const id = useId(), width = 760, height = 245, left = 44, right = 12, top = 22, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const max = Math.max(1, ...daily.map(day => day.views)), step = plotWidth / daily.length;
  const x = index => left + step * (index + .5), y = value => top + plotHeight * (1 - value / max);
  const marks = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  return <figure className="visitor-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>Gäste-Aufrufe im Tagesverlauf</title>
      <desc id={`${id}-desc`}>Goldene Balken zeigen Aufrufe, die helle Linie geschätzte Besucher pro Tag. Alle Zahlen stehen unter „Tageswerte als Tabelle“.</desc>
      {ticks.map(value => <g key={value}><line x1={left} x2={width-right} y1={y(value)} y2={y(value)} className="visitor-grid-line"/><text x={left-10} y={y(value)+4} textAnchor="end" className="visitor-axis-label">{number(value)}</text></g>)}
      {daily.map((day,index) => <rect key={day.date} x={x(index)-Math.min(step*.63,36)/2} y={y(day.views)} width={Math.min(step*.63,36)} height={plotHeight*day.views/max} rx={Math.min(3,step*.12)} className="visitor-bar"><title>{visitorDate(day.date,true)}: {number(day.views)} Aufrufe, {number(day.visitors)} Besucher (geschätzt)</title></rect>)}
      <polyline points={daily.map((day,index)=>`${x(index)},${y(day.visitors)}`).join(' ')} className="visitor-visitors-line"/>
      {daily.length < 15 && daily.map((day,index)=><circle key={day.date} cx={x(index)} cy={y(day.visitors)} r="3" className="visitor-visitors-dot"/>)}
      {marks.map(index=><text key={index} x={x(index)} y={height-10} textAnchor={index===0?'start':index===daily.length-1?'end':'middle'} className="visitor-axis-label">{visitorDate(daily[index].date)}</text>)}
    </svg>
    <figcaption className="visitor-legend"><span><i className="visitor-legend-bar"/>Aufrufe</span><span><i className="visitor-legend-line"/>Besucher pro Tag (geschätzt)</span></figcaption>
  </figure>;
}

function VisitorStatsContent({api, context}) {
  const controller = useRef(null);
  const [model,setModel] = useState({days:30,data:null,loading:true,error:''});
  useEffect(() => {
    const current = createVisitorStatsController({request:days=>api('website.request',{operation:'visitorStats.get',body:{days}}),onChange:setModel});
    controller.current = current;
    void current.load();
    const reloadVisible = () => { if(document.visibilityState==='visible'&&!current.state().loading) void current.load(); };
    const timer = setInterval(reloadVisible,60000);
    document.addEventListener('visibilitychange',reloadVisible);
    return () => {current.dispose();clearInterval(timer);document.removeEventListener('visibilitychange',reloadVisible);if(controller.current===current)controller.current=null;};
  },[api,context]);
  const data=model.data, maxPageViews=Math.max(1,...(data?.pages||[]).map(page=>page.views));
  const values=[['Aufrufe heute',data?.today.views,Eye,'Jeder gezählte Seitenaufruf'],['Besucher heute',data?.today.visitors,Users,'Tägliche Schätzung nach Netzwerkadresse'],[`Aufrufe · ${model.days} Tage`,data?.period.views,CalendarDays,'Im ausgewählten Zeitraum'],['Aufrufe insgesamt',data?.totals.views,Globe,'Seit Beginn der Erfassung']];
  return <div className="page-stack integration-page visitor-page">
    <WorkspaceHero eyebrow="DEINE WEBSITE · DEINE REICHWEITE" title="Deine Website in Zahlen" Icon={ChartNoAxesCombined}>Die Gäste-Aufrufe deiner Website – heute, im Verlauf und nach Seiten. Direkt aus deiner bestehenden Website-Statistik.</WorkspaceHero>
    <section className="panel visitor-controls" aria-label="Zeitraum und Aktualisierung"><div className="visitor-range"><span>Zeitraum</span><div className="visitor-range-buttons" role="group" aria-label="Zeitraum auswählen">{visitorRanges.map(days=><button key={days} className={`btn ${days===model.days?'is-selected':''}`} aria-pressed={days===model.days} onClick={()=>void controller.current?.load(days)}>{days} Tage</button>)}</div></div><div className="visitor-refresh"><span role="status">{model.loading?'Aufrufe werden geladen …':data?`Stand: ${visitorTime(data.generatedAt)} · Berlin`:'Noch kein aktueller Stand'}</span><button className="btn" disabled={model.loading} onClick={()=>void controller.current?.load()}><RefreshCw size={15} aria-hidden="true"/>Aktualisieren</button></div></section>
    <IntegrationError error={model.error}/>
    <div className="visitor-stats" aria-busy={model.loading}>{values.map(([label,value,Icon,detail])=><section className="panel visitor-stat" key={label}><div><span>{label}</span><Icon size={18} aria-hidden="true"/></div><strong>{value===undefined?'—':number(value)}</strong><small>{detail}</small></section>)}</div>
    {data?<>
      {data.partial&&<div className="notice visitor-warning" role="status">Die Erfassung ist teilweise unvollständig. Aufrufe oder Besucher können fehlen; die angezeigten Zahlen sind keine vollständige Reichweitenmessung.</div>}
      <div className="visitor-report-grid">
        <section className="panel visitor-section"><div className="visitor-section-heading"><div><span className="admin-overline">TAG FÜR TAG</span><h2>Dein Besucherverlauf</h2></div><span className="visitor-period">{visitorDate(data.daily[0].date)} – {visitorDate(data.today.date,true)}</span></div>
          {data.period.views>0?<DailyChart daily={data.daily}/>:<IntegrationEmpty title="Noch keine Gäste-Aufrufe">In diesem Zeitraum wurden noch keine Aufrufe ohne Anmeldung gezählt. Sobald Gäste deine Website besuchen, erscheint hier der Verlauf.</IntegrationEmpty>}
          <details className="visitor-table-details"><summary>Tageswerte als Tabelle</summary><div className="visitor-table-wrap"><table className="visitor-table"><caption className="sr-only">Tageswerte der Website, Zeitzone Berlin</caption><thead><tr><th scope="col">Datum</th><th scope="col">Aufrufe</th><th scope="col">Besucher (geschätzt)</th></tr></thead><tbody>{[...data.daily].reverse().map(day=><tr key={day.date}><th scope="row">{visitorDate(day.date,true)}</th><td>{number(day.views)}</td><td>{number(day.visitors)}</td></tr>)}</tbody></table></div></details>
        </section>
        <section className="panel visitor-section"><div className="visitor-section-heading"><div><span className="admin-overline">DEINE SEITEN</span><h2>Am häufigsten aufgerufen</h2></div></div><p className="visitor-subtitle">Gäste-Aufrufe in den letzten {model.days} Tagen</p>
          {data.pages.length?<ol className="visitor-pages">{data.pages.map((page,index)=><li key={page.path}><div className="visitor-page-rank">{String(index+1).padStart(2,'0')}</div><div className="visitor-page-name"><strong>{page.label}</strong><span>{page.path}</span><div className="visitor-page-track" aria-hidden="true"><i style={{width:`${page.views/maxPageViews*100}%`}}/></div></div><span className="visitor-page-count">{number(page.views)}<small>Aufrufe</small></span></li>)}</ol>:<IntegrationEmpty title="Noch keine Seiten gezählt">Die beliebtesten Seiten erscheinen nach den ersten Gäste-Aufrufen.</IntegrationEmpty>}
        </section>
      </div>
      <section className="panel visitor-method"><ShieldCheck size={22} aria-hidden="true"/><div><h2>Was diese Zahlen bedeuten</h2><p>Gezählt werden die bereits erfassten öffentlichen Seiten ohne Anmeldung. Geschützte Bereiche und nicht eingebundene Seiten sind nicht enthalten, ebenso wenig angemeldete Mitglieder, erkannte Bots und Vorab-Ladevorgänge. Die Statistik verwendet keine zusätzlichen Cookies und keine externen Analyse-Dienste.</p><p>Besucher werden pro Tag anhand der Netzwerkadresse geschätzt. Mehrere Personen im selben Netzwerk können als ein Besucher zählen; wechselnde Adressen können mehrfach zählen. Die Zahl ist keine eindeutige Personenzählung über mehrere Tage.</p><p>Erfassung seit <strong>{visitorTime(data.startedAt)} Uhr (Berlin)</strong>. Tagesverlauf und Seitenübersicht umfassen höchstens {data.retentionDays} Tage; die Gesamtzahl bleibt erhalten. Frühere Aufrufe werden nicht nachträglich ergänzt.</p><small>Diese Ansicht aktualisiert sich alle 60 Sekunden, solange sie sichtbar ist.</small></div></section>
    </>:<section className="panel visitor-section"><IntegrationEmpty title={model.loading?'Die Statistik wird abgerufen …':model.error?'Aufrufstatistik nicht verfügbar':'Noch keine Statistik geladen'}>{model.loading?'Deine gespeicherten Website-Zahlen werden geladen.':model.error?'Prüfe deine Website-Verbindung und versuche „Aktualisieren“. Es werden keine Beispielzahlen angezeigt.':'Öffne „Aktualisieren“, um die aktuellen Zahlen abzurufen.'}</IntegrationEmpty></section>}
  </div>;
}

export default function VisitorStatsPage(props) {
  if(props.site?.connected&&props.site.user?.isAdmin===false)return <section className="panel empty-state"><ShieldCheck size={34}/><h2>Nur für Website-Administratoren</h2><p>Die Aufrufstatistik ist ausschließlich mit deinem bestätigten Administratorkonto verfügbar.</p><button className="btn btn-primary site-space" onClick={()=>props.navigate('website')}>Konto & Bot öffnen</button></section>;
  return <WebsiteAdminGate {...props} Content={VisitorStatsContent}/>;
}

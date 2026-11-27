window.__ModuleLoader__.load({
  id: '@local/myreels-studio',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useReducer, useRef, useState } = React;

    const STAGES = {
      CREATED: ['已创建', '--dsw-alias-state-idle-primary'],
      SETTINGS_PENDING: ['待项目设置', '--dsw-alias-state-warn-primary'],
      ANALYSIS_PENDING: ['待确认分析', '--dsw-alias-state-warn-primary'],
      ANALYSIS_SUBMITTED: ['分析已提交', '--dsw-alias-state-warn-primary'],
      ANALYZING: ['分析中', '--dsw-alias-state-warn-primary'],
      ANALYSIS_DONE: ['分析完成', '--dsw-alias-state-success-primary'],
      ASSETS_DONE: ['资产完成', '--dsw-alias-state-success-primary'],
      SHOTS_DONE: ['分镜完成', '--dsw-alias-state-success-primary'],
      RENDERED: ['已出片', '--dsw-alias-state-success-primary'],
      FAILED: ['失败', '--dsw-alias-state-error-primary'],
    };

    function stageOf(stage) {
      return STAGES[stage] || [stage || '未知', '--dsw-alias-state-idle-primary'];
    }

    function formatTime(value) {
      if (!value) return '';
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString();
    }

    function makePanel(ctx, t, styles) {
      return function MyReelsPanel() {
        const [, force] = useReducer((x) => x + 1, 0);
        useEffect(() => ctx.locale.subscribe(force), []);
        const [data, setData] = useState({ loading: true, error: '', runs: [], webBaseUrl: '' });
        const [selected, setSelected] = useState('');
        const [detail, setDetail] = useState({ loading: false, error: '', data: null });
        const [report, setReport] = useState({ loading: false, error: '', path: '', content: '' });
        const [showVideo, setShowVideo] = useState(false);
        const [autonomyOpen, setAutonomyOpen] = useState(false);
        const [projectSettingsId, setProjectSettingsId] = useState('');
        const [assetPreviewId, setAssetPreviewId] = useState('');
        const [previewSrc, setPreviewSrc] = useState('');
        const [previewRefreshing, setPreviewRefreshing] = useState(false);
        const [previewError, setPreviewError] = useState('');
        const [loggingOut, setLoggingOut] = useState(false);
        const [authOpen, setAuthOpen] = useState(false);
        const [authReady, setAuthReady] = useState(false);
        const [authTimedOut, setAuthTimedOut] = useState(false);
        const [authExternal, setAuthExternal] = useState(false);
        const [authFrameKey, setAuthFrameKey] = useState(0);
        const [quotaOpen, setQuotaOpen] = useState(false);
        const [navigating, setNavigating] = useState(false);
        const [expandedProjectId, setExpandedProjectId] = useState('');
        const detailSeq = useRef(0);
        const pointsRetryRef = useRef(0);
        const expandedInit = useRef(false);
        const projectSettingsFrame = useRef(null);
        useEffect(() => {
          if (expandedInit.current || !data.runs.length) return;
          expandedInit.current = true;
          const first = (data.runs.find((r) => r.runId === selected) || data.runs[0]);
          setExpandedProjectId(first?.projectId || `run:${first?.runId || ''}`);
        }, [data.runs, selected]);
        const load = () => {
          setData((prev) => ({ ...prev, loading: true, error: '' }));
          fetch('/plugins/myreels-studio/runs', { headers: { Accept: 'application/json' } })
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            })
            .then((json) => {
              const nextPoints = Number.isFinite(Number(json?.pointsBalance))
                ? Number(json.pointsBalance)
                : null;
              const shouldRetryPoints = Boolean(json?.auth && !json.auth.loggedOut)
                && (nextPoints === null || nextPoints === 0);
              if (!shouldRetryPoints) pointsRetryRef.current = 0;
              setData((prev) => {
                const keepPrevious = shouldRetryPoints
                  && pointsRetryRef.current < 2;
                return {
                  loading: false,
                  error: '',
                  runs: Array.isArray(json?.runs) ? json.runs : [],
                  projects: Array.isArray(json?.projects) ? json.projects : [],
                  auth: json?.auth || null,
                  profile: json?.profile || null,
                  pointsBalance: keepPrevious
                    ? (Number.isFinite(prev.pointsBalance) ? prev.pointsBalance : null)
                    : (nextPoints ?? prev.pointsBalance),
                  webBaseUrl: String(json?.webBaseUrl || ''),
                  autonomy: json?.autonomy || null,
                };
              });
              if (shouldRetryPoints && pointsRetryRef.current < 2) {
                pointsRetryRef.current += 1;
                setTimeout(load, 1200);
              }
            })
            .catch((err) => setData((prev) => ({ ...prev, loading: false, error: String(err?.message || err), runs: [], projects: [], auth: null, profile: null, autonomy: null })));
        };
        const refreshAssetPreview = async () => {
          if (!assetPreviewId || previewRefreshing) return;
          setPreviewRefreshing(true);
          setPreviewError('');
          try {
            const url = `/plugins/myreels-studio/project-preview?projectId=${encodeURIComponent(assetPreviewId)}&embed=1&generate=1&_=${Date.now()}`;
            const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const finalUrl = new URL(res.url || url, window.location.href);
            setPreviewSrc(`${finalUrl.pathname}${finalUrl.search}`);
          } catch (error) {
            setPreviewError(String(error?.message || error));
          } finally {
            setPreviewRefreshing(false);
          }
        };
        const openRun = (runId) => {
          const seq = ++detailSeq.current;
          setSelected(runId);
          setReport({ loading: false, error: '', path: '', content: '' });
          setShowVideo(false);
          setDetail({ loading: true, error: '', data: null });
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30000);
          fetch(`/plugins/myreels-studio/runs/${runId}`, { headers: { Accept: 'application/json' }, signal: controller.signal })
            .then((res) => {
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return res.json();
            })
            .then((json) => { if (seq === detailSeq.current) setDetail({ loading: false, error: '', data: json }); })
            .catch((err) => {
              if (seq !== detailSeq.current) return;
              const message = err?.name === 'AbortError' ? '读取任务详情超时，请重试' : String(err?.message || err);
              setDetail({ loading: false, error: message, data: null });
            })
            .finally(() => clearTimeout(timer));
        };
        const deleteRun = (runId) => {
          if (!window.confirm(t('deleteConfirm'))) return;
          fetch(`/plugins/myreels-studio/runs/${encodeURIComponent(runId)}/local`, { method: 'DELETE' })
            .then(async (res) => {
              const json = await res.json().catch(() => null);
              if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`);
              if (selected === runId) {
                setSelected('');
                setDetail({ loading: false, error: '', data: null });
              }
              load();
            })
            .catch((err) => setData((prev) => ({ ...prev, error: String(err?.message || err) })));
        };
        const openReport = (runId) => {
          setReport({ loading: true, error: '', path: '', content: '' });
          fetch(`/plugins/myreels-studio/report/${runId}`, { headers: { Accept: 'application/json' } })
            .then(async (res) => {
              const json = await res.json().catch(() => null);
              if (!res.ok) throw new Error(json?.hint || json?.error || `HTTP ${res.status}`);
              return json;
            })
            .then((json) => setReport({ loading: false, error: '', path: json?.path || '', content: json?.content || '' }))
            .catch((err) => setReport({ loading: false, error: String(err?.message || err), path: '', content: '' }));
        };
        const logout = () => {
          if (!window.confirm(t('logoutConfirm'))) return;
          setLoggingOut(true);
          fetch('/plugins/myreels-studio/logout', { method: 'POST' })
            .then(() => {
              setData((prev) => ({
                ...prev,
                runs: [],
                projects: [],
                profile: null,
                pointsBalance: null,
                auth: { ...(prev.auth || {}), loggedOut: true, hasToken: false, userId: '', username: '' },
              }));
              window.location.reload();
            })
            .catch((err) => setData((prev) => ({ ...prev, error: String(err?.message || err) })))
            .finally(() => setLoggingOut(false));
        };
        const markAuthenticated = () => setData((prev) => ({ ...prev, loading: true, error: '', auth: { ...(prev.auth || {}), loggedOut: false, hasToken: true } }));
        const openExternalLogin = () => {
          setAuthTimedOut(false);
          setAuthReady(false);
          setAuthExternal(true);
          fetch('/plugins/myreels-studio/auth/open', { method: 'POST' })
            .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); })
            .catch((err) => {
              setAuthExternal(false);
              setAuthFrameKey(Date.now());
              setData((prev) => ({ ...prev, error: String(err?.message || err) }));
            });
        };
        const loginAgain = () => {
          setAuthReady(false);
          setAuthTimedOut(false);
          setAuthFrameKey(Date.now());
          setAuthOpen(true);
          openExternalLogin();
        };
        const toggleAutonomy = (id, enabled) => {
          const item = (data.autonomy?.items || []).find((x) => x.id === id);
          if (!item || item.locked) return;
          fetch('/plugins/myreels-studio/autonomy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ id, enabled }),
          })
            .then(async (res) => {
              const json = await res.json().catch(() => null);
              if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
              setData((prev) => ({ ...prev, autonomy: json }));
            })
            .catch((err) => setData((prev) => ({ ...prev, error: String(err?.message || err) })));
        };
        useEffect(() => {
          const onAuthMessage = (event) => {
            const origin = String(event.origin || '');
            const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
            const configuredOrigin = (() => {
              try {
                return data.webBaseUrl ? new URL(data.webBaseUrl).origin : '';
              } catch {
                return '';
              }
            })();
            const officialOrigin = origin === 'https://myreels.tv' || origin === 'https://www.myreels.tv'
              || origin === 'https://myreels.ai' || origin === 'https://www.myreels.ai';
            if (origin !== window.location.origin && !loopback && origin !== configuredOrigin && !officialOrigin) return;
            const type = event.data?.type;
            if (type === 'myreels-auth-ready') {
              setAuthReady(true);
              setAuthTimedOut(false);
              return;
            }
            if (type === 'myreels-auth-ok') {
              setAuthOpen(false);
              markAuthenticated();
              load();
              return;
            }
            if (type === 'myreels-auth-code') {
              const code = String(event.data?.code || '');
              const state = String(event.data?.state || '');
              if (!code) return;
              fetch(`/plugins/myreels-studio/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&lang=${encodeURIComponent(String(event.data?.lang || ''))}`, { headers: { Accept: 'text/html' } })
                .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); setAuthOpen(false); markAuthenticated(); load(); })
                .catch((err) => setData((prev) => ({ ...prev, error: String(err?.message || err) })));
            }
          };
          window.addEventListener('message', onAuthMessage);
          return () => window.removeEventListener('message', onAuthMessage);
        }, [data.webBaseUrl]);
        useEffect(() => {
          if (!authOpen || authReady || authExternal) return;
          const timer = setTimeout(() => setAuthTimedOut(true), 20000);
          return () => clearTimeout(timer);
        }, [authOpen, authReady, authExternal, authFrameKey]);

        useEffect(() => {
          if (!authOpen) return;
          let stopped = false;
          const timer = setInterval(async () => {
            try {
              const res = await fetch('/plugins/myreels-studio/runs', { headers: { Accept: 'application/json' } });
              const json = await res.json();
              if (!stopped && json?.auth && !json.auth.loggedOut) {
                setAuthOpen(false);
                markAuthenticated();
                load();
              }
            } catch {
              /* keep waiting */
            }
          }, 1500);
          return () => { stopped = true; clearInterval(timer); };
        }, [authOpen]);

        useEffect(() => { load(); }, []);

        const formatNumber = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '--';
        const loggedOut = !data.auth || data.auth.loggedOut === true;
        const authPending = Boolean(data.loading) && !data.auth;
        const quota = loggedOut ? null : (data.profile?.quota || null);
        const authIdentity = data.auth?.operatorType === 'subaccount'
          ? (data.auth?.operatorLabel || data.auth?.username)
          : data.auth?.username;
        const displayName = loggedOut ? '' : (data.profile?.displayName || data.profile?.username || authIdentity || (data.auth?.userId ? `${t('userFallback')} ${data.auth.userId}` : ''));
        const header = h('div', { style: styles.header },
          h('div', null,
            h('h1', { style: styles.title }, t('panelTitle')),
            h('div', { style: styles.subtitle }, t('panelSubtitle')),
          ),
          h('div', { style: styles.userInfo },
            displayName
              ? h('span', { style: styles.userName }, displayName)
              : null,
            !loggedOut && Number.isFinite(data.pointsBalance)
              ? h('div', {
                  style: styles.quotaWrap,
                  onMouseEnter: () => setQuotaOpen(true),
                  onMouseLeave: () => setQuotaOpen(false),
                },
                  h('span', { style: styles.points, title: quota ? t('quotaDetails') : undefined }, `${formatNumber(data.pointsBalance)} ${t('pointsUnit')}`),
                  quotaOpen && quota
                    ? h('div', { style: styles.quotaPanel },
                        h('div', { style: styles.quotaRow },
                          h('span', { style: styles.quotaLabel }, t('quotaMonthlyRemaining')),
                          h('span', { style: styles.quotaValueStrong }, formatNumber(quota.monthlyRemaining)),
                        ),
                        h('div', { style: styles.quotaRow },
                          h('span', { style: styles.quotaLabel }, t('quotaMonthlyUsed')),
                          h('span', { style: styles.quotaValue }, `${formatNumber(quota.monthlyUsed)} / ${formatNumber(quota.monthlyQuota)}`),
                        ),
                        h('div', { style: styles.quotaRow },
                          h('span', { style: styles.quotaLabel }, t('quotaWeeklyRemaining')),
                          h('span', { style: styles.quotaValueStrong }, formatNumber(quota.weeklyRemaining)),
                        ),
                        h('div', { style: styles.quotaRow },
                          h('span', { style: styles.quotaLabel }, t('quotaWeeklyUsed')),
                          h('span', { style: styles.quotaValue }, `${formatNumber(quota.weeklyUsed)} / ${formatNumber(quota.weeklyQuota)}`),
                        ),
                      )
                    : null,
                )
              : null,
          ),
          h('div', { style: { display: 'flex', gap: '8px' } },
            data.autonomy && !loggedOut
              ? h('button', {
                  type: 'button',
                  style: autonomyOpen ? { ...styles.button, ...styles.buttonActive } : styles.button,
                  onClick: () => setAutonomyOpen((v) => !v),
                  'aria-expanded': autonomyOpen,
                }, `${t('autonomy')} ${autonomyOpen ? '▴' : '▾'}`)
              : null,
            loggedOut && !authPending
              ? h('button', { type: 'button', style: styles.button, onClick: loginAgain }, t('loginAgain'))
              : h('button', { type: 'button', style: styles.dangerButton, onClick: logout, disabled: loggingOut }, loggingOut ? t('loggingOut') : t('logout')),
          ),
        );

        const refreshTasksButton = h('button', {
          type: 'button',
          style: styles.refreshIconButton,
          title: t('refresh'),
          'aria-label': t('refresh'),
          onClick: load,
          disabled: Boolean(data.loading),
        }, data.loading ? '…' : '↻');
        let body;
        if (authPending) {
          body = h('div', { style: styles.muted }, t('loading'));
        } else if (loggedOut) {
          body = h('div', { style: styles.settings },
            h('div', { style: styles.detailTitle }, t('loggedOutTitle')),
            h('div', { style: styles.muted }, t('loggedOutHint')),
          );
        } else if (data.loading && !data.runs.length) {
          body = h('div', { style: styles.muted }, t('loading'));
        } else if (data.error) {
          body = h('div', { style: styles.error }, `${t('loadFailed')}: ${data.error}`, h('div', { style: { marginTop: '10px' } }, refreshTasksButton));
        } else if (!data.runs.length && !(data.projects || []).length) {
          body = h('div', { style: styles.empty }, t('empty'), h('div', { style: { marginTop: '10px' } }, refreshTasksButton));
        } else {
          const groups = [];
          const byProject = new Map();
          for (const run of data.runs) {
            const key = run.projectId || `run:${run.runId}`;
            if (!byProject.has(key)) {
              const group = { key, projectId: run.projectId || '', title: run.title || run.projectId || run.runId, runs: [] };
              byProject.set(key, group);
              groups.push(group);
            }
            byProject.get(key).runs.push(run);
          }
          for (const project of data.projects || []) {
            const key = String(project.projectId || '');
            if (!key || byProject.has(key)) continue;
            const group = { key, projectId: key, title: project.title || key, runs: [] };
            byProject.set(key, group);
            groups.push(group);
          }
          const remoteById = new Map((data.projects || []).map((project) => [String(project.projectId || ''), project]));
          for (const group of groups) {
            group.runs.sort((a, b) => (Number(a.episodeNo) || 0) - (Number(b.episodeNo) || 0));
            group.episodeCount = Number(remoteById.get(String(group.projectId || ''))?.episodeCount) || 0;
          }
          const currentProjectId = ((data.runs || []).find((r) => r.runId === selected) || {}).projectId
            || groups.find((g) => g.key === expandedProjectId)?.projectId
            || groups[0]?.projectId
            || '';
          body = h('div', { style: styles.table }, [
            h('div', { key: 'head', style: styles.rowHead },
              h('span', { style: styles.colEpisode }, t('colEpisode')),
              h('span', { style: styles.colStage }, t('colStage')),
              h('span', { style: styles.colTime }, t('colUpdated')),
              h('span', { style: styles.colActions }, t('colActions')),
            ),
            h('div', { key: 'hint', style: styles.tableHint },
              h('span', null, t('episodeCountHint')),
              refreshTasksButton,
            ),
            ...groups.flatMap((group) => {
              const isCurrentProject = Boolean(group.projectId) && group.projectId === currentProjectId;
              const isExpanded = expandedProjectId === group.key;
              const head = h('div', {
                key: `group:${group.key}`,
                style: { ...styles.groupHead, cursor: 'pointer', background: isCurrentProject ? 'rgba(37,99,235,0.08)' : 'var(--dsw-alias-bg-layer-2)', borderLeft: isCurrentProject ? '3px solid var(--dsw-alias-brand-primary)' : '3px solid transparent' },
                onClick: () => {
                  const opening = expandedProjectId !== group.key;
                  setExpandedProjectId(opening ? group.key : '');
                  if (opening && group.runs[0]) openRun(group.runs[0].runId);
                },
              },
                h('span', { style: styles.groupArrow }, isExpanded ? '▾' : '▸'),
                h('span', { style: styles.groupTitle }, group.title),
                isCurrentProject ? h('span', { style: styles.currentBadge }, t('currentProject')) : null,
                h('span', { style: styles.groupMeta }, group.episodeCount > group.runs.length ? `${group.runs.length}/${group.episodeCount} 集` : `${group.runs.length} 集`),
                h('span', { style: { flex: 1 } }),
                group.projectId ? h('button', { type: 'button', style: { ...styles.projectLinkButton, marginRight: '10px' }, onClick: (event) => { event.stopPropagation(); setPreviewSrc(''); setPreviewError(''); setPreviewRefreshing(false); setAssetPreviewId(group.projectId); } }, t('previewAssets')) : null,
                group.projectId ? h('button', { type: 'button', style: styles.projectLinkButton, onClick: (event) => { event.stopPropagation(); setProjectSettingsId(group.projectId); } }, t('projectSettings')) : null,
              );
              const rows = group.runs.map((run) => {
                const [label, token] = stageOf(run.stage);
                const active = run.runId === selected;
                return h('div', {
                  key: run.runId,
                  style: {
                    ...styles.episodeRow,
                    cursor: 'pointer',
                    background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                    borderLeft: active ? '3px solid var(--dsw-alias-brand-primary)' : '3px solid transparent',
                  },
                  onClick: () => openRun(run.runId),
                },
                  h('span', { style: styles.colEpisode, title: run.runId },
                    h('div', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, run.episodeNo ? `EP ${run.episodeNo}` : '--'),
                    h('div', { style: { fontSize: '11px', opacity: 0.6 } }, run.runId.slice(0, 8)),
                  ),
                  h('span', { style: styles.colStage },
                    h('span', { style: { ...styles.badge, color: `var(${token})`, borderColor: `var(${token})` } }, label),
                  ),
                  h('span', { style: styles.colTime }, formatTime(run.updatedAt)),
                  h('span', { style: styles.colActions },
                    h('button', {
                      type: 'button',
                      style: styles.dangerButton,
                      onClick: (event) => { event.stopPropagation(); deleteRun(run.runId); },
                    }, t('delete')),
                  ),
                );
              });
              return isExpanded ? [head, ...rows] : [head];
            }),
          ]);
        }

        const detailRow = (key, value) => h('div', { key, style: styles.detailRow },
          h('span', { style: styles.detailLabel }, key),
          h('span', { style: styles.detailValue }, String(value)),
        );
        const detailCard = selected
          ? h('div', { style: styles.detail },
              h('div', { style: styles.detailHead },
                h('div', { style: styles.detailTitle }, `${t('detailTitle')} · ${selected.slice(0, 8)}`),
                h('div', { style: { display: 'flex', gap: '8px' } },
                  detail.data?.reportExists
                    ? h('button', { type: 'button', style: styles.button, onClick: () => openReport(selected) }, t('viewReport'))
                    : null,
                  detail.data?.renderPath
                    ? h('button', { type: 'button', style: styles.button, onClick: () => setShowVideo((v) => !v) }, showVideo ? t('hideVideo') : t('previewVideo'))
                    : null,
                  h('button', { type: 'button', style: styles.button, onClick: () => setSelected('') }, t('close')),
                ),
              ),
              detail.loading
                ? h('div', { style: styles.muted }, t('detailLoading'))
                : detail.error
                  ? h('div', { style: styles.error }, `${t('loadFailed')}: ${detail.error}`)
                  : h('div', { style: styles.detailGrid },
                      detailRow(t('detailEpisode'), detail.data?.episodeNo ? `EP ${detail.data.episodeNo}` : '--'),
                      detailRow(t('detailAssets'), `${detail.data?.assetsWithImage ?? '-'} / ${detail.data?.assetsCount ?? '-'}`),
                      detailRow(t('detailShots'), `${detail.data?.videoCount ?? '-'} / ${detail.data?.shotsCount ?? '-'}`),
                      detailRow(t('detailNext'), detail.data?.nextAction || '--'),
                      detail.data?.renderPath ? detailRow(t('detailRender'), detail.data.renderPath) : null,
                      detail.data?.subtitlePath ? detailRow(t('detailSubtitle'), detail.data.subtitlePath) : null,
                      detail.data?.liveError ? detailRow(t('detailLiveError'), detail.data.liveError) : null,
                    ),
              showVideo && detail.data?.renderPath
                ? h('video', {
                    key: 'preview',
                    controls: true,
                    preload: 'metadata',
                    src: `/plugins/myreels-studio/media/${selected}.mp4`,
                    style: styles.video,
                  })
                : null,
              report.loading
                ? h('div', { style: styles.muted }, t('reportLoading'))
                : report.error
                  ? h('div', { style: styles.reportError }, `${t('reportFailed')}: ${report.error}`)
                  : report.content
                    ? h('div', { style: styles.reportBox },
                        h('div', { style: styles.reportPath }, report.path),
                        h('pre', { style: styles.reportPre }, report.content),
                      )
                    : null,
            )
          : null;

        const embedProjectId = projectSettingsId || assetPreviewId;
        const embedKind = projectSettingsId ? 'settings' : 'preview';
        const embeddedPanel = embedProjectId
          ? h('div', { style: styles.projectEmbed },
              h('div', { style: styles.projectEmbedHead },
                h('div', { style: styles.detailTitle }, embedKind === 'settings' ? t('projectSettings') : t('previewAssets')),
                h('div', { style: { display: 'flex', gap: '8px' } },
                  embedKind === 'settings'
                    ? h('button', {
                        type: 'button',
                        style: styles.button,
                        onClick: () => projectSettingsFrame.current?.contentWindow?.postMessage(
                          { type: 'myreels-save-project-settings' },
                          '*'
                        ),
                      }, t('save'))
                    : h('button', {
                        type: 'button',
                        style: styles.button,
                        disabled: previewRefreshing,
                        onClick: refreshAssetPreview,
                      }, previewRefreshing ? t('refreshing') : t('refreshPreview')),
                  h('button', {
                    type: 'button',
                    style: styles.button,
                    onClick: () => { setProjectSettingsId(''); setAssetPreviewId(''); setPreviewSrc(''); setPreviewError(''); setPreviewRefreshing(false); },
                  }, t('close')),
                ),
              ),
              h('div', { style: { position: 'relative' } },
                h('iframe', {
                  ref: embedKind === 'settings' ? projectSettingsFrame : null,
                  title: embedKind === 'settings' ? t('projectSettings') : t('previewAssets'),
                  src: embedKind === 'settings'
                    ? `/plugins/myreels-studio/project-settings?projectId=${encodeURIComponent(embedProjectId)}&embed=1`
                    : (previewSrc || `/plugins/myreels-studio/project-preview?projectId=${encodeURIComponent(embedProjectId)}&embed=1`),
                  style: styles.projectEmbedFrame,
                }),
                embedKind === 'preview' && (previewRefreshing || previewError)
                  ? h('div', {
                      style: {
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '10px',
                        background: 'rgba(247,248,250,.9)',
                        zIndex: 10,
                        fontSize: '13px',
                        color: previewError ? '#b91c1c' : 'var(--dsw-alias-label-primary)',
                        padding: '24px',
                        textAlign: 'center',
                      },
                    },
                      previewRefreshing ? h('div', { style: styles.loadingSpinner }) : null,
                      h('div', null, previewError || t('refreshing')),
                    )
                  : null,
              ),
            )
          : null;

        const autonomyPanel = autonomyOpen && data.autonomy
          ? h('div', { style: styles.autonomyPanel },
              h('div', { style: styles.autonomyHead },
                h('div', null,
                  h('div', { style: styles.detailTitle }, t('autonomyTitle')),
                  h('div', { style: styles.autonomyHint }, t('autonomyHint')),
                ),
              ),
              h('div', { style: styles.autonomyList },
                ...(data.autonomy.items || []).map((item) => h('label', { key: item.id, style: { ...styles.autonomyItem, opacity: item.locked ? 0.7 : 1 } },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(item.enabled),
                    disabled: Boolean(item.locked),
                    onChange: (event) => toggleAutonomy(item.id, event.target.checked),
                  }),
                  h('span', { style: styles.autonomyText },
                    h('span', { style: styles.autonomyLabel }, `${item.label}${item.locked ? ` · ${t('autonomyLocked')}` : ''}`),
                    h('span', { style: styles.autonomyDesc }, item.description),
                  ),
                )),
              ),
            )
          : null;

        const authPanel = authOpen
          ? h('div', { style: styles.authOverlay },
              h('div', { style: styles.authCard },
                h('div', { style: styles.authHead },
                  h('div', { style: styles.detailTitle }, t('loginTitle')),
                  h('div', { style: { display: 'flex', gap: '8px' } },
                    h('button', { type: 'button', style: styles.button, onClick: openExternalLogin }, t('openInBrowser')),
                    h('button', { type: 'button', style: styles.button, onClick: () => setAuthOpen(false) }, t('close')),
                  ),
                ),
                authTimedOut
                  ? h('div', { style: styles.authError },
                      h('div', { style: styles.detailTitle }, t('loginTimeoutTitle')),
                      h('div', { style: styles.authErrorHint }, t('loginTimeoutHint')),
                      h('div', { style: styles.authErrorUrl }, data.webBaseUrl || '—'),
                      h('div', { style: styles.authActions },
                        h('button', {
                          type: 'button',
                          style: styles.button,
                          onClick: () => {
                            setAuthTimedOut(false);
                            setAuthReady(false);
                            setAuthFrameKey(Date.now());
                          },
                        }, t('retry')),
                        h('button', {
                          type: 'button',
                          style: styles.button,
                          onClick: () => window.open('/plugins/myreels-studio/auth/start', '_blank', 'noopener'),
                        }, t('openInBrowser')),
                      ),
                    )
                  : authExternal
                    ? h('div', { style: styles.authExternalWait },
                        h('div', { style: styles.loadingSpinner }),
                        h('div', { style: styles.detailTitle }, t('loginWindowOpened')),
                        h('div', { style: styles.authErrorHint }, t('loginWindowHint')),
                        h('div', { style: styles.authActions },
                          h('button', { type: 'button', style: styles.button, onClick: loginAgain }, t('reopenLoginWindow')),
                          h('button', { type: 'button', style: styles.button, onClick: () => setAuthOpen(false) }, t('close')),
                        ),
                      )
                    : h('div', { style: styles.authBody },
                      h('iframe', {
                        key: authFrameKey,
                        title: 'MyReels Login',
                        src: `/plugins/myreels-studio/auth/start?_t=${authFrameKey}`,
                        style: styles.authFrame,
                      }),
                      !authReady
                        ? h('div', { style: styles.authLoading },
                            h('div', { style: styles.loadingSpinner }),
                            h('div', { style: styles.authLoadingText }, t('loginLoading')),
                          )
                        : null,
                    ),
              ),
            )
          : null;

        return h('div', { style: styles.page },
          navigating ? h('div', { style: styles.loadingOverlay },
            h('style', null, '@keyframes myreels-spin{to{transform:rotate(360deg)}}'),
            h('div', { style: styles.loadingSpinner }),
            h('div', null, t('loadingProject')),
          ) : null,
          authPanel, header, embeddedPanel ? null : autonomyPanel, embeddedPanel || body, embeddedPanel ? null : detailCard);
      };
    }

    function makeIcon(ctx, styles) {
      return function MyReelsIcon(props) {
        const size = props?.size || 20;
        const color = props?.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
        return h('svg', {
          width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true,
          style: { display: 'block', color },
        },
          h('rect', { x: 3, y: 7, width: 18, height: 13, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M3 11h18', stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M7 7l2-3M12 7l2-3M17 7l2-3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('circle', { cx: 8, cy: 15, r: 1.2, fill: 'currentColor' }),
          h('circle', { cx: 12, cy: 15, r: 1.2, fill: 'currentColor' }),
          h('circle', { cx: 16, cy: 15, r: 1.2, fill: 'currentColor' }),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.locale.register('myreels-studio', 'en', {
          nav: 'MyReels Studio',
          panelTitle: 'MyReels Studio',
          autonomy: 'Autonomy',
          autonomyTitle: 'Autonomous optimization',
          autonomyHint: 'Global switches. Disabled capabilities are not applied automatically; you can still run them manually in chat.',
          autonomyLocked: 'locked',
          panelSubtitle: 'Local run state, read-only. Open a conversation and ask the agent to advance a run.',
          projectSettings: 'Project settings',
          previewAssets: 'Asset preview',
          logout: 'Log out',
          loggingOut: 'Signing out...',
          logoutConfirm: 'Log out of MyReels Studio on this device? Project files are not deleted.',
          loggedOutTitle: 'Logged out',
          loginTitle: 'Sign in with MyReels',
          userFallback: 'User',
          quotaDetails: 'Monthly / weekly quota',
          quotaMonthlyRemaining: 'Monthly remaining',
          quotaMonthlyUsed: 'Monthly used',
          quotaWeeklyRemaining: 'Weekly remaining',
          quotaWeeklyUsed: 'Weekly used',
          loginLoading: 'Loading sign-in page…',
          loginTimeoutTitle: 'Sign-in page timed out',
          loginTimeoutHint: 'The configured MyReels sign-in page did not finish loading. Check webBaseUrl, then retry.',
          retry: 'Retry',
          openInBrowser: 'Open in browser',
          loginWindowOpened: 'Sign-in window opened',
          loginWindowHint: 'Complete sign-in in the opened window. This panel closes automatically when login succeeds.',
          reopenLoginWindow: 'Reopen sign-in window',
          oauthBrowserHint: 'WeChat or QR sign-in may not return inside this panel; open it in a browser.',
          loggedOutHint: 'Plugin login state is cleared. Project files were not deleted.',
          loginAgain: 'Log in again',
          pointsUnit: 'pts',
          refresh: 'Refresh tasks',
          refreshPreview: 'Refresh asset preview',
          refreshing: 'Refreshing…',
          loading: 'Loading runs...',
          loadFailed: 'Failed to load runs',
          empty: 'No runs yet. Ask the agent to start one with myreels_run_start.',
          colRun: 'Run',
          colEpisode: 'Episode',
          colStage: 'Stage',
          colUpdated: 'Updated',
          colActions: 'Actions',
          delete: 'Delete',
          deleteConfirm: 'Delete all local files for this run? WebUI story data will not be deleted.',
          currentProject: 'Current project',
          episodeCountHint: 'Episode count means attached / total in the story desk. Unattached episodes stay in WebUI; open one when you need to manage it locally.',
          loadingProject: 'Loading project settings…',
          detailTitle: 'Run detail',
          detailEpisode: 'Episode',
          detailAssets: 'Assets with image / total',
          detailShots: 'Videos / shots',
          detailNext: 'Next step',
          detailLiveError: 'Live query',
          detailRender: 'Episode cut',
          detailSubtitle: 'Subtitles',
          detailLoading: 'Loading detail...',
          save: 'Save',
          close: 'Close',
          viewReport: 'View report',
          reportLoading: 'Loading report...',
          reportFailed: 'Report unavailable',
          previewVideo: 'Preview cut',
          hideVideo: 'Hide preview',
        });
        ctx.locale.register('myreels-studio', 'zh', {
          nav: 'MyReels Studio',
          panelTitle: 'MyReels Studio 任务',
          autonomy: '自主优化',
          autonomyTitle: '自主优化开关',
          autonomyHint: '全局生效。关闭的能力不会自动执行，但仍可在聊天中手动要求处理。',
          autonomyLocked: '固定开启',
          panelSubtitle: '本机 run 状态，只读展示；在会话里让智能体推进任务。',
          projectSettings: '项目设置',
          previewAssets: '资产预览',
          logout: '退出登录',
          loggingOut: '正在退出…',
          logoutConfirm: '退出 MyReels Studio 插件登录？不会删除项目文件。',
          loggedOutTitle: '已退出登录',
          loginTitle: '登录 MyReels',
          userFallback: '用户',
          quotaDetails: '本月 / 本周额度',
          quotaMonthlyRemaining: '本月剩余',
          quotaMonthlyUsed: '本月已用',
          quotaWeeklyRemaining: '本周剩余',
          quotaWeeklyUsed: '本周已用',
          loginLoading: '正在加载登录页…',
          loginTimeoutTitle: '登录页加载超时',
          loginTimeoutHint: '配置的 MyReels 登录页没有完成加载。请检查 webBaseUrl，或稍后重试。',
          retry: '重试',
          openInBrowser: '在浏览器中打开',
          loginWindowOpened: '登录窗口已打开',
          loginWindowHint: '请在打开的窗口中完成登录，成功后本面板会自动关闭。',
          reopenLoginWindow: '重新打开登录窗口',
          oauthBrowserHint: '微信/扫码登录如果停在成功页，请改为在浏览器中打开完成登录。',
          loggedOutHint: '插件登录态已清除，项目文件未删除。',
          loginAgain: '重新登录',
          pointsUnit: '点',
          refresh: '刷新任务',
          refreshPreview: '刷新资产预览',
          refreshing: '刷新中…',
          loading: '正在读取 run...',
          loadFailed: '读取失败',
          empty: '还没有 run。让智能体用 myreels_run_start 起一单。',
          colRun: '任务',
          colEpisode: '集',
          colStage: '阶段',
          colUpdated: '更新时间',
          colActions: '操作',
          delete: '删除',
          deleteConfirm: '删除这个任务的全部本地内容？不会删除 WebUI 故事台数据。',
          currentProject: '当前项目',
          episodeCountHint: '集数 = 已接入 / 故事台总数；未接入的集仍保留在故事台，需要管理时再单独接入。',
          loadingProject: '正在加载项目设置…',
          detailTitle: '任务详情',
          detailEpisode: '集',
          detailAssets: '有图资产 / 总数',
          detailShots: '已完成视频 / 分镜',
          detailNext: '下一步',
          detailLiveError: '实时查询',
          detailRender: '成片',
          detailSubtitle: '字幕',
          detailLoading: '正在读取详情...',
          save: '保存',
          close: '关闭',
          viewReport: '查看报告',
          reportLoading: '正在读取报告...',
          reportFailed: '报告不可用',
          previewVideo: '预览成片',
          hideVideo: '收起预览',
        });
        const t = ctx.locale.bind('myreels-studio');

        const styles = {
          page: { padding: '24px', paddingBottom: '96px', boxSizing: 'border-box', minHeight: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' },
          header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '18px' },
          title: { margin: 0, fontSize: '20px', fontWeight: 600, letterSpacing: 0 },
          subtitle: { marginTop: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
          userInfo: { display: 'flex', alignItems: 'center', gap: '12px', marginLeft: 'auto', marginRight: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
          userName: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
          quotaWrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
          quotaPanel: { position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50, minWidth: '230px', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-base)', boxShadow: '0 12px 32px rgba(0,0,0,.18)', display: 'flex', flexDirection: 'column', gap: '7px' },
          quotaRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '18px', fontSize: '12px', whiteSpace: 'nowrap' },
          quotaLabel: { color: 'var(--dsw-alias-label-secondary)' },
          quotaValue: { color: 'var(--dsw-alias-label-primary)' },
          quotaValueStrong: { color: 'var(--dsw-alias-brand-primary)', fontWeight: 700 },
          points: { padding: '2px 9px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' },
          button: { padding: '6px 14px', borderRadius: '8px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', cursor: 'pointer' },
          buttonActive: { background: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)', color: '#fff' },
          settings: { marginBottom: '18px', padding: '16px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1)' },
          settingsHead: { marginBottom: '12px' },
          autonomyPanel: { marginBottom: '18px', padding: '16px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1)' },
          autonomyHead: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', marginBottom: '12px' },
          autonomyHint: { marginTop: '4px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
          autonomyList: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px' },
          autonomyItem: { display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '10px 12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '9px', background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer' },
          autonomyText: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 },
          autonomyLabel: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
          autonomyDesc: { fontSize: '11px', lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary)' },
          table: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' },
          rowHead: { display: 'grid', gridTemplateColumns: '90px 1fr 180px 70px', gap: '12px', padding: '10px 16px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)' },
          row: { display: 'grid', gridTemplateColumns: '90px 1fr 180px 70px', gap: '12px', padding: '12px 16px', fontSize: '13px', alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
          episodeRow: { display: 'grid', gridTemplateColumns: '90px 1fr 180px 70px', gap: '12px', padding: '10px 16px', fontSize: '13px', alignItems: 'center', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
          groupHead: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
          groupArrow: { width: '12px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
          groupTitle: { fontWeight: 700, fontSize: '14px', color: 'var(--dsw-alias-label-primary)' },
          groupMeta: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
    tableHint: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
    refreshIconButton: { width: '24px', height: '24px', padding: 0, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', fontSize: '15px', lineHeight: 1, cursor: 'pointer' },
          projectLink: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', fontSize: '12px' },
          projectLinkButton: { border: 0, padding: 0, background: 'transparent', color: 'var(--dsw-alias-brand-primary)', cursor: 'pointer', fontSize: '12px' },
          projectEmbed: { marginTop: '12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px', overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' },
          projectEmbedHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 12px', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
          projectEmbedFrame: { display: 'block', width: '100%', height: 'calc(100vh - 230px)', minHeight: '520px', border: 0, background: '#f7f8fa' },
          authOverlay: { position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,.55)', padding: '24px' },
          authCard: { width: 'min(980px, 96vw)', height: 'min(760px, 90vh)', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base)', borderRadius: '14px', overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,.35)' },
          authHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
          authExternalWait: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '24px' },
          authFrame: { flex: 1, width: '100%', border: 0, background: '#fff' },
          authBody: { flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' },
          authExternalRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
          authExternalHint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
          authLoading: { position: 'absolute', inset: 0, zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', background: 'var(--dsw-alias-bg-base)' },
          authLoadingText: { color: 'var(--dsw-alias-text-secondary)', fontSize: '13px' },
          authError: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '32px', textAlign: 'center' },
          authErrorHint: { color: 'var(--dsw-alias-text-secondary)', lineHeight: 1.7, maxWidth: '520px' },
          authErrorUrl: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', padding: '6px 10px', borderRadius: '6px', background: 'var(--dsw-alias-bg-l2)' },
          authActions: { display: 'flex', gap: '8px', marginTop: '8px' },
          loadingOverlay: { position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', background: 'rgba(247,248,250,.86)', zIndex: 9999, fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
          loadingSpinner: { width: '28px', height: '28px', border: '3px solid var(--dsw-alias-border-l2)', borderTopColor: 'var(--dsw-alias-brand-primary)', borderRadius: '50%', animation: 'myreels-spin .8s linear infinite' },
          colRun: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--dsw-alias-label-secondary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          colEpisode: { color: 'var(--dsw-alias-label-primary)' },
          colStage: { display: 'flex', alignItems: 'center' },
          colTime: { color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' },
          colActions: { color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' },
          dangerButton: { border: '1px solid var(--dsw-alias-state-error-primary)', background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', borderRadius: '6px', padding: '3px 8px', fontSize: '12px', cursor: 'pointer' },
          currentBadge: { flex: '0 0 auto', fontSize: '10px', lineHeight: '16px', color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: '999px', padding: '0 6px', fontWeight: 500 },
          badge: { display: 'inline-block', padding: '2px 8px', borderRadius: '999px', border: '1px solid', fontSize: '12px', lineHeight: '18px' },
          muted: { padding: '24px 0', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px' },
          empty: { padding: '40px 16px', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '12px', fontSize: '13px' },
          error: { padding: '16px', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: '12px', fontSize: '13px' },
          detail: { marginTop: '16px', padding: '16px', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px' },
          detailHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' },
          detailTitle: { fontSize: '14px', fontWeight: 600 },
          detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '10px 24px' },
          detailRow: { display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '13px' },
          detailLabel: { color: 'var(--dsw-alias-label-secondary)', minWidth: '120px' },
          detailValue: { color: 'var(--dsw-alias-label-primary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          reportBox: { marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
          reportPath: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px', wordBreak: 'break-all' },
          reportPre: { margin: 0, padding: '12px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', fontSize: '12px', lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '320px', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' },
          reportError: { marginTop: '12px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
          video: { display: 'block', width: '100%', maxHeight: '420px', marginTop: '14px', borderRadius: '10px', background: 'var(--dsw-alias-bg-base)' },
        };

        const Panel = makePanel(ctx, t, styles);
        const Icon = makeIcon(ctx, styles);

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'myreels',
          order: 40,
          label: () => t('nav'),
        }, Icon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'myreels',
        }, Panel));
      },
    };
  },
});

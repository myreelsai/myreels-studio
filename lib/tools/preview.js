import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_API, configOf } from '../config.js';
import { httpJson, fetchBinary } from '../core/http.js';
import { credentialsOf, loginToken } from '../core/auth.js';
import { readRunState, stateDir } from '../core/state.js';
import { compactNulls } from '../core/util.js';
import { resolveUserFileIdByUrl } from '../story/client.js';
import { layoutOfState, runsRoot } from '../storage/layout.js';

const safe = (value) => String(value || 'x').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50);

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function signedDownload(base, token, userFileId) {
  if (!userFileId) return '';
  const r = await httpJson(`${base}/api/v1/user-files/download/${userFileId}`, { token });
  return typeof r.json?.data === 'string' ? r.json.data : r.json?.data?.url || '';
}

const mapLimit = async (items, limit, worker) => {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next++;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, run));
  return results;
};

const mediaBaseFor = (base) => String(base || '').includes('myreels.tv') ? 'https://image.myreels.tv' : 'https://image.myreels.ai';

const absoluteMediaUrl = (value, base) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${mediaBaseFor(base)}/${raw.replace(/^\/+/, '')}`;
};

const signedMediaUrl = (value, mediaToken, base, { webp = false } = {}) => {
  const absolute = absoluteMediaUrl(value, base);
  if (!absolute) return '';
  try {
    const parsed = new URL(absolute);
    try {
      const mediaHost = new URL(mediaBaseFor(base)).host;
      if (/^image\.myreels\.(?:ai|tv)$/i.test(parsed.hostname)) parsed.host = mediaHost;
    } catch {
      /* keep original host */
    }
    if (webp) parsed.pathname = parsed.pathname.replace(/\.(?:jpe?g|png|gif|bmp|avif)(?=([?#]|$))/i, '.webp');
    if (mediaToken) parsed.searchParams.set('token', mediaToken);
    return parsed.toString();
  } catch {
    return '';
  }
};

const webpDataUrl = (buffer) => `data:image/webp;base64,${Buffer.from(buffer).toString('base64')}`;

async function downloadFile(url, filePath) {
  if (!url) return false;
  const buf = await fetchBinary(url);
  if (!buf) return false;
  writeFileSync(filePath, buf);
  return true;
}

function thumbDataUrl(filePath) {
  try {
    const thumb = `${filePath}.thumb.jpg`;
    execFileSync('ffmpeg', ['-y', '-i', filePath, '-vf', 'scale=560:-1', '-q:v', '5', thumb], { stdio: 'ignore' });
    return `data:image/jpeg;base64,${readFileSync(thumb).toString('base64')}`;
  } catch {
    return '';
  }
}

export default function createTool(config) {
  return defineTool({
    name: 'myreels_preview',
    description: '本地预览（免费）：把资产主图/变体和分镜视频整理成 HTML 画廊，附带资产联系表，不用打开故事台即可检查。',
    parameters: {
      runId: { type: 'string', description: 'run_start 返回的 runId' },
      episodeNo: { type: 'number', description: '只预览某一集（可空=整个项目所有集；60 集项目建议按集生成）' },
      scope: { type: 'string', description: 'assets / shots / all（默认 all）' },
      outDir: { type: 'string', description: '输出目录（可空，默认 <工作区>/myreels-runs/.previews/<runId>）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          runId: { type: 'string' },
          previewPath: { type: 'string' },
          assetsPath: { type: 'string' },
          shotsPath: { type: 'string' },
          previewUrl: { type: 'string' },
          fileUrl: { type: 'string' },
          assetsUrl: { type: 'string' },
          shotsUrl: { type: 'string' },
          assets: { type: 'number' },
          shots: { type: 'number' },
          blockers: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const lines = [`preview ${value.runId}: ${value.ok ? 'ok' : '失败'}`];
        if (value.previewPath) lines.push(`- 预览: ${value.previewPath}`);
        if (value.previewUrl) lines.push(`- 打开: ${value.previewUrl}`);
        if (value.fileUrl) lines.push(`- 本机文件: ${value.fileUrl}`);
        if (value.assetsUrl) lines.push(`- 资产页: ${value.assetsUrl}`);
        if (value.shotsUrl) lines.push(`- 分镜页: ${value.shotsUrl}`);
        for (const b of value.blockers || []) lines.push(`  · ${b}`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, ctx) {
      return buildPreview(ctx, args);
    },
  });
}


export async function buildPreview(config, args) {
      const cfg = configOf(config);
      const base = (cfg.apiBaseUrl || DEFAULT_API).replace(/\/+$/, '');
      const runId = String(args?.runId || '');
      const state = readRunState(runId);
      const blockers = [];
      if (!state) blockers.push(`找不到 state：${runId || '(空)'}`);
      const token = await loginToken(base, credentialsOf(cfg));
      if (!token) blockers.push('登录态无效，请先完成 MyReels SSO 登录');
      const scope = String(args?.scope || 'all');
      let runs = [state].filter(Boolean);
      if (state?.projectId) {
        try {
          const all = readdirSync(stateDir())
            .filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))
            .map((n) => readRunState(n.replace(/\.json$/, '')))
            .filter((s) => s?.projectId === state.projectId && s?.episodeId);
          if (all.length) {
            const seen = new Set();
            runs = all.filter((s) => {
              const key = String(s.episodeId);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }).sort((a, b) => Number(a.episodeNo || 0) - Number(b.episodeNo || 0));
          }
        } catch {
          /* keep current run */
        }
      }
      const requestedEpisode = Number(args?.episodeNo || 0);
      if (requestedEpisode > 0) runs = runs.filter((s) => Number(s.episodeNo) === requestedEpisode);
      let previewEpisodes = runs.map((s) => ({
        episodeNo: Number(s.episodeNo) || 0,
        episodeId: String(s.episodeId || ''),
      })).filter((e) => e.episodeNo > 0 && e.episodeId);
      if (state?.projectId && token) {
        try {
          const er = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/episodes?page=1&limit=200`, { token });
          const items = Array.isArray(er.json?.data?.items) ? er.json.data.items : [];
          if (er.status === 200 && items.length) {
            previewEpisodes = items
              .map((e) => ({ episodeNo: Number(e.episodeNo) || 0, episodeId: String(e.id || e.episodeId || '') }))
              .filter((e) => e.episodeNo > 0 && e.episodeId)
              .sort((a, b) => a.episodeNo - b.episodeNo);
          }
        } catch {
          /* fall back to local runs */
        }
      }
      if (requestedEpisode > 0) previewEpisodes = previewEpisodes.filter((e) => e.episodeNo === requestedEpisode);
      const defaultPreviewDir = join(runsRoot(), '.previews', runId);
  const outDir = String(args?.outDir || defaultPreviewDir);
      const mediaDir = join(outDir, 'media');
      rmSync(mediaDir, { recursive: true, force: true });
      mkdirSync(mediaDir, { recursive: true });
      const localAssetsDirs = [];
      const stateLayout = layoutOfState(state);
      const addAssetsDir = (dir) => {
        if (dir && existsSync(dir) && !localAssetsDirs.includes(dir)) localAssetsDirs.push(dir);
      };
      addAssetsDir(stateLayout?.assetsDir);
      try {
        const projectDir = stateLayout?.projectDir || '';
        for (const name of readdirSync(projectDir)) {
          if (/^ep\d+$/i.test(name)) addAssetsDir(join(projectDir, name, 'assets'));
        }
      } catch {
        /* sibling episode assets are optional */
      }
      const localAssetFiles = [];
      for (const dir of localAssetsDirs) {
        try {
          for (const name of readdirSync(dir)) {
            if (/\.(png|jpe?g|webp)$/i.test(name)) localAssetFiles.push({ dir, name });
          }
        } catch {
          /* ignore unreadable asset dir */
        }
      }
      const findLocalAsset = (...names) => {
        for (const name of names) {
          if (!name) continue;
          const candidate = localAssetFiles.find((file) => file.name === name);
          if (candidate) return join(candidate.dir, candidate.name);
        }
        return '';
      };


      let mediaToken = '';
      if (token) {
        try {
          const tokenRes = await httpJson(`${base}/api/v1/media/url-token`, { token });
          mediaToken = String(tokenRes.json?.data?.token || '');
        } catch {
          mediaToken = '';
        }
      }

      let assetCards = [];
      let shotCards = [];
      if (state && token && !blockers.length && (scope === 'all' || scope === 'assets')) {
        const assetsRes = await httpJson(`${base}/api/v1/story-projects/${state.projectId}/assets?page=1&limit=100`, { token });
        const assetItems = Array.isArray(assetsRes.json?.data?.items) ? assetsRes.json.data.items : [];
        const assetCardsResult = await mapLimit(assetItems, 6, async (asset) => {
          const vs = await httpJson(`${base}/api/v1/story-assets/${asset.id}/variants`, { token });
          const variants = vs.json?.data?.items || [];
          const cards = [];
          const variantCards = [];
          const isCollection = asset.assetType === 'item' || asset.assetType === 'creature';
          if (!isCollection) {
          const localMain = findLocalAsset(`${safe(asset.name)}-main.png`);
          if (localMain) {
            cards.push({ label: '主图', file: '', src: thumbDataUrl(localMain), url: '' });
          } else if (asset.referenceUserFileId || asset.referenceImageUrl) {
            const thumbSource = String(asset.referenceImageUrl || '');
            const thumbUrl = thumbSource ? signedMediaUrl(thumbSource, mediaToken, base, { webp: true }) : '';
            const fullUrl = thumbSource ? signedMediaUrl(thumbSource, mediaToken, base) : '';
            if (thumbUrl) cards.push({ label: '主图', file: '', src: thumbUrl, full: fullUrl, url: '' });
            else if (fullUrl) cards.push({ label: '主图', file: '', src: fullUrl, full: fullUrl, url: '' });
            else if (asset.referenceUserFileId) {
              const mainUrl = await signedDownload(base, token, asset.referenceUserFileId).catch(() => '');
              if (mainUrl) cards.push({ label: '主图', file: '', src: mainUrl, full: mainUrl, url: '' });
            }
          }
          }
          for (const v of variants) {
            if (!v.userFileId && !v.imageUrl && !v.thumbnailUrl) continue;
            const isCandidate =
              String(v.variantType || '').toLowerCase() === 'asset_candidate'
              || String(v.metadata?.displayScope || '').toLowerCase() === 'asset_candidate'
              || String(v.metadata?.source || '') === 'story_workbench_asset_candidate';
            if (isCandidate || !String(v.name || '').trim()) continue;
            const label = isCollection && String(v.variantType || '').toLowerCase() === 'default' ? asset.name : v.name;
            const localVariant = findLocalAsset(
              `${safe(asset.name)}-${safe(v.name)}.png`,
              `fixed-${safe(asset.name)}-${safe(v.name)}.png`
            );
            if (localVariant) {
              variantCards.push({ label, file: '', src: thumbDataUrl(localVariant), url: '' });
              continue;
            }
            const thumbSource = String(v.thumbnailUrl || v.imageUrl || '');
            const thumbUrl = thumbSource ? signedMediaUrl(thumbSource, mediaToken, base, { webp: true }) : '';
            const fullUrl = thumbSource ? signedMediaUrl(thumbSource, mediaToken, base) : '';
            if (thumbUrl) {
              variantCards.push({ label, file: '', src: thumbUrl, full: fullUrl, url: '' });
              continue;
            }
            if (fullUrl) {
              variantCards.push({ label, file: '', src: fullUrl, full: fullUrl, url: '' });
              continue;
            }
            const url = v.userFileId ? await signedDownload(base, token, v.userFileId) : '';
            if (!url) continue;
            variantCards.push({ label, file: '', src: url, full: url, url: '' });
          }
          if (!cards.length && variantCards.length && !isCollection) {
            cards.push({ ...variantCards.shift(), label: '主图' });
          }
          cards.push(...variantCards);
          if (!cards.length) return null;
          return { name: asset.name || '', type: asset.assetType || '', cards };
        });
        assetCards = assetCardsResult.filter(Boolean);
      }

      if (state && token && !blockers.length && (scope === 'all' || scope === 'shots')) {
        const episodeCards = await mapLimit(previewEpisodes, 4, async (episode) => {
          const cards = [];
          const shotsRes = await httpJson(`${base}/api/v1/story-episodes/${episode.episodeId}/shots`, { token }).catch(() => null);
          for (const shot of shotsRes?.json?.data?.items || []) {
            const latest = shot.outputs?.latestVideo || {};
            const userFileId = shot.userFileId || latest.userFileId;
            const title = String(shot.title || '');
            const groupMatch = title.match(/^分镜\s*(\d+)/);
            const groupNo = groupMatch ? groupMatch[1] : String(shot.shotNo);
            const segment = /（下）/.test(title) ? '下' : '上';
            const directUrl = signedMediaUrl(latest.url || shot.url || '', mediaToken, base);
            const url = directUrl || (userFileId ? await signedDownload(base, token, userFileId) : '');
            const poster = signedMediaUrl(latest.thumbnailUrl || shot.thumbnailUrl || '', mediaToken, base, { webp: true });
            cards.push({
              no: shot.shotNo,
              duration: shot.durationSeconds,
              title,
              groupNo,
              segment,
              episodeNo: episode.episodeNo,
              videoUrl: url,
              poster,
              prompt: shot.prompt || '',
            });
          }
          return cards;
        });
        shotCards = episodeCards.flat();
      }

      const typeLabels = { character: '角色', scene: '场景', item: '物品', creature: '生物' };
      const typeOrder = ['character', 'scene', 'item', 'creature'];
      let assetIndex = 0;
      const assetHtml = assetCards.length
        ? typeOrder.map((type) => {
            const group = assetCards.filter((a) => a.type === type);
            if (!group.length) return '';
            return `<h2 id="type-${type}">${typeLabels[type] || type}</h2>` + group.map((a) => {
              assetIndex += 1;
              return `<section id="asset-${assetIndex}"><h2>${esc(a.name)} <small>${esc(a.type)}</small></h2><div class="grid">${a.cards.map((c, cardIndex) => `<figure id="asset-${assetIndex}-card-${cardIndex + 1}"><div class="thumb"><div class="thumb-loading"><span class="spinner"></span><span>图片加载中…</span></div><img src="${esc(c.src || c.file || c.url)}" data-full="${esc(c.full || '')}" loading="lazy" title="点击放大"></div><figcaption>${esc(c.label === '主图' ? a.name : c.label)}</figcaption></figure>`).join('')}</div></section>`;
            }).join('');
          }).join('')
        : '<p class="empty">没有可预览的资产图。</p>';
      const episodeGroups = [];
      for (const s of shotCards) {
        let episode = episodeGroups.find((e) => e.no === s.episodeNo);
        if (!episode) {
          episode = { no: s.episodeNo, storyboards: [] };
          episodeGroups.push(episode);
        }
        let group = episode.storyboards.find((g) => g.no === s.groupNo);
        if (!group) {
          group = { no: s.groupNo, items: [] };
          episode.storyboards.push(group);
        }
        group.items.push(s);
      }
      const shotHtml = episodeGroups.length
        ? episodeGroups.map((ep) => `<h2 id="episode-${esc(ep.no)}">第 ${esc(ep.no)} 集</h2>` + ep.storyboards.map((g) => `<h3 id="storyboard-${esc(ep.no)}-${esc(g.no)}">分镜 ${esc(g.no)}</h3>` + g.items.map((s) => `<section id="shot-${esc(ep.no)}-${esc(s.no)}"><h4>${esc(s.title || `分镜 ${s.no}`)} <small>${esc(s.duration)}s</small></h4><div class="shot">${s.videoUrl ? `<video controls preload="metadata" ${s.poster ? `poster="${esc(s.poster)}"` : ''} src="${esc(s.videoUrl)}"></video>` : '<p class="empty">该分镜还没有视频。</p>'}<details><summary>提示词</summary><pre>${esc(s.prompt)}</pre></details></div></section>`).join('')).join('')).join('')
        : '<p class="empty">没有可预览的分镜。</p>';
      let navIndex = 0;
      const assetNav = typeOrder.map((type) => {
        const group = assetCards.filter((a) => a.type === type);
        if (!group.length) return '';
        const isCollectionNav = type === 'item' || type === 'creature';
        const links = group.map((a) => {
          navIndex += 1;
          if (isCollectionNav) {
            return a.cards.map((c, cardIndex) => `<a href="#asset-${navIndex}-card-${cardIndex + 1}">${esc(c.label)}</a>`).join('');
          }
          const subLinks = a.cards
            .map((c, cardIndex) => c.label === '主图'
              ? ''
              : `<a class="sub" href="#asset-${navIndex}-card-${cardIndex + 1}">${esc(c.label)}</a>`)
            .join('');
          return `<a href="#asset-${navIndex}">${esc(a.name)}</a>${subLinks}`;
        }).join('');
        return `<strong>${typeLabels[type] || type}</strong>${links}`;
      }).join('');
      const shotNav = episodeGroups.map((ep) => `<strong>第 ${esc(ep.no)} 集</strong>` + ep.storyboards.map((g) => `<a class="sub" href="#storyboard-${esc(ep.no)}-${esc(g.no)}">分镜 ${esc(g.no)}</a>`).join('')).join('');

      const css = `body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#f7f8fa;color:#1f2937;margin:0;padding:24px}h1{margin:0 0 8px;font-size:22px}h2{font-size:16px;border-bottom:1px solid #e5e7eb;padding-bottom:8px;margin-top:28px}h3{font-size:15px;margin:22px 0 10px}h4{font-size:13px;color:#374151;margin:10px 0}small{color:#6b7280;font-weight:400}.wrap{display:flex;gap:24px;align-items:flex-start}.side{position:sticky;top:16px;width:200px;flex:0 0 200px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px;max-height:calc(100vh - 32px);overflow:auto}.side strong{display:block;margin:10px 0 6px}.side a{display:block;color:#2563eb;text-decoration:none;font-size:13px;padding:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.side a.sub{padding-left:12px}.side a:hover{text-decoration:underline}main{flex:1;min-width:0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}figure{margin:0;background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.04)}figure .thumb{position:relative;height:220px;background:#f3f4f6}figure .thumb img{width:100%;height:220px;object-fit:contain;background:#f3f4f6;cursor:zoom-in;opacity:0;transition:opacity .15s}figure .thumb.loaded img{opacity:1}figure .thumb-loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#6b7280;font-size:12px;background:#f3f4f6}figure .thumb.loaded .thumb-loading{display:none}figure .thumb.failed .thumb-loading{color:#b91c1c}.spinner{width:24px;height:24px;border:3px solid #dbeafe;border-top-color:#2563eb;border-radius:50%;animation:myreels-spin .8s linear infinite}@keyframes myreels-spin{to{transform:rotate(360deg)}}figcaption{padding:8px;font-size:12px;color:#4b5563}.shot{max-width:520px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.shot video{width:100%;max-height:70vh;background:#000;border-radius:8px}pre{white-space:pre-wrap;font-size:11px;color:#6b7280;max-height:240px;overflow:auto;background:#f9fafb;padding:8px;border-radius:6px}.empty{color:#9ca3af}.lightbox{display:none;position:fixed;inset:0;background:rgba(17,24,39,.85);z-index:9999;align-items:center;justify-content:center;padding:24px}.lightbox img{max-width:96vw;max-height:92vh;object-fit:contain;background:#fff;border-radius:6px;opacity:0;transition:opacity .15s}.lightbox.loaded img{opacity:1}.lightbox-loading{position:absolute;display:flex;flex-direction:column;align-items:center;gap:10px;color:#e5e7eb;font-size:13px;z-index:1}.lightbox.loaded .lightbox-loading{display:none}.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:4px 0 12px;margin:0 0 16px;background:rgba(247,248,250,.96);border-bottom:1px solid #e5e7eb}.tabs{display:flex;gap:6px}.tabs a{padding:6px 15px;border-radius:999px;color:#4b5563;text-decoration:none;font-size:13px;background:#fff;border:1px solid #e5e7eb}.tabs a.active{background:#2563eb;border-color:#2563eb;color:#fff}.sub{font-size:12px;color:#6b7280}`;
      const episodeNos = [...new Set(runs.map((r) => Number(r.episodeNo)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
      const episodeRange = episodeNos.length
        ? (episodeNos[0] === episodeNos[episodeNos.length - 1]
          ? `第${episodeNos[0]}集`
          : `第${episodeNos[0]}–${episodeNos[episodeNos.length - 1]}集 / 共${episodeNos.length}集`)
        : '';
      const projectLabel = String(state?.projectTitle || state?.projectId || '');
      const projectInfo = [projectLabel, episodeRange].filter(Boolean).join(' · ');
      const topbar = (active) => `<div class="topbar"><nav class="tabs"><a class="${active === 'assets' ? 'active' : ''}" href="assets.html">资产</a><a class="${active === 'shots' ? 'active' : ''}" href="shots.html">分镜</a></nav><div class="sub">${esc(projectInfo)}</div></div>`;
      const assetsPath = join(outDir, 'assets.html');
      const shotsPath = join(outDir, 'shots.html');
      const lightboxScript = `<script>document.querySelectorAll('a[href^="#"]').forEach(function(a){a.addEventListener('click',function(e){var id=decodeURIComponent(this.getAttribute('href').slice(1));var el=document.getElementById(id);if(el){e.preventDefault();el.scrollIntoView({block:'start'});}});});document.querySelectorAll('figure .thumb img').forEach(function(img){var thumb=img.closest('.thumb');var label=thumb&&thumb.querySelector('.thumb-loading span:last-child');var loaded=function(){if(thumb){thumb.classList.add('loaded');thumb.classList.remove('failed');}};var failed=function(){if(thumb){thumb.classList.add('failed');thumb.classList.remove('loaded');if(label)label.textContent='图片加载失败';}};if(img.complete){if(img.naturalWidth)loaded();else failed();}img.addEventListener('load',loaded);img.addEventListener('error',failed);img.addEventListener('click',function(){var box=document.getElementById('lightbox');var full=document.getElementById('lightbox-img');var loading=document.getElementById('lightbox-loading');if(!box||!full)return;box.classList.remove('loaded');loading.innerHTML='<span class="spinner"></span><span>正在加载原图…</span>';full.onload=function(){box.classList.add('loaded');};full.onerror=function(){loading.innerHTML='<span>原图加载失败</span>';};full.src=img.dataset.full||img.src;box.style.display='flex';if(full.complete&&full.naturalWidth)box.classList.add('loaded');});});document.getElementById('lightbox').addEventListener('click',function(){this.style.display='none';});</script>`;
      const tabs = `<div class="topbar"><nav class="tabs"><a href="#assets" data-tab="assets" class="active">资产</a><a href="#shots" data-tab="shots">分镜</a></nav><div class="sub">${esc(projectInfo)}</div></div>`;
      const panelScript = `<script>(()=>{const tabs=[...document.querySelectorAll('[data-tab]')];const show=(name)=>{tabs.forEach(t=>t.classList.toggle('active',t.dataset.tab===name));document.getElementById('panel-assets').hidden=name!=='assets';document.getElementById('panel-shots').hidden=name!=='shots';if(history.replaceState)history.replaceState(null,'',name==='shots'?'#shots':'#assets')};tabs.forEach(t=>t.addEventListener('click',e=>{e.preventDefault();show(t.dataset.tab)}));show(location.hash==='#shots'?'shots':'assets')})();</script>`;
      const combined = `<!doctype html><meta charset="utf-8"><meta name="myreels-preview-version" content="2"><title>资产预览</title><style>${css}.panel[hidden]{display:none}</style>${tabs}<div id="panel-assets" class="panel"><div class="wrap"><aside class="side"><strong>资产列表</strong>${assetNav || '<span class="empty">暂无</span>'}</aside><main>${assetHtml}</main></div></div><div id="panel-shots" class="panel" hidden><div class="wrap"><aside class="side"><strong>分镜列表</strong>${shotNav || '<span class="empty">暂无</span>'}</aside><main>${shotHtml}</main></div></div><div id="lightbox" class="lightbox"><div id="lightbox-loading" class="lightbox-loading"><span class="spinner"></span><span>正在加载原图…</span></div><img id="lightbox-img" alt=""></div>${panelScript}${lightboxScript}`;
      writeFileSync(assetsPath, combined);
      writeFileSync(shotsPath, '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=assets.html#shots">');
      rmSync(join(outDir, 'index.html'), { force: true });

      const canServe = outDir === defaultPreviewDir;
      const entryPath = scope === 'shots' ? shotsPath : assetsPath;
      return compactNulls({
        ok: blockers.length === 0,
        runId,
        previewPath: entryPath,
        assetsPath: scope === 'all' || scope === 'assets' ? assetsPath : '',
        shotsPath: scope === 'all' || scope === 'shots' ? shotsPath : '',
        previewUrl: canServe ? `/plugins/myreels-studio/preview/${encodeURIComponent(runId)}/${scope === 'shots' ? 'shots.html' : 'assets.html'}` : '',
        fileUrl: pathToFileURL(entryPath).href,
        assetsUrl: canServe && (scope === 'all' || scope === 'assets') ? `/plugins/myreels-studio/preview/${encodeURIComponent(runId)}/assets.html` : '',
        shotsUrl: canServe && (scope === 'all' || scope === 'shots') ? `/plugins/myreels-studio/preview/${encodeURIComponent(runId)}/shots.html` : '',
        assets: assetCards.length,
        shots: shotCards.length,
        blockers,
      });
}

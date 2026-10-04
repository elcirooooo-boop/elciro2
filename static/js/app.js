/**
 * El Ciro - Plataforma de Fútbol en Vivo
 * JavaScript Frontend Controller
 */

// Estado Global
let state = {
    events: [],
    channels: [],
    currentEvent: null,
    currentFeed: null,
    currentType: null,
    currentChannelId: null,
    currentM3u8: null,
    currentIframe: null,
    hlsPlayer: null,
    viewerId: null,
    activeMatchId: null,
    viewerCounts: {}
};

// Elementos DOM
const elements = {
    clock: document.getElementById('current-clock'),
    title: document.getElementById('current-stream-title'),
    directPlayer: document.getElementById('direct-player'),
    placeholder: document.getElementById('player-placeholder'),
    loader: document.getElementById('player-loader'),
    loaderMsg: document.getElementById('loader-msg'),
    feedSelector: document.getElementById('feed-selector'),
    feedOptions: document.getElementById('feed-options'),
    matchesGrid: document.getElementById('matches-grid'),
    channelsGrid: document.getElementById('channels-grid'),
    matchSearch: document.getElementById('match-search'),
    refreshIcon: document.getElementById('refresh-icon')
};

// ============================================================================
// Inicialización
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
    state.viewerId = getViewerId();
    initClock();
    Promise.all([fetchAgenda(), fetchChannels()]).then(openSharedTarget);
    refreshViewerCounts();

    // Actualizar agenda automáticamente cada 60 segundos
    setInterval(fetchAgenda, 60000);
    setInterval(filterMatches, 30000);
    setInterval(sendViewerHeartbeat, 15000);
    setInterval(refreshViewerCounts, 10000);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) leaveViewedMatch();
        else sendViewerHeartbeat();
    });
    window.addEventListener('pagehide', leaveViewedMatch);
});

function getViewerId() {
    let id = sessionStorage.getItem('el-ciro-viewer-id');
    if (!id) {
        id = window.crypto?.randomUUID?.() || `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        sessionStorage.setItem('el-ciro-viewer-id', id);
    }
    return id;
}

function getMatchId(match) {
    return [match.title || '', match.sport || '', match.time || '']
        .join('|').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9|]+/g, '-').slice(0, 180);
}

async function sendViewerHeartbeat() {
    if (!state.viewerId) return;
    try {
        await fetch('/api/viewers/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewer_id: state.viewerId, match_id: document.hidden ? null : state.activeMatchId })
        });
    } catch (err) {
        console.warn('No se pudo actualizar el contador de espectadores:', err);
    }
}

function leaveViewedMatch() {
    if (!state.viewerId || !state.activeMatchId) return;
    const payload = JSON.stringify({ viewer_id: state.viewerId, match_id: null });
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/viewers/heartbeat', new Blob([payload], { type: 'application/json' }));
    } else {
        fetch('/api/viewers/heartbeat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true
        }).catch(() => {});
    }
}

async function refreshViewerCounts() {
    try {
        const res = await fetch('/api/viewers');
        const data = await res.json();
        state.viewerCounts = data.counts || {};
        document.querySelectorAll('.match-viewer-count').forEach((element) => {
            element.textContent = state.viewerCounts[element.dataset.matchId] || 0;
        });
    } catch (err) {
        console.warn('No se pudieron actualizar los espectadores:', err);
    }
}

// Reloj en tiempo real
function initClock() {
    function update() {
        const now = new Date();
        elements.clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    update();
    setInterval(update, 1000);
}

// ============================================================================
// Carga de Datos desde el Backend
// ============================================================================
async function fetchAgenda() {
    if (elements.refreshIcon) elements.refreshIcon.classList.add('fa-spin');
    try {
        const res = await fetch('/api/agenda');
        const data = await res.json();
        state.events = data.events || [];
        filterMatches();
    } catch (err) {
        console.error('Error al cargar agenda:', err);
        elements.matchesGrid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-exclamation-triangle" style="font-size:2rem; color:var(--warning); margin-bottom:10px;"></i>
                <p>No se pudo conectar con el servidor de la agenda. Reintentando...</p>
            </div>
        `;
    } finally {
        if (elements.refreshIcon) {
            setTimeout(() => elements.refreshIcon.classList.remove('fa-spin'), 600);
        }
    }
}

async function fetchChannels() {
    try {
        const res = await fetch('/api/canales');
        state.channels = await res.json();
        renderChannels(state.channels);
    } catch (err) {
        console.error('Error al cargar canales:', err);
    }
}

// ============================================================================
// Renderizado de Partidos
// ============================================================================
function renderMatches(matches) {
    if (!matches || matches.length === 0) {
        elements.matchesGrid.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-calendar-times" style="font-size:2.5rem; color:var(--text-dim); margin-bottom:12px;"></i>
                <h3>No hay partidos en vivo en este momento</h3>
                <p>Consulta los canales 24/7 o revisa más tarde para los próximos encuentros de la jornada.</p>
            </div>
        `;
        return;
    }

    const now = Date.now();
    const grouped = { live: [], upcoming: [], finished: [] };
    matches.forEach((match) => {
        const kickoff = getKickoffTimestamp(match, now);
        const sourceStatus = String(match.status || match.state || '').toLowerCase();
        const explicitLive = match.is_live === true || /^(live|en vivo|in progress)$/i.test(sourceStatus);
        const explicitlyFinished = /^(finished|final|finalizado|ended|terminado)$/i.test(sourceStatus);
        const status = explicitLive || (!explicitlyFinished && kickoff && kickoff <= now && now - kickoff < 150 * 60 * 1000)
            ? 'live'
            : (explicitlyFinished || (kickoff && kickoff <= now) ? 'finished' : 'upcoming');
        grouped[status].push({ match, kickoff, status });
    });
    grouped.live.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
    grouped.upcoming.sort((a, b) => (a.kickoff || Infinity) - (b.kickoff || Infinity));
    grouped.finished.sort((a, b) => (b.kickoff || 0) - (a.kickoff || 0));

    const groups = [
        ['live', 'En vivo ahora', 'fa-circle-dot'],
        ['upcoming', 'Próximos partidos', 'fa-clock'],
        ['finished', 'Otros partidos', 'fa-calendar-check']
    ].filter(([key]) => grouped[key].length);

    elements.matchesGrid.innerHTML = groups.map(([key, label, icon]) => `
        <h3 class="match-group-heading ${key === 'live' ? 'is-live' : ''}"><i class="fas ${icon}"></i> ${label}<span>${grouped[key].length}</span></h3>
        ${grouped[key].map(({ match, kickoff, status }) => {
        const feeds = match.embeds || [];
        const timeDisplay = kickoff ? new Date(kickoff).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (match.time ? match.time.substring(0, 5) : 'HOY');
        const matchId = getMatchId(match);
        const statusText = status === 'live' ? 'EN VIVO' : (status === 'upcoming' ? 'PRÓXIMO' : 'FINALIZADO');

        return `
            <div class="match-card ${status === 'live' ? 'is-live' : ''}" onclick="playMatchById('${matchId}')">
                <div class="match-top-row">
                    <span class="match-time-badge ${status === 'live' ? 'is-live' : ''}">
                        <i class="fas ${status === 'live' ? 'fa-circle-dot' : 'fa-clock'}"></i> ${statusText} · ${timeDisplay}
                    </span>
                    <span class="match-sport-badge">${match.sport || 'Fútbol'}</span>
                </div>

                <span class="match-viewers"><i class="fas fa-eye"></i> <span class="match-viewer-count" data-match-id="${matchId}">${state.viewerCounts[matchId] || 0}</span> viendo en El Ciro</span>
                
                <h3 class="match-title">${match.title}</h3>

                <div class="match-feeds-row">
                    <div class="match-channel-pills">
                        ${feeds.map(f => `<span class="channel-pill"><i class="fas fa-signal"></i> ${f.name}</span>`).join('')}
                    </div>
                    <button class="play-action-btn">
                        <i class="fas fa-play"></i> Ver
                    </button>
                </div>
            </div>
        `;
    }).join('')}
    `).join('');
}

function getKickoffTimestamp(match, now = Date.now()) {
    const explicitDate = match.start_at || match.startAt || match.datetime || match.kickoff || match.date_time;
    if (explicitDate) {
        const parsed = Date.parse(explicitDate);
        if (Number.isFinite(parsed)) return parsed;
    }
    const time = String(match.time || '').trim();
    const clock = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
    if (!clock) return null;
    let hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (clock[3]) {
        hours = hours % 12 + (/PM/i.test(clock[3]) ? 12 : 0);
    }
    const isoDate = String(match.date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = isoDate
        ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]))
        : (match.date ? new Date(match.date) : new Date(now));
    if (!Number.isFinite(date.getTime())) return null;
    date.setHours(hours, minutes, 0, 0);
    return date.getTime();
}

function playMatchById(matchId) {
    const index = state.events.findIndex((match) => getMatchId(match) === matchId);
    if (index >= 0) playMatch(index);
}

function filterMatches() {
    const query = (elements.matchSearch.value || '').toLowerCase().trim();
    const filtered = !query ? state.events : state.events.filter(m =>
        (m.title && m.title.toLowerCase().includes(query)) ||
        (m.sport && m.sport.toLowerCase().includes(query)) ||
        (m.embeds && m.embeds.some(e => e.name.toLowerCase().includes(query)))
    );
    renderMatches(filtered);
}

// ============================================================================
// Renderizado de Canales 24/7
// ============================================================================
function renderChannels(channels) {
    elements.channelsGrid.innerHTML = channels.map((ch, index) => {
        return `
            <div class="channel-card" onclick="playChannel(${index})">
                <div class="channel-logo-wrapper">
                    <img src="${ch.logo}" alt="${ch.name}" onerror="this.src='https://via.placeholder.com/80/1e293b/00e676?text=${encodeURIComponent(ch.name.substring(0,4))}'">
                </div>
                <h4 class="channel-name">${ch.name}</h4>
                <span class="channel-category">${ch.category}</span>
                <button class="channel-tune-btn">
                    <i class="fas fa-satellite-dish"></i> Sintonizar
                </button>
            </div>
        `;
    }).join('');
}

// ============================================================================
// Reproducción y Control de Streaming
// ============================================================================
function playMatch(index, feedIndex = 0) {
    const event = state.events[index];
    if (!event || !event.embeds || event.embeds.length === 0) return;

    state.currentEvent = event;
    state.currentType = 'match';
    state.currentChannelId = null;
    document.getElementById('btn-share-stream').disabled = false;
    state.activeMatchId = getMatchId(event);
    sendViewerHeartbeat();
    elements.title.textContent = event.title;

    // Renderizar botones de feed / canales alternativos
    if (event.embeds.length > 1) {
        elements.feedSelector.classList.remove('hidden');
        elements.feedOptions.innerHTML = event.embeds.map((emb, i) => `
            <button class="feed-btn ${i === 0 ? 'active' : ''}" onclick="selectFeed(${i})">
                <i class="fas fa-tv"></i> ${emb.name || 'Opción ' + (i+1)}
            </button>
        `).join('');
    } else {
        elements.feedSelector.classList.add('hidden');
    }

    // Reproducir primer feed
    selectFeed(Math.min(feedIndex, event.embeds.length - 1));

    // Desplazar suavemente hacia el reproductor
    document.getElementById('player-section').scrollIntoView({ behavior: 'smooth' });
}

function playChannel(index) {
    const ch = state.channels[index];
    if (!ch) return;

    state.currentEvent = {
        title: ch.name,
        embeds: [{ name: ch.name, iframe: ch.iframe }]
    };
    state.currentType = 'channel';
    state.currentChannelId = ch.id;
    document.getElementById('btn-share-stream').disabled = false;
    state.activeMatchId = null;
    sendViewerHeartbeat();

    elements.title.textContent = ch.name;
    elements.feedSelector.classList.add('hidden');

    selectFeed(0);
    document.getElementById('player-section').scrollIntoView({ behavior: 'smooth' });
}

function selectFeed(feedIndex) {
    if (!state.currentEvent || !state.currentEvent.embeds) return;
    const feed = state.currentEvent.embeds[feedIndex];
    if (!feed) return;

    state.currentFeed = feed;
    state.currentIframe = feed.iframe;

    // Actualizar botones de feed activos
    const buttons = elements.feedOptions.querySelectorAll('.feed-btn');
    buttons.forEach((btn, i) => {
        btn.classList.toggle('active', i === feedIndex);
    });

    loadStream(feed.iframe);
    updateShareAddress(feedIndex);
}

function updateShareAddress(feedIndex = 0) {
    if (!state.currentEvent) return;
    const url = new URL(window.location.href);
    url.search = '';
    if (state.currentType === 'channel' && state.currentChannelId) {
        url.searchParams.set('channel', state.currentChannelId);
    } else {
        url.searchParams.set('match', getMatchId(state.currentEvent));
        url.searchParams.set('feed', String(feedIndex));
    }
    url.hash = 'player-section';
    history.replaceState({}, '', url);
}

async function shareCurrent() {
    if (!state.currentEvent) return;
    updateShareAddress(state.currentEvent.embeds.indexOf(state.currentFeed));
    const shareUrl = window.location.href;
    const button = document.getElementById('btn-share-stream');
    try {
        if (navigator.share) {
            await navigator.share({ title: `El Ciro · ${state.currentEvent.title}`, url: shareUrl });
        } else {
            await navigator.clipboard.writeText(shareUrl);
            button.innerHTML = '<i class="fas fa-check"></i> Enlace copiado';
            setTimeout(() => { button.innerHTML = '<i class="fas fa-share-nodes"></i> Compartir'; }, 2200);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            window.prompt('Copia este enlace para compartir el partido:', shareUrl);
        }
    }
}

function openSharedTarget() {
    const params = new URLSearchParams(window.location.search);
    const channelId = params.get('channel');
    if (channelId) {
        const index = state.channels.findIndex((channel) => channel.id === channelId);
        if (index >= 0) playChannel(index);
        return;
    }
    const matchId = params.get('match');
    if (matchId) {
        const index = state.events.findIndex((match) => getMatchId(match) === matchId);
        if (index >= 0) playMatch(index, Math.max(0, Number(params.get('feed')) || 0));
    }
}

// Cargar transmisión según el modo seleccionado
async function loadStream(iframeUrl, forceRefresh = false) {
    if (!iframeUrl) return;

    // Ocultar placeholder
    elements.placeholder.classList.add('hidden');

    await renderDirectHls(iframeUrl, forceRefresh);
}

// Modo Directo HLS con Token
async function renderDirectHls(iframeUrl, forceRefresh = false) {
    showLoader("Extrayendo token fresco y señal HD...");
    elements.directPlayer.classList.remove('hidden');

    try {
        const url = `/api/resolve?iframe=${encodeURIComponent(iframeUrl)}${forceRefresh ? '&force=true' : ''}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.success && data.m3u8) {
            state.currentM3u8 = data.m3u8;
            initClapprPlayer(data.m3u8);
        } else {
            showStreamError(data.error || "No se pudo obtener una señal directa. Intenta recargar el token.");
        }
    } catch (err) {
        console.error("Error al resolver m3u8:", err);
        showStreamError("No se pudo conectar con la señal. Comprueba tu conexión e inténtalo de nuevo.");
    } finally {
        hideLoader();
    }
}

// Reproducir HLS directamente con HLS.js; usar HLS nativo cuando exista.
function initClapprPlayer(m3u8Url) {
    destroyClappr();
    elements.directPlayer.innerHTML = `<video id="native-video" controls autoplay playsinline style="width:100%;height:100%;object-fit:contain;background:#000;"></video>`;
    const video = document.getElementById('native-video');

    if (window.Hls && Hls.isSupported()) {
        state.hlsPlayer = new Hls({
            enableWorker: true,
            liveSyncDurationCount: 3
        });
        state.hlsPlayer.loadSource(m3u8Url);
        state.hlsPlayer.attachMedia(video);
        state.hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        state.hlsPlayer.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            console.error('Error fatal de HLS:', data.type, data.details);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                showStreamError('No se pudo cargar la señal desde el servidor. Pulsa «Recargar Token» para volver a intentarlo.');
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                state.hlsPlayer.recoverMediaError();
            } else {
                destroyClappr();
                showStreamError('No se pudo reproducir esta transmisión. Intenta recargar el token.');
            }
        });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = m3u8Url;
        video.play().catch(() => {});
    } else {
        showStreamError('Este navegador no ofrece reproducción HLS. Prueba con Chrome, Edge o Safari actualizados.');
    }
}

function destroyClappr() {
    if (state.hlsPlayer) {
        try {
            state.hlsPlayer.destroy();
        } catch (e) {}
        state.hlsPlayer = null;
    }
    elements.directPlayer.innerHTML = "";
}

// Recargar señal y forzar actualización del token
function reloadCurrentStream() {
    if (!state.currentIframe) return;
    const btn = document.getElementById('btn-refresh-stream');
    if (btn) btn.classList.add('loading');

    loadStream(state.currentIframe, true).finally(() => {
        if (btn) btn.classList.remove('loading');
    });
}

function showLoader(msg = "Cargando...") {
    elements.loaderMsg.textContent = msg;
    elements.loader.classList.remove('hidden');
}

function hideLoader() {
    elements.loader.classList.add('hidden');
}

function showStreamError(message) {
    destroyClappr();
    elements.directPlayer.classList.add('hidden');
    elements.placeholder.classList.remove('hidden');
    elements.placeholder.querySelector('h3').textContent = "Señal no disponible";
    elements.placeholder.querySelector('p').textContent = message;
}

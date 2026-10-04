import os
import re
import json
import time
import urllib.request
import ssl
from threading import Lock
from flask import Flask, render_template, jsonify, request, Response

app = Flask(__name__)

# SSL context para evitar problemas de certificados con servidores de streaming
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://tarjetarojatv.mobi/'
}

# Cache para almacenar tokens resueltos y evitar saturar los servidores
CACHE = {
    'agenda': None,
    'agenda_timestamp': 0,
    'streams': {} # iframe_url: {'url': m3u8_url, 'expires': timestamp}
}

# Sesiones activas en este servidor; se eliminan si dejan de enviar heartbeat.
VIEWER_LOCK = Lock()
ACTIVE_VIEWERS = {}
VIEWER_TIMEOUT_SECONDS = 45

CANALES_FIJOS = [
    {
        'id': 'espn-1',
        'name': 'ESPN 1 México',
        'category': 'Deportes',
        'logo': 'https://img.agenda18.com/uploads/espn_8e4e892b15.png',
        'stream_id': 'espnmx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=espnmx'
    },
    {
        'id': 'espn-2',
        'name': 'ESPN 2 México',
        'category': 'Deportes',
        'logo': 'https://img.agenda18.com/uploads/espn2_649f80f1e0.png',
        'stream_id': 'espn2mx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=espn2mx'
    },
    {
        'id': 'espn-3',
        'name': 'ESPN 3 México',
        'category': 'Deportes',
        'logo': 'https://img.agenda18.com/uploads/espn3_24d45d3ae3.png',
        'stream_id': 'espn3mx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=espn3mx'
    },
    {
        'id': 'fox-sports-1',
        'name': 'FOX Sports 1 México',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/foxsports_3306db41fc.png',
        'stream_id': 'foxsportsmx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=foxsportsmx'
    },
    {
        'id': 'fox-sports-2',
        'name': 'FOX Sports 2 México',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/foxsports2_803362a1fc.png',
        'stream_id': 'foxsports2mx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=foxsports2mx'
    },
    {
        'id': 'fox-sports-3',
        'name': 'FOX Sports 3 México',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/foxsports3_403362a1fc.png',
        'stream_id': 'foxsports3mx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=foxsports3mx'
    },
    {
        'id': 'fox-sports-premium',
        'name': 'FOX Sports Premium',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/foxsportspremium_472b83d1c4.png',
        'stream_id': 'foxsportspremium',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=foxsportspremium'
    },
    {
        'id': 'tudn-mx',
        'name': 'TUDN México',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/tudn_fa3c28df31.png',
        'stream_id': 'tudn_mx',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=tudn_mx'
    },
    {
        'id': 'espn-premium-ar',
        'name': 'ESPN Premium Argentina',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/espnpremium_278a9c3b7a.png',
        'stream_id': 'espnpremium',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=espnpremium'
    },
    {
        'id': 'tnt-sports-ar',
        'name': 'TNT Sports Argentina',
        'category': 'Fútbol',
        'logo': 'https://img.agenda18.com/uploads/tntsports_981a8b2c12.png',
        'stream_id': 'tntsports',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=tntsports'
    },
    {
        'id': 'tyc-sports',
        'name': 'TyC Sports Argentina',
        'category': 'Deportes',
        'logo': 'https://img.agenda18.com/uploads/tycsports_11029abce3.png',
        'stream_id': 'tycsports',
        'iframe': 'https://la18hd.su/vivo/canal.php?stream=tycsports'
    }
]

def resolver_m3u8(iframe_url, forzar_recarga=False):
    """
    Entra a la página del reproductor iframe (ej. la18hd.su)
    y extrae la URL directa del stream .m3u8 con el token fresco.
    """
    ahora = time.time()
    if not forzar_recarga and iframe_url in CACHE['streams']:
        cached = CACHE['streams'][iframe_url]
        if ahora < cached['expires']:
            return cached['url']

    try:
        req = urllib.request.Request(iframe_url, headers=HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=6) as resp:
            html = resp.read().decode('utf-8', errors='ignore')

            # Buscar la asignación de playbackURL
            m = re.search(r'playbackURL\s*=\s*["\']([^"\']+)["\']', html)
            if not m:
                # Patrones alternativos que suelen usar los players
                m = re.search(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html) or \
                    re.search(r'source:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html) or \
                    re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', html)

            if m:
                m3u8_url = m.group(1).replace(r'\/', '/')
                # Los tokens duran unas horas, guardamos en cache por 10 minutos
                CACHE['streams'][iframe_url] = {
                    'url': m3u8_url,
                    'expires': ahora + 600
                }
                return m3u8_url
    except Exception as e:
        print(f"[ERROR] Error al resolver iframe {iframe_url}: {e}")

    return None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/agenda')
def get_agenda():
    ahora = time.time()
    # Cachear agenda por 30 segundos
    if CACHE['agenda'] and (ahora - CACHE['agenda_timestamp']) < 30:
        return jsonify(CACHE['agenda'])

    try:
        req = urllib.request.Request('https://tarjetarojatv.mobi/api/agenda', headers=HEADERS)
        with urllib.request.urlopen(req, context=SSL_CTX, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            events = data.get('events', [])
            
            # Formatear y enriquecer eventos
            for ev in events:
                for emb in ev.get('embeds', []):
                    iframe_url = emb.get('iframe')
                    # Adjuntar si ya está en caché
                    if iframe_url and iframe_url in CACHE['streams']:
                        emb['m3u8'] = CACHE['streams'][iframe_url]['url']

            CACHE['agenda'] = {'events': events}
            CACHE['agenda_timestamp'] = ahora
            return jsonify(CACHE['agenda'])
    except Exception as e:
        print(f"[ERROR] Error al consultar agenda: {e}")
        if CACHE['agenda']:
            return jsonify(CACHE['agenda'])
        return jsonify({'events': [], 'error': str(e)}), 500

@app.route('/api/canales')
def get_canales():
    return jsonify(CANALES_FIJOS)

@app.route('/api/viewers/heartbeat', methods=['POST'])
def viewer_heartbeat():
    payload = request.get_json(silent=True) or {}
    viewer_id = payload.get('viewer_id')
    match_id = payload.get('match_id')

    if not isinstance(viewer_id, str) or not viewer_id or len(viewer_id) > 128:
        return jsonify({'error': 'viewer_id inválido'}), 400
    if match_id is not None and (not isinstance(match_id, str) or not match_id or len(match_id) > 180):
        return jsonify({'error': 'match_id inválido'}), 400

    now = time.time()
    with VIEWER_LOCK:
        for session_id, viewer in list(ACTIVE_VIEWERS.items()):
            if now - viewer['last_seen'] > VIEWER_TIMEOUT_SECONDS:
                del ACTIVE_VIEWERS[session_id]
        if match_id is None:
            ACTIVE_VIEWERS.pop(viewer_id, None)
        else:
            ACTIVE_VIEWERS[viewer_id] = {'match_id': match_id, 'last_seen': now}
    return jsonify({'ok': True})

@app.route('/api/viewers')
def get_viewer_counts():
    now = time.time()
    counts = {}
    with VIEWER_LOCK:
        for session_id, viewer in list(ACTIVE_VIEWERS.items()):
            if now - viewer['last_seen'] > VIEWER_TIMEOUT_SECONDS:
                del ACTIVE_VIEWERS[session_id]
                continue
            match_id = viewer['match_id']
            counts[match_id] = counts.get(match_id, 0) + 1
    return jsonify({'counts': counts})

@app.route('/api/resolve', methods=['GET', 'POST'])
def resolve_stream():
    """
    Resuelve el token fresco para un iframe dado.
    Parámetro GET o JSON: ?iframe=https://...
    """
    iframe_url = request.args.get('iframe')
    if not iframe_url and request.is_json:
        iframe_url = request.json.get('iframe')

    if not iframe_url:
        return jsonify({'error': 'Parámetro iframe es requerido'}), 400

    forzar = request.args.get('force', 'false').lower() == 'true'
    m3u8_url = resolver_m3u8(iframe_url, forzar_recarga=forzar)

    if m3u8_url:
        return jsonify({
            'success': True,
            'iframe': iframe_url,
            'm3u8': m3u8_url
        })
    else:
        return jsonify({
            'success': False,
            'iframe': iframe_url,
            'error': 'No se pudo extraer el enlace directo m3u8, utilice el modo iframe'
        }), 404

if __name__ == '__main__':
    import sys
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    port = int(os.environ.get('PORT', 5000))
    print("==================================================")
    print("      EL CIRO - PLATAFORMA DE FUTBOL EN VIVO      ")
    print("==================================================")
    print(f" Servidor iniciado en http://localhost:{port}")
    print(" Abre tu navegador para disfrutar de los partidos!")
    print("==================================================")
    app.run(host='0.0.0.0', port=port, debug=False)
